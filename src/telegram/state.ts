import type { Database } from 'bun:sqlite'
import type { Effort, ExecMode } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL DEFAULT '',
  folder TEXT,
  plan INTEGER NOT NULL,
  review INTEGER NOT NULL,
  exec_mode TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  new_chat INTEGER NOT NULL DEFAULT 0,
  isolate INTEGER NOT NULL DEFAULT 0,
  takeover INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  follow_job INTEGER,
  browse TEXT,
  message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  job_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS tg_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  html TEXT NOT NULL,
  keyboard TEXT,
  created_at INTEGER NOT NULL
);
`

/** The choices a task is queued with; the last ones you used prefill the next draft. */
export interface Choices {
  folder: string | null
  plan: boolean
  review: boolean
  execMode: ExecMode
  model: string
  /** With a plan: the model that carries it out (null: `model` does both). */
  workModel: string | null
  effort: Effort
  /** With a plan: the effort that carries it out (null: `effort` does both). */
  workEffort: Effort | null
  /** Run a new conversation on its own git branch. */
  isolate: boolean
}

/** A prompt waiting for you to tap Queue, with everything picked so far. */
export interface Draft extends Choices {
  id: number
  prompt: string
  /** Start a new conversation instead of continuing the folder's last one. */
  newChat: boolean
  /** Follow-up: continue exactly this conversation. */
  sessionId: string | null
  /** That conversation is open in another Claude window: close it there when the job starts. */
  takeover: boolean
  followJob: number | null
  /** End with a live link (a claude.ai artifact). */
  wantLink: boolean
  /** Starts: not before this time (ms). */
  notBefore: number | null
  /** Starts: again every day at this time, in minutes after midnight. */
  repeatDaily: number | null
  /** Starts: when the 5-hour limit resets. */
  atReset: boolean
  /** Starts: only after this task has finished well. */
  afterJob: number | null
  /** Starts next, before everything waiting. */
  front: boolean
  /** Stop it after this many minutes of work. */
  maxMinutes: number | null
  /** Three ways: three tasks, each on its own branch: one per model, or the chosen model three times. */
  threeWays: 'models' | 'same' | null
  /** Files saved on the machine for Claude to read. */
  attachments: string[]
  /** Change: the card edits this queued task instead of queueing a new one. */
  editJob: number | null
  /** Folder the browser is showing. */
  browse: string | null
  /** What the card has open: a tab, and where in it ("model:work", "folder:browse:1"…); null: none. */
  view: string | null
  messageId: number | null
  status: 'open' | 'queued' | 'discarded'
  jobId: number | null
  createdAt: number
}

type Row = Record<string, string | number | null>
type SqlValue = string | number | null

const COLUMNS: Record<keyof Draft, string> = {
  id: 'id',
  prompt: 'prompt',
  folder: 'folder',
  plan: 'plan',
  review: 'review',
  execMode: 'exec_mode',
  model: 'model',
  workModel: 'work_model',
  effort: 'effort',
  workEffort: 'work_effort',
  isolate: 'isolate',
  newChat: 'new_chat',
  sessionId: 'session_id',
  takeover: 'takeover',
  followJob: 'follow_job',
  wantLink: 'want_link',
  notBefore: 'not_before',
  repeatDaily: 'repeat_daily',
  atReset: 'at_reset',
  afterJob: 'after_job',
  front: 'front',
  maxMinutes: 'max_minutes',
  threeWays: 'three_ways',
  attachments: 'attachments',
  editJob: 'edit_job',
  browse: 'browse',
  view: 'view',
  messageId: 'message_id',
  status: 'status',
  jobId: 'job_id',
  createdAt: 'created_at',
}
const BOOLEANS = new Set<keyof Draft>(['plan', 'review', 'newChat', 'isolate', 'takeover', 'wantLink', 'atReset', 'front'])

function toDraft(row: Row): Draft {
  const d = {} as Record<string, unknown>
  for (const [key, column] of Object.entries(COLUMNS) as [keyof Draft, string][]) {
    const value = row[column] ?? null
    d[key] = key === 'attachments' ? (typeof value === 'string' ? (JSON.parse(value) as string[]) : []) : BOOLEANS.has(key) ? value === 1 : value
  }
  return d as unknown as Draft
}

function encode(key: keyof Draft, value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (BOOLEANS.has(key)) return value ? 1 : 0
  if (key === 'attachments') return (value as string[]).length > 0 ? JSON.stringify(value) : null
  return value as SqlValue
}

export class TelegramState {
  constructor(private db: Database) {
    db.exec(SCHEMA)
    // Columns added after the first release.
    const have = new Set(db.query<{ name: string }, []>('PRAGMA table_info(tg_drafts)').all().map(c => c.name))
    for (const column of ['isolate', 'takeover', 'want_link']) {
      if (!have.has(column)) db.exec(`ALTER TABLE tg_drafts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    }
    if (!have.has('work_model')) db.exec('ALTER TABLE tg_drafts ADD COLUMN work_model TEXT')
    for (const column of ['not_before', 'edit_job', 'repeat_daily', 'after_job', 'max_minutes']) if (!have.has(column)) db.exec(`ALTER TABLE tg_drafts ADD COLUMN ${column} INTEGER`)
    for (const column of ['at_reset', 'front']) if (!have.has(column)) db.exec(`ALTER TABLE tg_drafts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    for (const column of ['work_effort', 'three_ways', 'attachments', 'view']) if (!have.has(column)) db.exec(`ALTER TABLE tg_drafts ADD COLUMN ${column} TEXT`)
  }

  addDraft(
    fields: Choices & { prompt: string; newChat?: boolean; sessionId?: string | null; takeover?: boolean; followJob?: number | null },
    now: number,
  ): Draft {
    const row = this.db
      .query<Row, SqlValue[]>(
        `INSERT INTO tg_drafts (prompt, folder, plan, review, exec_mode, model, work_model, effort, work_effort, isolate, new_chat, session_id, takeover, follow_job, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        fields.prompt,
        fields.folder,
        fields.plan ? 1 : 0,
        fields.review ? 1 : 0,
        fields.execMode,
        fields.model,
        fields.workModel ?? null,
        fields.effort,
        fields.workEffort ?? null,
        fields.isolate ? 1 : 0,
        fields.newChat ? 1 : 0,
        fields.sessionId ?? null,
        fields.takeover ? 1 : 0,
        fields.followJob ?? null,
        now,
      )
    if (!row) throw new Error('failed to save draft')
    return toDraft(row)
  }

  /** The newest card still waiting for Queue, for a photo or file sent after it. */
  latestOpenDraft(since: number): Draft | null {
    const row = this.db.query<Row, [number]>(`SELECT * FROM tg_drafts WHERE status = 'open' AND edit_job IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(since)
    return row ? toDraft(row) : null
  }

  getDraft(id: number): Draft | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM tg_drafts WHERE id = ?').get(id)
    return row ? toDraft(row) : null
  }

  updateDraft(id: number, patch: Partial<Draft>): Draft {
    const keys = (Object.keys(patch) as (keyof Draft)[]).filter(k => k !== 'id')
    if (keys.length > 0) {
      const sets = keys.map(k => `${COLUMNS[k]} = ?`).join(', ')
      this.db.query<Row, SqlValue[]>(`UPDATE tg_drafts SET ${sets} WHERE id = ?`).run(...keys.map(k => encode(k, patch[k])), id)
    }
    const draft = this.getDraft(id)
    if (!draft) throw new Error(`draft ${id} not found`)
    return draft
  }

  /** A short stable number for a folder, so button data stays under Telegram's 64 bytes. */
  folderId(path: string): number {
    this.db.query<Row, [string]>('INSERT OR IGNORE INTO tg_folders (path) VALUES (?)').run(path)
    return this.db.query<{ id: number }, [string]>('SELECT id FROM tg_folders WHERE path = ?').get(path)!.id
  }

  /** A message that couldn't be sent (Telegram unreachable), kept to send later in order. */
  addOutbox(html: string, keyboard: unknown, now: number): void {
    this.db
      .query<Row, SqlValue[]>('INSERT INTO tg_outbox (html, keyboard, created_at) VALUES (?, ?, ?)')
      .run(html, keyboard ? JSON.stringify(keyboard) : null, now)
  }

  outbox(): { id: number; html: string; keyboard: unknown; createdAt: number }[] {
    return this.db
      .query<{ id: number; html: string; keyboard: string | null; created_at: number }, []>('SELECT * FROM tg_outbox ORDER BY id')
      .all()
      .map(r => ({ id: r.id, html: r.html, keyboard: r.keyboard ? JSON.parse(r.keyboard) : undefined, createdAt: r.created_at }))
  }

  deleteOutbox(id: number): void {
    this.db.query<Row, [number]>('DELETE FROM tg_outbox WHERE id = ?').run(id)
  }

  pruneOutbox(olderThan: number): void {
    this.db.query<Row, [number]>('DELETE FROM tg_outbox WHERE created_at < ?').run(olderThan)
  }

  folderPath(id: number): string | null {
    return this.db.query<{ path: string }, [number]>('SELECT path FROM tg_folders WHERE id = ?').get(id)?.path ?? null
  }
}
