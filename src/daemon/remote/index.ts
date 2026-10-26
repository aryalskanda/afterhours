// Remote access from the Afterhours apps: this machine connects out to a relay, apps pair with it
// (cq pair), and everything between them is end-to-end encrypted (packages/protocol). Turned on
// by `cq pair`; config.json's `remote` section holds the relay and this machine's rules.
// With `remote.serve` the machine runs the relay itself, on 127.0.0.1.

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
  type Hello,
  type OfferView,
  type Role,
  type SocketFactory,
} from '@afterhours/protocol'
import { startRelay, type Relay } from '../../../relay/src/server'
import { isOwnRelay, paths, writeFileAtomic, type Config } from '../../shared/config'
import type { JobSpec } from '../../shared/types'
import type { ChatSource } from '../chats'
import type { FolderMap } from '../folders'
import type { Notice } from '../notify'
import type { Runner, ToolActivity } from '../runner'
import type { MacControl } from '../mac'
import type { Store } from '../store'
import { RemoteDb, type AuditEntry } from './db'
import { Feed } from './feed'
import { PushSender, pushesFor } from './push'
import { publicDevice, Router, type RouterDeps } from './router'

export interface RemoteDeps {
  store: Store
  runner: Runner
  chats: ChatSource
  folders: FolderMap
  config: () => Config
  saveConfig: (config: Config) => void
  home?: () => string | undefined
  command: (text: string, guard: (spec: JobSpec) => string | null) => Promise<string | null>
  version: string
  log: (line: string) => void
  now: () => number
  /** Reading tasks' changes: git trees, diffs and files. */
  git: RouterDeps['git']
  /** Opens a conversation in VS Code on this machine's screen. */
  openInVsCode?: (sessionId: string) => boolean
  uploadsDir: string
  claudeDir: string
  claudeJson: string
  claudePath: string
  logPath: string
  /** Exits so the service starts the engine again. */
  restart: () => void
  /** Where problem reports from apps go. */
  reportsPath: string
  /** Expo's push service (tests and private runs point it at a stand-in). */
  push?: { url?: string; receiptsUrl?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
  /** Where the machine's key lives (tests use a scratch file). */
  identityPath?: string
  socket?: SocketFactory
  /** When this machine runs the relay (remote.serve): the relay's database. */
  relayDb?: string
  /** A device was just paired (the Telegram bot says so in your chat). */
  onPaired?: (device: { name: string; platform: string }, role: Role) => void
  /** How long connected apps get to hear about a new relay before the machine moves there. */
  relayMoveMs?: number
  /** Quitting apps and sleeping the Mac; null on other systems. */
  mac?: MacControl | null
}

const RELAY_MOVE_MS = 3000

export interface RemoteStatus {
  enabled: boolean
  relay: string | null
  connected: boolean
  machine: { id: string; name: string; fingerprint: string } | null
  devices: number
  sessions: number
  error: string | null
  /** The relay this machine runs itself (remote.serve), and the app it serves. */
  serving: { port: number; listening: number | null; publicUrl: string | null; error: string | null } | null
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
  /** On the way to another relay: apps were told, and the machine follows when the timer fires. */
  private moving: { to: string; timer: ReturnType<typeof setTimeout> } | null = null
  /** The relay this machine runs: the port config asked for (0 picks one), and the server. */
  private relay: { port: number; server: Relay } | null = null
  private relayError: string | null = null
  private relayTriedAt = 0
  private identity: Identity | null = null
  private error: string | null = null
  private prunedAt = 0
  private receiptsAt = 0
  readonly pusher: PushSender

  constructor(private readonly d: RemoteDeps) {
    this.db = new RemoteDb(d.store.db)
    this.pusher = new PushSender({ ...d.push, gone: token => this.db.dropPushToken(token), log: d.log, now: d.now })
    this.feed = new Feed({ db: this.db, store: d.store, runner: d.runner, host: () => this.host, resolvedBy: this.resolvedBy, now: d.now })
    this.router = new Router({
      mac: d.mac ?? null,
      runner: d.runner,
      store: d.store,
      chats: d.chats,
      folders: d.folders,
      config: d.config,
      saveConfig: d.saveConfig,
      home: d.home,
      command: d.command,
      db: this.db,
      feed: this.feed,
      machine: () => this.machine(),
      removeDevice: (id, by) => this.removeDevice(id, by),
      resolvedBy: this.resolvedBy,
      git: d.git,
      openInVsCode: d.openInVsCode,
      uploadsDir: d.uploadsDir,
      claudeDir: d.claudeDir,
      claudeJson: d.claudeJson,
      claudePath: d.claudePath,
      logPath: d.logPath,
      reportsPath: d.reportsPath,
      restart: d.restart,
      // An owner asking for an invite is the approval.
      openOffer: role => {
        const offer = this.openOffer({ role, autoApprove: true })
        return typeof offer === 'string' ? offer : { link: offer.link, expires: offer.expires }
      },
      now: d.now,
      log: d.log,
    })
  }

  /** Starts, restarts or stops the relay connection (and the relay this machine runs) to match config.json. */
  apply(): void {
    const r = this.d.config().remote
    this.applyServe(r.enabled ? r.serve : null)
    // The relay apps use is the one this machine runs: reach it locally (links give apps its public
    // address). Any other relay, a hosted one, say, is used as it is, even while this one runs.
    const local = this.relay ? `ws://127.0.0.1:${this.relay.server.port}/v1` : null
    const want = !r.enabled || !r.relay ? '' : r.serve && isOwnRelay(r) ? (local ?? '') : r.relay
    if (this.moving && this.moving.to !== want) {
      clearTimeout(this.moving.timer)
      this.moving = null
    }
    if (want === this.running || this.moving) return
    // Moving to another relay: apps connected now hear the new address first and follow, with no
    // pairing again; then this machine moves.
    if (want && r.relay && this.running && this.host?.connected && this.host.liveSessions().length > 0) {
      this.feed.relayMoved(r.relay)
      this.d.log(`remote: moving to the relay at ${r.relay}`)
      this.moving = {
        to: want,
        timer: setTimeout(() => {
          this.moving = null
          this.connect(want)
        }, this.d.relayMoveMs ?? RELAY_MOVE_MS),
      }
      return
    }
    this.connect(want)
  }

  /** Connects to the relay at `want` (none for ''), dropping the connection there was. */
  private connect(want: string): void {
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
      linkRelay: () => this.d.config().remote.relay ?? want,
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
        this.d.onPaired?.(device, role)
      },
      log: this.d.log,
      now: this.d.now,
      socket: this.d.socket,
    })
    this.host.start()
  }

  stop(): void {
    if (this.moving) clearTimeout(this.moving.timer)
    this.moving = null
    this.host?.stop()
    this.host = null
    this.running = ''
    this.applyServe(null)
  }

  /** Starts or stops the relay this machine runs, serving the app too. */
  private applyServe(serve: { port: number } | null): void {
    const port = serve?.port ?? null
    if (this.relay && this.relay.port === port) return
    if (this.relay) {
      void this.relay.server.stop()
      this.relay = null
      this.d.log('remote: stopped the relay on this machine')
    }
    this.relayError = null
    if (port === null) return
    this.relayTriedAt = this.d.now()
    try {
      const server = startRelay({
        port,
        hostname: '127.0.0.1',
        db: this.d.relayDb ?? paths.relayDb,
        log: line => this.d.log(`relay: ${line}`),
      })
      this.relay = { port, server }
    } catch (err) {
      this.relayError = `can't run the relay on 127.0.0.1:${port}: ${err instanceof Error ? err.message : err}`
      this.d.log(`remote: ${this.relayError}`)
    }
  }

  /** This machine's id, as the apps know it (in their addresses). */
  machineId(): string | null {
    return this.identity ? peerId(this.identity.publicKey) : null
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
      error: this.error ?? this.relayError,
      serving: r.serve
        ? { port: r.serve.port, listening: this.relay?.server.port ?? null, publicUrl: r.publicUrl, error: this.relayError }
        : null,
    }
  }

  /** The notifier sink: to the apps listening, and pushed to the devices that asked. */
  notice(text: string, notice: Notice): void {
    this.feed.record(text, notice)
    const targets = this.db.pushTargets()
    if (targets.length === 0 || !this.identity) return
    const info = this.machine()
    const messages = pushesFor(targets, { machine: { id: info.id, name: info.name }, notice, text, now: this.d.now() })
    if (messages.length > 0) void this.pusher.send(messages)
  }

  /** A tool call in the running task, to the apps listening (not stored). */
  activity(a: ToolActivity): void {
    this.host?.broadcast({ type: 'activity', ...a })
  }

  /** Call every few seconds from the daemon's loop. */
  tick(): void {
    // The relay this machine runs couldn't start (its port was taken): try again every minute.
    if (this.relayError && this.d.now() - this.relayTriedAt > 60_000) this.apply()
    this.host?.tick()
    this.feed.tick()
    const now = this.d.now()
    if (now - this.receiptsAt > 5 * 60_000) {
      this.receiptsAt = now
      void this.pusher.checkReceipts()
    }
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
