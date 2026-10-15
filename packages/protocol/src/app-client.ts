// An app's side: pairs with machines, keeps an encrypted session to each one, sends requests and
// receives events. Sessions are restarted after anything that breaks them (the relay reconnects,
// the machine restarts, a message fails to decrypt), and the app catches up on missed events.

import { randomBytes, toBase64url } from './bytes'
import { sessionText, type DataFrame } from './frames'
import { type Identity } from './identity'
import {
  MachineMessage,
  PairResult,
  PROTOCOL,
  Welcome,
  type Event,
  type MachineInfo,
  type Request,
  type Result,
  type Role,
  type Snapshot,
  type State,
} from './messages'
import { offerId, pairingKey, parsePairingLink } from './pairing'
import { RelayClient, type RelayTiming, type SocketFactory } from './relay-client'
import { Session } from './session'

export interface DeviceProfile {
  /** What people call this device, e.g. "Skanda's iPhone". */
  name: string
  platform: string
  /** The app and its version, e.g. "afterhours-app/0.1.0". */
  app: string
}

export interface MachineRecord {
  id: string
  name: string
  relay: string
}

export interface Paired {
  machine: MachineInfo & { relay: string }
  role: Role
}

/** `refused`: the machine doesn't accept this device (removed, or never paired). */
export type MachineStatus = 'offline' | 'connecting' | 'connected' | 'refused'

type RequestBody = Request extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never

interface Listeners {
  event: Set<(e: Event) => void>
  state: Set<(s: State) => void>
  snapshot: Set<(s: Snapshot) => void>
  status: Set<(status: MachineStatus, detail?: string) => void>
}

interface Pending {
  request: Request
  resolve: (r: Result) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface AppClientOptions {
  identity: Identity
  device: DeviceProfile
  log?: (line: string) => void
  socket?: SocketFactory
  timing?: Partial<RelayTiming & { handshakeMs: number; retryMs: number; maxRetryMs: number; requestMs: number }>
}

export class AppClient {
  private readonly relays = new Map<string, RelayClient>()
  private readonly machines = new Map<string, MachineConnection>()
  private readonly pairings = new Map<string, (frame: DataFrame | { undeliverable: string }) => void>()

  constructor(readonly o: AppClientOptions) {}

  /** Starts (or returns) the connection to a machine. `lastSeq`: the last event already seen. */
  connect(record: MachineRecord, o: { lastSeq?: number } = {}): MachineConnection {
    const existing = this.machines.get(record.id)
    if (existing) return existing
    const relay = this.relay(record.relay)
    const conn = new MachineConnection(this, relay, record, o.lastSeq ?? 0)
    this.machines.set(record.id, conn)
    if (relay.ready) conn.handshake()
    return conn
  }

  disconnect(id: string): void {
    this.machines.get(id)?.close()
    this.machines.delete(id)
  }

  /** Pairs with the machine in a pairing link (from `cq pair`). Resolves once the machine says yes. */
  async pair(link: string, o: { timeoutMs?: number } = {}): Promise<Paired> {
    const offer = parsePairingLink(link)
    if (offer.expires < Date.now() - 60_000) throw new Error('That pairing code has expired. Run cq pair again.')
    const relay = this.relay(offer.relay)
    await relay.whenReady(15_000)
    const session = Session.initiate({ identity: this.o.identity, peer: offer.machine, pattern: 'IKpsk2', psk: pairingKey(offer.secret) })
    const id = offerId(offer.secret)
    const key = `${offer.machine}:${sessionText(session.id)}`
    const send = (payload: Uint8Array) => relay.send({ kind: 'pairing', peer: offer.machine, session: session.id, offer: id, payload })
    const timeoutMs = o.timeoutMs ?? Math.max(30_000, Math.min(offer.expires - Date.now() + 30_000, 11 * 60_000))
    return new Promise<Paired>((resolve, reject) => {
      let machine: MachineInfo | undefined
      const finish = (err: Error | null, value?: Paired) => {
        clearTimeout(timer)
        this.pairings.delete(key)
        if (err) reject(err)
        else resolve(value!)
      }
      const timer = setTimeout(() => finish(new Error("The machine didn't answer. Is it still showing the code?")), timeoutMs)
      this.pairings.set(key, input => {
        try {
          if ('undeliverable' in input) {
            finish(new Error(input.undeliverable === 'no-offer' ? 'That pairing code has expired or was already used.' : 'The machine is offline.'))
            return
          }
          if (input.kind === 'reset') {
            finish(new Error('The machine ended the pairing. Run cq pair again.'))
            return
          }
          if (!session.established) {
            const welcome = Welcome.parse(session.readHandshake(input.payload))
            if (!welcome.ok) {
              finish(new Error(`The machine refused: ${welcome.error ?? 'no reason given'}.`))
              return
            }
            machine = welcome.machine
            for (const payload of session.seal({ type: 'pair.confirm' })) send(payload)
            return
          }
          const message = session.open(input.payload)
          if (message === undefined) return
          const result = PairResult.parse(message)
          if (!result.ok) {
            finish(new Error(result.error === 'denied' ? 'The machine said no.' : result.error === 'expired' ? 'Nobody confirmed on the machine in time.' : 'Pairing failed on the machine.'))
            return
          }
          const info = result.machine ?? machine
          if (!info || !result.role) throw new Error('incomplete pairing result')
          finish(null, { machine: { ...info, relay: offer.relay }, role: result.role })
        } catch (err) {
          // A wrong secret or a tampered message fails here: Noise authenticates every byte.
          finish(new Error(`Pairing failed: ${err instanceof Error ? err.message : err}`))
        }
      })
      if (!send(session.writeHandshake({ v: PROTOCOL, app: this.o.device.app, name: this.o.device.name, platform: this.o.device.platform }))) {
        finish(new Error("Can't reach the relay."))
      }
    })
  }

  /**
   * The app came back to the foreground: relay connections that died meanwhile are made again (a
   * ping tells), and machines waiting out a pause before their next try try now.
   */
  wake(): void {
    for (const relay of this.relays.values()) relay.check()
    for (const m of this.machines.values()) m.wake()
  }

  close(): void {
    for (const m of this.machines.values()) m.close()
    this.machines.clear()
    for (const r of this.relays.values()) r.stop()
    this.relays.clear()
  }

  /** @internal */
  relay(url: string): RelayClient {
    let relay = this.relays.get(url)
    if (relay) return relay
    relay = new RelayClient({
      url,
      identity: this.o.identity,
      kind: 'device',
      log: this.o.log,
      socket: this.o.socket,
      timing: this.o.timing,
      onFrame: frame => this.onFrame(frame),
      onReady: () => {
        for (const m of this.machines.values()) if (m.relayUrl === url) m.handshake()
      },
      onDisconnect: () => {
        for (const m of this.machines.values()) if (m.relayUrl === url) m.lost('relay')
      },
      onPresence: (peer, online) => this.machines.get(peer)?.presence(online),
      onUndeliverable: (peer, session, reason) => {
        const key = `${peer}:${sessionText(session)}`
        const pairing = this.pairings.get(key)
        if (pairing) pairing({ undeliverable: reason })
        else this.machines.get(peer)?.undeliverable(session, reason)
      },
    })
    this.relays.set(url, relay)
    relay.start()
    return relay
  }

  private onFrame(frame: DataFrame): void {
    const pairing = this.pairings.get(`${frame.peer}:${sessionText(frame.session)}`)
    if (pairing) {
      pairing(frame)
      return
    }
    this.machines.get(frame.peer)?.onFrame(frame)
  }
}

export class MachineConnection {
  status: MachineStatus = 'offline'
  machine: MachineInfo | null = null
  role: Role | null = null
  private session: Session | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private closed = false
  private readonly pending = new Map<string, Pending>()
  private readonly listeners: Listeners = { event: new Set(), state: new Set(), snapshot: new Set(), status: new Set() }

  constructor(
    private readonly client: AppClient,
    private readonly relay: RelayClient,
    readonly record: MachineRecord,
    /** The last event seen; sent on every reconnect so the machine replays what came after. */
    public lastSeq: number,
  ) {}

  get relayUrl(): string {
    return this.record.relay
  }

  on<K extends keyof Listeners>(type: K, listener: Listeners[K] extends Set<infer F> ? F : never): () => void {
    const set = this.listeners[type] as Set<typeof listener>
    set.add(listener)
    return () => set.delete(listener)
  }

  /** Sends a request; retried on the next session if this one breaks, so it's safe to wait on. */
  request(body: RequestBody, o: { timeoutMs?: number } = {}): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('closed'))
    const request = { ...body, id: toBase64url(randomBytes(16)) } as Request
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new Error(`${this.record.name} didn't answer in time.`))
      }, o.timeoutMs ?? this.timing('requestMs', 30_000))
      this.pending.set(request.id, { request, resolve, reject, timer })
      if (this.session?.established) this.transmit(request)
    })
  }

  close(): void {
    this.closed = true
    this.clearTimers()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('closed'))
    }
    this.pending.clear()
    this.session = null
    this.setStatus('offline')
  }

  /** @internal Starts a new session. */
  handshake(): void {
    if (this.closed || !this.relay.ready || this.status === 'refused') return
    this.clearTimers()
    const app = this.client.o
    const session = Session.initiate({ identity: app.identity, peer: this.record.id, pattern: 'IK' })
    this.session = session
    this.setStatus('connecting')
    const hello = session.writeHandshake({ v: PROTOCOL, app: app.device.app, name: app.device.name, platform: app.device.platform })
    if (!this.relay.send({ kind: 'session', peer: this.record.id, session: session.id, payload: hello })) {
      this.retry()
      return
    }
    this.handshakeTimer = setTimeout(() => {
      if (this.session === session && !session.established) this.lost('timeout')
    }, this.timing('handshakeMs', 15_000))
  }

  /** @internal */
  onFrame(frame: DataFrame): void {
    const session = this.session
    if (!session || sessionText(frame.session) !== sessionText(session.id)) return
    if (frame.kind === 'reset') {
      this.lost('reset')
      return
    }
    try {
      if (!session.established) {
        const welcome = Welcome.parse(session.readHandshake(frame.payload))
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        if (!welcome.ok) {
          this.session = null
          this.setStatus('refused', welcome.error)
          return
        }
        this.machine = welcome.machine ?? null
        this.role = welcome.role ?? null
        this.failures = 0
        this.setStatus('connected')
        this.transmit({ id: toBase64url(randomBytes(16)), type: 'sync', since: this.lastSeq })
        for (const p of this.pending.values()) this.transmit(p.request)
        return
      }
      const raw = session.open(frame.payload)
      if (raw === undefined) return
      const message = MachineMessage.safeParse(raw)
      if (!message.success) {
        this.client.o.log?.(`${this.record.name}: ignored a message this app version does not understand`)
        return
      }
      this.dispatch(message.data)
    } catch (err) {
      this.client.o.log?.(`${this.record.name}: session broke (${err instanceof Error ? err.message : err}); starting a new one`)
      this.lost('decrypt')
    }
  }

  /** @internal The app is back in the foreground: don't wait out the pause before the next try. */
  wake(): void {
    if (this.closed || this.status === 'refused' || this.status === 'connected') return
    if (this.session && !this.session.established) return // a handshake is under way
    this.failures = 0
    // Without the relay, its sign-in starts the handshake.
    if (this.relay.ready) this.handshake()
  }

  /** @internal The relay says the machine came or went. */
  presence(online: boolean): void {
    if (online && this.status === 'offline') this.handshake()
    if (!online && this.status !== 'refused') {
      this.session = null
      this.setStatus('offline')
    }
  }

  /** @internal */
  undeliverable(session: Uint8Array, reason: string): void {
    if (!this.session || sessionText(session) !== sessionText(this.session.id)) return
    this.session = null
    if (reason === 'not-linked') {
      this.setStatus('refused', 'not-paired')
      return
    }
    // Offline: wait for the relay to say it's back (or retry later, in case that word is lost).
    this.setStatus('offline')
    this.retry()
  }

  /** @internal The session is gone; start another after a pause. */
  lost(_why: string): void {
    this.session = null
    if (this.status === 'refused') return
    this.setStatus(this.relay.ready ? 'connecting' : 'offline')
    this.retry()
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return
    const base = Math.min(this.timing('maxRetryMs', 60_000), this.timing('retryMs', 2_000) * 2 ** this.failures)
    this.failures = Math.min(this.failures + 1, 10)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.handshake()
    }, Math.round(base * (0.8 + Math.random() * 0.4)))
  }

  private dispatch(message: MachineMessage): void {
    switch (message.type) {
      case 'result': {
        const p = this.pending.get(message.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(message.id)
        p.resolve(message)
        return
      }
      case 'event':
        if (message.seq > this.lastSeq) this.lastSeq = message.seq
        for (const l of this.listeners.event) l(message)
        return
      case 'state':
        for (const l of this.listeners.state) l(message)
        return
      case 'snapshot':
        if (message.seq > this.lastSeq) this.lastSeq = message.seq
        this.machine = message.machine
        this.role = message.role
        for (const l of this.listeners.snapshot) l(message)
        return
      case 'pair.result':
        return
    }
  }

  private transmit(request: Request): void {
    const session = this.session
    if (!session?.established) return
    for (const payload of session.seal(request)) {
      if (!this.relay.send({ kind: 'session', peer: this.record.id, session: session.id, payload })) {
        this.lost('relay')
        return
      }
    }
  }

  private setStatus(status: MachineStatus, detail?: string): void {
    if (this.status === status && !detail) return
    this.status = status
    for (const l of this.listeners.status) l(status, detail)
  }

  private clearTimers(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.handshakeTimer = this.retryTimer = null
  }

  private timing(key: 'handshakeMs' | 'retryMs' | 'maxRetryMs' | 'requestMs', fallback: number): number {
    return this.client.o.timing?.[key] ?? fallback
  }
}
