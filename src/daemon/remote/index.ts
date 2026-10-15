// Remote access from the Afterhours apps: this machine connects out to a relay, apps pair with it
// (cq pair), and everything between them is end-to-end encrypted (packages/protocol). Turned on
// by `cq pair`; config.json's `remote` section holds the relay and this machine's rules.

import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import {
  decodeIdentity,
  encodeIdentity,
  fingerprint,
  Host,
  newIdentity,
  peerId,
  PROTOCOL,
  type Identity,
  type MachineInfo,
  type OfferView,
  type Role,
  type SocketFactory,
} from '@afterhours/protocol'
import { paths, writeFileAtomic, type Config } from '../../shared/config'
import type { JobSpec } from '../../shared/types'
import type { ChatSource } from '../chats'
import type { FolderMap } from '../folders'
import type { Notice } from '../notify'
import type { Runner, ToolActivity } from '../runner'
import type { Store } from '../store'
import { RemoteDb, type AuditEntry } from './db'
import { Feed } from './feed'
import { publicDevice, Router, type RouterDeps } from './router'

export interface RemoteDeps {
  store: Store
  runner: Runner
  chats: ChatSource
  folders: FolderMap
  config: () => Config
  command: (text: string, guard: (spec: JobSpec) => string | null) => Promise<string | null>
  version: string
  log: (line: string) => void
  now: () => number
  /** Reading tasks' changes: git trees, diffs and files. */
  git: RouterDeps['git']
  /** Where the machine's key lives (tests use a scratch file). */
  identityPath?: string
  socket?: SocketFactory
}

export interface RemoteStatus {
  enabled: boolean
  relay: string | null
  connected: boolean
  machine: { id: string; name: string; fingerprint: string } | null
  devices: number
  sessions: number
  error: string | null
}

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

export class Remote {
  readonly db: RemoteDb
  private readonly feed: Feed
  private readonly router: Router
  private readonly resolvedBy = new Map<string, string>()
  private readonly lastTouch = new Map<string, number>()
  private host: Host | null = null
  private running = ''
  private identity: Identity | null = null
  private error: string | null = null
  private prunedAt = 0

  constructor(private readonly d: RemoteDeps) {
    this.db = new RemoteDb(d.store.db)
    this.feed = new Feed({ db: this.db, store: d.store, runner: d.runner, host: () => this.host, resolvedBy: this.resolvedBy, now: d.now })
    this.router = new Router({
      runner: d.runner,
      store: d.store,
      chats: d.chats,
      folders: d.folders,
      config: d.config,
      command: d.command,
      db: this.db,
      feed: this.feed,
      machine: () => this.machine(),
      removeDevice: (id, by) => this.removeDevice(id, by),
      resolvedBy: this.resolvedBy,
      git: d.git,
      now: d.now,
      log: d.log,
    })
  }

  /** Starts, restarts or stops the relay connection to match config.json. */
  apply(): void {
    const r = this.d.config().remote
    const want = r.enabled && r.relay ? r.relay : ''
    if (want === this.running) return
    this.host?.stop()
    this.host = null
    this.running = want
    if (!want) return
    try {
      this.identity ??= this.loadIdentity()
    } catch (err) {
      this.error = `can't read ${this.identityPath()}: ${err instanceof Error ? err.message : err}`
      this.d.log(`remote access is off: ${this.error}`)
      return
    }
    this.error = null
    this.host = new Host({
      identity: this.identity,
      relay: want,
      machine: () => this.machine(),
      roleOf: id => this.roleOf(id),
      devices: () => this.db.activeIds(),
      onRequest: (session, request) => {
        this.touch(session.device)
        void this.router.handle(session, request)
      },
      onPairingRequest: offer => this.d.log(`pairing: "${offer.device?.name}" (${offer.device?.platform}) asks to pair as ${offer.role}`),
      onPaired: (device, role) => {
        this.db.addDevice({ ...device, role, addedBy: 'pairing' }, this.d.now())
        this.audit({ device: device.id, deviceName: device.name, action: 'paired', detail: role, ok: true })
        this.d.log(`pairing: "${device.name}" can now reach this machine as ${role}`)
      },
      log: this.d.log,
      now: this.d.now,
      socket: this.d.socket,
    })
    this.host.start()
  }

  stop(): void {
    this.host?.stop()
    this.host = null
    this.running = ''
  }

  status(): RemoteStatus {
    const r = this.d.config().remote
    const id = this.identity ?? (existsSync(this.identityPath()) ? this.tryLoadIdentity() : null)
    return {
      enabled: r.enabled,
      relay: r.relay,
      connected: this.host?.connected ?? false,
      machine: id ? { id: peerId(id.publicKey), name: this.machineName(), fingerprint: fingerprint(peerId(id.publicKey)) } : null,
      devices: this.db.activeIds().length,
      sessions: this.host?.liveSessions().length ?? 0,
      error: this.error,
    }
  }

  /** The notifier sink. */
  notice(text: string, notice: Notice): void {
    this.feed.record(text, notice)
  }

  /** A tool call in the running task, to the apps listening (not stored). */
  activity(a: ToolActivity): void {
    this.host?.broadcast({ type: 'activity', ...a })
  }

  /** Call every few seconds from the daemon's loop. */
  tick(): void {
    this.host?.tick()
    this.feed.tick()
    const now = this.d.now()
    if (now - this.prunedAt > 3600_000) {
      this.prunedAt = now
      this.db.prune(now)
    }
  }

  openOffer(o: { role: Role; autoApprove: boolean; ttlMs?: number }): OfferView | string {
    if (!this.host) return this.error ?? 'Remote access is off: set a relay first (cq pair --relay wss://…).'
    const offer = this.host.openOffer(o)
    this.audit({ device: null, deviceName: null, action: 'pair.offer', detail: o.role, ok: true })
    return offer
  }

  offer(id: string): OfferView | null {
    return this.host?.offer(id) ?? null
  }

  decide(id: string, approve: boolean): OfferView | null {
    const view = this.host?.decide(id, approve) ?? null
    if (view?.device && !approve) this.audit({ device: view.device.id, deviceName: view.device.name, action: 'pair.denied', detail: null, ok: true })
    return view
  }

  devices(o: { revoked?: boolean } = {}) {
    return this.db.devices(o).map(d => ({ ...publicDevice(d), revokedAt: d.revokedAt, addedBy: d.addedBy }))
  }

  /** Finds a device by id, id prefix or name (case-insensitive); a string explains a miss. */
  findDevice(query: string): { id: string; name: string } | string {
    const q = query.trim().toLowerCase()
    const all = this.db.devices()
    const hits = all.filter(d => d.id.toLowerCase() === q || d.name.toLowerCase() === q)
    const prefix = hits.length > 0 ? hits : all.filter(d => q.length >= 4 && d.id.toLowerCase().startsWith(q))
    if (prefix.length === 1) return { id: prefix[0]!.id, name: prefix[0]!.name }
    if (prefix.length > 1) return `"${query}" matches ${prefix.length} devices; use more of the id.`
    return `No paired device is called "${query}". cq devices lists them.`
  }

  /** Cuts a device off everywhere: here, at the relay, and any session it has open. */
  removeDevice(id: string, by: string): boolean {
    const device = this.db.device(id)
    if (!device || device.revokedAt !== null) return false
    this.db.revoke(id, this.d.now())
    this.host?.unlink(id)
    this.audit({ device: id, deviceName: device.name, action: 'device.removed', detail: `by ${by}`, ok: true })
    this.d.log(`remote: removed "${device.name}" (by ${by})`)
    return true
  }

  renameDevice(id: string, name: string): boolean {
    return this.db.rename(id, name.trim().slice(0, 80))
  }

  auditLog(limit: number): AuditEntry[] {
    return this.db.auditLog(limit)
  }

  private audit(e: Omit<AuditEntry, 'at'>): void {
    this.db.audit({ ...e, at: this.d.now() })
  }

  private roleOf(id: string): Role | null {
    const device = this.db.device(id)
    return device && device.revokedAt === null ? device.role : null
  }

  private touch(id: string): void {
    const now = this.d.now()
    if (now - (this.lastTouch.get(id) ?? 0) < 60_000) return
    this.lastTouch.set(id, now)
    this.db.touch(id, now)
  }

  private machineName(): string {
    return (this.d.config().remote.name ?? '').trim() || hostname().replace(/\.local$/, '')
  }

  private machine(): MachineInfo {
    return {
      id: peerId(this.identity!.publicKey),
      name: this.machineName(),
      os: OS_NAMES[process.platform] ?? process.platform,
      arch: process.arch,
      version: this.d.version,
      protocol: PROTOCOL,
    }
  }

  private identityPath(): string {
    return this.d.identityPath ?? paths.identity
  }

  /** The machine's key: made once and kept. A damaged file is an error, never silently replaced. */
  private loadIdentity(): Identity {
    const path = this.identityPath()
    if (existsSync(path)) return decodeIdentity(readFileSync(path, 'utf8'))
    const identity = newIdentity()
    writeFileAtomic(path, encodeIdentity(identity) + '\n', 0o600)
    this.d.log(`remote: created this machine's key (${fingerprint(peerId(identity.publicKey))})`)
    return identity
  }

  private tryLoadIdentity(): Identity | null {
    try {
      return decodeIdentity(readFileSync(this.identityPath(), 'utf8'))
    } catch {
      return null
    }
  }
}
