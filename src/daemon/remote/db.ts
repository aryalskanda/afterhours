// Remote access state, in the daemon's database: the devices allowed to control this machine,
// the event log apps catch up from, requests already carried out (so a retry is answered, not
// repeated), an audit trail of everything apps did, and where to push to.

import type { Database } from 'bun:sqlite'
import type { PushPrefs, Result, Role } from '@afterhours/protocol'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  role TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS remote_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  notice TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_requests (
  device TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (device, id)
);
CREATE TABLE IF NOT EXISTS remote_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  device TEXT,
  device_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_audit_at ON remote_audit (at);
CREATE TABLE IF NOT EXISTS remote_push (
  device TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  prefs TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export interface DeviceRow {
  id: string
  name: string
  platform: string
  role: Role
  addedAt: number
  /** "pairing" (cq pair), or the name of the device that added it. */
  addedBy: string
  lastSeen: number | null
  revokedAt: number | null
}

export interface AuditEntry {
  at: number
  device: string | null
  deviceName: string | null
  action: string
  detail: string | null
  ok: boolean
}

export interface StoredEvent {
  seq: number
  at: number
  notice: string
  text: string
}

interface DeviceDbRow {
  id: string
  name: string
  platform: string
  role: Role
  added_at: number
  added_by: string
  last_seen: number | null
  revoked_at: number | null
}

const toDevice = (r: DeviceDbRow): DeviceRow => ({
  id: r.id,
  name: r.name,
  platform: r.platform,
  role: r.role,
  addedAt: r.added_at,
  addedBy: r.added_by,
  lastSeen: r.last_seen,
  revokedAt: r.revoked_at,
})

export class RemoteDb {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
  }

  // --- devices ------------------------------------------------------------------------------

  /** Adds a device, or lets a removed one back in with its new name and role. */
  addDevice(d: { id: string; name: string; platform: string; role: Role; addedBy: string }, now: number): DeviceRow {
    this.db
      .query(
        `INSERT INTO remote_devices (id, name, platform, role, added_at, added_by, last_seen, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform, role = excluded.role,
           added_at = excluded.added_at, added_by = excluded.added_by, revoked_at = NULL`,
      )
      .run(d.id, d.name, d.platform, d.role, now, d.addedBy)
    return this.device(d.id)!
  }

  device(id: string): DeviceRow | null {
    const row = this.db.query<DeviceDbRow, [string]>('SELECT * FROM remote_devices WHERE id = ?').get(id)
    return row ? toDevice(row) : null
  }

  /** Devices allowed now (with `revoked`, removed ones too), most recently added first. */
  devices(o: { revoked?: boolean } = {}): DeviceRow[] {
    const where = o.revoked ? '' : 'WHERE revoked_at IS NULL'
    return this.db.query<DeviceDbRow, []>(`SELECT * FROM remote_devices ${where} ORDER BY added_at DESC`).all().map(toDevice)
  }

  activeIds(): string[] {
    return this.db.query<{ id: string }, []>('SELECT id FROM remote_devices WHERE revoked_at IS NULL').all().map(r => r.id)
  }

  rename(id: string, name: string): boolean {
    return this.db.query('UPDATE remote_devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(name, id).changes > 0
  }

  /** Cuts a device off; it gets no more pushes either. */
  revoke(id: string, now: number): boolean {
    this.db.query('DELETE FROM remote_push WHERE device = ?').run(id)
    return this.db.query('UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes > 0
  }

  touch(id: string, now: number): void {
    this.db.query('UPDATE remote_devices SET last_seen = ? WHERE id = ?').run(now, id)
  }

  // --- push ---------------------------------------------------------------------------------

  /** A device's push token and what it wants pushed; null stops its pushes. A token belongs to one device. */
  setPush(device: string, push: { token: string; prefs: PushPrefs } | null, now: number): void {
    this.db.query('DELETE FROM remote_push WHERE device = ?').run(device)
    if (!push) return
    this.db.query('DELETE FROM remote_push WHERE token = ?').run(push.token)
    this.db.query('INSERT INTO remote_push (device, token, prefs, updated_at) VALUES (?, ?, ?, ?)').run(device, push.token, JSON.stringify(push.prefs), now)
  }

  /** Where to push: devices still allowed, with their tokens and choices. */
  pushTargets(): { device: string; token: string; prefs: PushPrefs }[] {
    return this.db
      .query<{ device: string; token: string; prefs: string }, []>(
        'SELECT p.device, p.token, p.prefs FROM remote_push p JOIN remote_devices d ON d.id = p.device WHERE d.revoked_at IS NULL',
      )
      .all()
      .map(r => ({ device: r.device, token: r.token, prefs: JSON.parse(r.prefs) as PushPrefs }))
  }

  /** A token Expo says is no longer valid. */
  dropPushToken(token: string): void {
    this.db.query('DELETE FROM remote_push WHERE token = ?').run(token)
  }

  // --- events -------------------------------------------------------------------------------

  addEvent(at: number, notice: string, text: string): number {
    return Number(this.db.query('INSERT INTO remote_events (at, notice, text) VALUES (?, ?, ?)').run(at, notice, text).lastInsertRowid)
  }

  /** The newest `limit` events after `seq`, oldest first: after a long absence, what's recent matters. */
  eventsAfter(seq: number, limit: number): StoredEvent[] {
    return this.db
      .query<StoredEvent, [number, number]>(
        'SELECT * FROM (SELECT seq, at, notice, text FROM remote_events WHERE seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq',
      )
      .all(seq, limit)
  }

  /** Everything said about one task, oldest first (events are kept 14 days). */
  eventsForJob(job: number, limit = 300): StoredEvent[] {
    return this.db
      .query<StoredEvent, [number, number, number]>(
        `SELECT seq, at, notice, text FROM remote_events
         WHERE json_extract(notice, '$.job.id') = ? OR (json_extract(notice, '$.type') = 'resolved' AND json_extract(notice, '$.job') = ?)
         ORDER BY seq LIMIT ?`,
      )
      .all(job, job, limit)
  }

  lastSeq(): number {
    return this.db.query<{ seq: number | null }, []>('SELECT MAX(seq) AS seq FROM remote_events').get()?.seq ?? 0
  }

  // --- requests already carried out ---------------------------------------------------------

  handled(device: string, id: string): Result | null {
    const row = this.db.query<{ result: string }, [string, string]>('SELECT result FROM remote_requests WHERE device = ? AND id = ?').get(device, id)
    return row ? (JSON.parse(row.result) as Result) : null
  }

  remember(device: string, id: string, result: Result, now: number): void {
    this.db.query('INSERT OR REPLACE INTO remote_requests (device, id, at, result) VALUES (?, ?, ?, ?)').run(device, id, now, JSON.stringify(result))
  }

  // --- audit --------------------------------------------------------------------------------

  audit(e: AuditEntry): void {
    this.db
      .query('INSERT INTO remote_audit (at, device, device_name, action, detail, ok) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.at, e.device, e.deviceName, e.action, e.detail, e.ok ? 1 : 0)
  }

  auditLog(limit: number): AuditEntry[] {
    return this.db
      .query<{ at: number; device: string | null; device_name: string | null; action: string; detail: string | null; ok: number }, [number]>(
        'SELECT at, device, device_name, action, detail, ok FROM remote_audit ORDER BY id DESC LIMIT ?',
      )
      .all(limit)
      .map(r => ({ at: r.at, device: r.device, deviceName: r.device_name, action: r.action, detail: r.detail, ok: r.ok === 1 }))
  }

  /** Events are kept 14 days, handled requests 1 day, the audit trail 90 days. */
  prune(now: number): void {
    this.db.query('DELETE FROM remote_events WHERE at < ?').run(now - 14 * 24 * 3600_000)
    this.db.query('DELETE FROM remote_requests WHERE at < ?').run(now - 24 * 3600_000)
    this.db.query('DELETE FROM remote_audit WHERE at < ?').run(now - 90 * 24 * 3600_000)
  }
}
