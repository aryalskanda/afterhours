// A machine's side of remote access: it accepts encrypted sessions from paired apps, runs
// pairings, and sends events to the apps that listen. Which devices are allowed, and what their
// requests do, is up to the caller (the daemon's remote module).

import { randomBytes, toBase64url } from './bytes'
import { sessionText, type DataFrame } from './frames'
import { peerId, type Identity } from './identity'
import { Hello, PairConfirm, PROTOCOL, Request, type MachineInfo, type MachineMessage, type Role } from './messages'
import { offerId, pairingKey, pairingLink, PAIRING_SECRET_BYTES, PAIRING_TTL_MS } from './pairing'
import { RelayClient, type RelayTiming, type SocketFactory } from './relay-client'
import { Session } from './session'

export interface DeviceHello {
  id: string
  name: string
  platform: string
}

export interface HostSession {
  readonly device: string
  readonly hello: Hello
  role: Role
  /** Set once the app asked for events (a `sync` request). */
  subscribed: boolean
  lastActive: number
  send(message: MachineMessage): boolean
}

export type OfferStatus = 'waiting' | 'confirm' | 'paired' | 'denied' | 'expired'

export interface OfferView {
  offer: string
  link: string
  role: Role
  expires: number
  status: OfferStatus
  device: DeviceHello | null
}

export interface HostOptions {
  identity: Identity
  relay: string
  machine: () => MachineInfo
  /** A paired device's role, or null when it isn't (or is no longer) allowed. */
  roleOf: (device: string) => Role | null
  /** Every device allowed to reach this machine: the relay routes only between linked keys. */
  devices: () => string[]
  onRequest: (session: HostSession, request: Request) => void
  /** A pairing passed the secret check and waits for a yes or no (`decide`). */
  onPairingRequest?: (offer: OfferView) => void
  /** On a yes: keep the device. Throwing turns the yes into a refusal. */
  onPaired: (device: DeviceHello, role: Role) => void
  onRelayState?: (connected: boolean) => void
  log?: (line: string) => void
  now?: () => number
  socket?: SocketFactory
  timing?: Partial<RelayTiming>
  limits?: Partial<HostLimits>
}

export interface HostLimits {
  sessionsPerDevice: number
  /** Sessions with no traffic for this long are dropped; the app starts a new one when it needs to. */
  idleMs: number
  /** Unconfirmed pairing handshakes per offer (a relay could otherwise block one by starting it). */
  pendingPairings: number
  /** How long a pairing handshake may take to prove the secret. */
  pairingConfirmMs: number
}

const DEFAULT_LIMITS: HostLimits = { sessionsPerDevice: 8, idleMs: 24 * 3600_000, pendingPairings: 8, pairingConfirmMs: 60_000 }

interface Offer {
  view: OfferView
  id: Uint8Array
  secret: Uint8Array
  autoApprove: boolean
  pending: Map<string, { session: Session; device: DeviceHello; startedAt: number }>
  winner: { session: Session; device: DeviceHello } | null
}

class LiveSession implements HostSession {
  subscribed = false

  constructor(
    readonly key: string,
    readonly device: string,
    readonly session: Session,
    readonly hello: Hello,
    public role: Role,
    public lastActive: number,
    private readonly transmit: (s: LiveSession, message: MachineMessage) => boolean,
  ) {}

  send(message: MachineMessage): boolean {
    return this.transmit(this, message)
  }
}

export class Host {
  readonly id: string
  private readonly relay: RelayClient
  private readonly sessions = new Map<string, LiveSession>()
  private readonly offers = new Map<string, Offer>()
  private readonly limits: HostLimits
  private readonly now: () => number

  constructor(private readonly o: HostOptions) {
    this.id = peerId(o.identity.publicKey)
    this.limits = { ...DEFAULT_LIMITS, ...o.limits }
    this.now = o.now ?? Date.now
    this.relay = new RelayClient({
      url: o.relay,
      identity: o.identity,
      kind: 'agent',
      onFrame: frame => this.onFrame(frame),
      onReady: () => this.onReady(),
      onDisconnect: () => this.onDisconnect(),
      log: o.log,
      socket: o.socket,
      timing: o.timing,
    })
  }

  get relayUrl(): string {
    return this.o.relay
  }

  get connected(): boolean {
    return this.relay.ready
  }

  start(): void {
    this.relay.start()
  }

  stop(): void {
    for (const s of this.sessions.values()) this.sendReset(s.device, s.session.id)
    this.sessions.clear()
    this.relay.stop()
  }

  /** The sessions open right now, newest activity first. */
  liveSessions(): HostSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActive - a.lastActive)
  }

  /** Sends to every session that asked for events (and passes `filter`). */
  broadcast(message: MachineMessage, filter: (s: HostSession) => boolean = () => true): number {
    let sent = 0
    for (const s of this.sessions.values()) if (s.subscribed && filter(s) && s.send(message)) sent++
    return sent
  }

  /** Lets a device reach this machine through the relay. */
  link(device: string): void {
    this.relay.control({ t: 'link', peer: device })
  }

  /** Cuts a device off: at the relay, and every session it has open. */
  unlink(device: string): void {
    this.relay.control({ t: 'unlink', peer: device })
    for (const [key, s] of this.sessions) {
      if (s.device !== device) continue
      this.sessions.delete(key)
      this.sendReset(s.device, s.session.id)
    }
  }

  /** A pairing offer: show its link as a QR code. Valid for `ttlMs` (10 minutes by default). */
  openOffer(o: { role: Role; autoApprove?: boolean; ttlMs?: number }): OfferView {
    const secret = randomBytes(PAIRING_SECRET_BYTES)
    const id = offerId(secret)
    const expires = this.now() + Math.min(o.ttlMs ?? PAIRING_TTL_MS, PAIRING_TTL_MS)
    const machine = this.o.machine()
    const view: OfferView = {
      offer: toBase64url(id),
      link: pairingLink({ relay: this.o.relay, machine: this.id, name: machine.name, secret, expires }),
      role: o.role,
      expires,
      status: 'waiting',
      device: null,
    }
    this.offers.set(view.offer, { view, id, secret, autoApprove: o.autoApprove ?? false, pending: new Map(), winner: null })
    this.relay.control({ t: 'offer', offer: view.offer, expires })
    return { ...view }
  }

  offer(offer: string): OfferView | null {
    const o = this.offers.get(offer)
    return o ? { ...o.view, device: o.view.device ? { ...o.view.device } : null } : null
  }

  /** Your yes or no to a pairing that proved the secret. */
  decide(offer: string, approve: boolean): OfferView | null {
    const o = this.offers.get(offer)
    if (!o || o.view.status !== 'confirm' || !o.winner) return this.offer(offer)
    const { session, device } = o.winner
    let error: string | undefined
    if (approve) {
      try {
        this.o.onPaired(device, o.view.role)
        this.link(device.id)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        this.log(`pairing ${device.name}: ${error}`)
      }
    }
    const ok = approve && !error
    o.view.status = ok ? 'paired' : 'denied'
    this.sendPairing(device.id, session, o.id, {
      type: 'pair.result',
      ok,
      ...(ok ? { machine: this.o.machine(), role: o.view.role } : { error: error ? 'failed' : 'denied' }),
    })
    this.closeOffer(o)
    return this.offer(offer)
  }

  /** Expires offers and pairing handshakes, and drops idle sessions. Call every few seconds. */
  tick(): void {
    const now = this.now()
    for (const o of this.offers.values()) {
      for (const [key, p] of o.pending) if (now - p.startedAt > this.limits.pairingConfirmMs) o.pending.delete(key)
      if (now <= o.view.expires || o.view.status === 'paired' || o.view.status === 'denied' || o.view.status === 'expired') continue
      if (o.view.status === 'confirm' && o.winner) {
        this.sendPairing(o.winner.device.id, o.winner.session, o.id, { type: 'pair.result', ok: false, error: 'expired' })
      }
      o.view.status = 'expired'
      this.closeOffer(o)
    }
    // Finished offers are kept a while so `cq pair` can read how it ended.
    for (const [key, o] of this.offers) if (now - o.view.expires > 30 * 60_000) this.offers.delete(key)
    for (const [key, s] of this.sessions) {
      if (now - s.lastActive <= this.limits.idleMs) continue
      this.sessions.delete(key)
      this.sendReset(s.device, s.session.id)
    }
  }

  private onReady(): void {
    this.relay.control({ t: 'links', peers: this.o.devices() })
    for (const o of this.offers.values()) {
      if (o.view.status === 'waiting' || o.view.status === 'confirm') this.relay.control({ t: 'offer', offer: o.view.offer, expires: o.view.expires })
    }
    this.log(`relay: connected to ${this.o.relay}`)
    this.o.onRelayState?.(true)
  }

  private onDisconnect(): void {
    // Frames in flight are lost, so the sessions can't continue in order: apps start new ones.
    this.sessions.clear()
    this.log('relay: disconnected; reconnecting')
    this.o.onRelayState?.(false)
  }

  private onFrame(frame: DataFrame): void {
    const key = `${frame.peer}:${sessionText(frame.session)}`
    if (frame.kind === 'reset') {
      this.sessions.delete(key)
      return
    }
    if (frame.kind === 'pairing') {
      this.onPairingFrame(frame, key)
      return
    }
    const live = this.sessions.get(key)
    if (live) {
      this.onSessionFrame(live, frame)
      return
    }
    this.onNewSession(frame, key)
  }

  private onNewSession(frame: DataFrame, key: string): void {
    let session: Session
    let hello: Hello
    try {
      session = Session.respond({ identity: this.o.identity, peer: frame.peer, pattern: 'IK', id: frame.session })
      hello = Hello.parse(session.readHandshake(frame.payload))
    } catch {
      // Not a handshake: a session this machine forgot (it restarted), or garbage. Start over.
      this.sendReset(frame.peer, frame.session)
      return
    }
    const role = this.o.roleOf(frame.peer)
    if (!role) {
      this.sendFrame('session', frame.peer, session.id, session.writeHandshake({ v: PROTOCOL, ok: false, error: 'not-paired' }))
      return
    }
    const mine = [...this.sessions.values()].filter(s => s.device === frame.peer).sort((a, b) => a.lastActive - b.lastActive)
    for (const old of mine.slice(0, Math.max(0, mine.length - this.limits.sessionsPerDevice + 1))) {
      this.sessions.delete(old.key)
      this.sendReset(old.device, old.session.id)
    }
    this.sendFrame('session', frame.peer, session.id, session.writeHandshake({ v: PROTOCOL, ok: true, machine: this.o.machine(), role }))
    const live = new LiveSession(key, frame.peer, session, hello, role, this.now(), (s, m) => this.transmit(s, m))
    this.sessions.set(key, live)
  }

  private onSessionFrame(live: LiveSession, frame: DataFrame): void {
    let message: unknown
    try {
      message = live.session.open(frame.payload)
    } catch {
      this.log(`session from ${live.hello.name} failed to decrypt; dropped it`)
      this.sessions.delete(live.key)
      this.sendReset(live.device, live.session.id)
      return
    }
    if (message === undefined) return
    live.lastActive = this.now()
    // Removed while connected: the session ends with the next thing it sends.
    const role = this.o.roleOf(live.device)
    if (!role) {
      this.sessions.delete(live.key)
      this.sendReset(live.device, live.session.id)
      return
    }
    live.role = role
    const parsed = Request.safeParse(message)
    if (!parsed.success) {
      const id = (message as { id?: unknown } | null)?.id
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)) {
        live.send({ type: 'result', id, ok: false, code: 'invalid', error: 'This machine runs a different version and does not understand that request.' })
      }
      return
    }
    try {
      this.o.onRequest(live, parsed.data)
    } catch (err) {
      this.log(`request ${parsed.data.type} failed: ${err instanceof Error ? err.message : err}`)
      live.send({ type: 'result', id: parsed.data.id, ok: false, code: 'failed', error: 'Something went wrong on the machine.' })
    }
  }

  private onPairingFrame(frame: DataFrame, key: string): void {
    const o = frame.offer ? this.offers.get(toBase64url(frame.offer)) : undefined
    if (!o || o.view.status !== 'waiting' || this.now() > o.view.expires) {
      // A finished pairing gets no more answers; the app has its result.
      if (!(o?.winner && `${o.winner.device.id}:${sessionText(o.winner.session.id)}` === key)) this.sendReset(frame.peer, frame.session)
      return
    }
    const pending = o.pending.get(key)
    if (!pending) {
      if (o.pending.size >= this.limits.pendingPairings) {
        this.sendReset(frame.peer, frame.session)
        return
      }
      try {
        const session = Session.respond({ identity: this.o.identity, peer: frame.peer, pattern: 'IKpsk2', psk: pairingKey(o.secret), id: frame.session })
        const hello = Hello.parse(session.readHandshake(frame.payload))
        const device = { id: frame.peer, name: hello.name, platform: hello.platform }
        o.pending.set(key, { session, device, startedAt: this.now() })
        this.sendPairing(frame.peer, session, o.id, { v: PROTOCOL, ok: true, machine: this.o.machine() }, true)
      } catch {
        this.sendReset(frame.peer, frame.session)
      }
      return
    }
    let message: unknown
    try {
      message = pending.session.open(frame.payload)
    } catch {
      // Didn't know the secret.
      o.pending.delete(key)
      this.sendReset(frame.peer, frame.session)
      return
    }
    if (message === undefined || !PairConfirm.safeParse(message).success) return
    o.pending.clear()
    o.winner = { session: pending.session, device: pending.device }
    o.view.status = 'confirm'
    o.view.device = pending.device
    this.o.onPairingRequest?.(this.offer(o.view.offer)!)
    if (o.autoApprove) this.decide(o.view.offer, true)
  }

  private closeOffer(o: Offer): void {
    o.pending.clear()
    this.relay.control({ t: 'offer.close', offer: o.view.offer })
  }

  private transmit(s: LiveSession, message: MachineMessage): boolean {
    if (!this.sessions.has(s.key)) return false
    try {
      for (const payload of s.session.seal(message)) {
        if (!this.sendFrame('session', s.device, s.session.id, payload)) {
          // The relay connection went away mid-message: this session can't continue in order.
          this.sessions.delete(s.key)
          return false
        }
      }
      return true
    } catch (err) {
      this.log(`couldn't send to ${s.hello.name}: ${err instanceof Error ? err.message : err}`)
      return false
    }
  }

  /** A pairing message: the second handshake message (`handshake`), else a sealed message. */
  private sendPairing(device: string, session: Session, offer: Uint8Array, message: unknown, handshake = false): void {
    try {
      const payloads = handshake ? [session.writeHandshake(message)] : session.seal(message)
      for (const payload of payloads) this.relay.send({ kind: 'pairing', peer: device, session: session.id, offer, payload })
    } catch (err) {
      this.log(`pairing message to ${device.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private sendFrame(kind: 'session', peer: string, session: Uint8Array, payload: Uint8Array): boolean {
    return this.relay.send({ kind, peer, session, payload })
  }

  private sendReset(peer: string, session: Uint8Array): void {
    this.relay.send({ kind: 'reset', peer, session, payload: new Uint8Array(0) })
  }

  private log(line: string): void {
    this.o.log?.(line)
  }
}
