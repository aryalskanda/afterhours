// A peer's connection to the relay: signs in with its key, keeps the connection alive, reconnects
// with backoff, and hands over the frames addressed to it. Uses the platform's WebSocket (Bun,
// browsers, Electron and React Native all have one).

import { fromBase64url, toBase64url } from './bytes'
import { authMessage, decodeFrame, encodeFrame, RelayControl, RELAY_PROTOCOL_VERSION, type DataFrame, type PeerControl, type PeerKind } from './frames'
import { peerId, sign, type Identity } from './identity'

/** The parts of the WebSocket API this uses. */
export interface SocketLike {
  binaryType: string
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
}
export type SocketFactory = (url: string) => SocketLike

export interface RelayTiming {
  pingMs: number
  pongTimeoutMs: number
  authTimeoutMs: number
  minBackoffMs: number
  maxBackoffMs: number
}

const DEFAULT_TIMING: RelayTiming = { pingMs: 20_000, pongTimeoutMs: 10_000, authTimeoutMs: 15_000, minBackoffMs: 1_000, maxBackoffMs: 30_000 }

export interface RelayClientOptions {
  url: string
  identity: Identity
  kind: PeerKind
  onFrame: (frame: DataFrame) => void
  onReady?: () => void
  onPresence?: (peer: string, online: boolean) => void
  onUndeliverable?: (peer: string, session: Uint8Array, reason: string) => void
  onDisconnect?: () => void
  log?: (line: string) => void
  socket?: SocketFactory
  timing?: Partial<RelayTiming>
}

export class RelayClient {
  readonly id: string
  readonly url: string
  private ws: SocketLike | null = null
  private isReady = false
  private stopped = true
  private failures = 0
  private lastPong = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly presence = new Map<string, boolean>()
  private readonly timing: RelayTiming
  private readonly readyWaiters = new Set<() => void>()

  constructor(private readonly o: RelayClientOptions) {
    this.id = peerId(o.identity.publicKey)
    this.url = o.url
    this.timing = { ...DEFAULT_TIMING, ...o.timing }
  }

  get ready(): boolean {
    return this.isReady
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    this.isReady = false
    ws?.close(1000, 'bye')
  }

  /** Resolves once signed in (immediately if already). */
  whenReady(timeoutMs: number): Promise<void> {
    if (this.isReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        this.readyWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.readyWaiters.delete(done)
        reject(new Error(`Can't reach the relay at ${this.url}.`))
      }, timeoutMs)
      this.readyWaiters.add(done)
    })
  }

  /** Whether the relay last said this linked peer is connected (undefined: no word yet). */
  isOnline(peer: string): boolean | undefined {
    return this.presence.get(peer)
  }

  send(frame: DataFrame): boolean {
    if (!this.isReady || !this.ws) return false
    const bytes = encodeFrame(frame)
    this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    return true
  }

  control(message: PeerControl): boolean {
    if (!this.isReady || !this.ws) return false
    this.ws.send(JSON.stringify(message))
    return true
  }

  private connect(): void {
    this.clearTimers()
    let ws: SocketLike
    try {
      ws = this.o.socket ? this.o.socket(this.o.url) : (new WebSocket(this.o.url) as unknown as SocketLike)
    } catch (err) {
      this.log(`relay: can't connect to ${this.o.url}: ${err instanceof Error ? err.message : err}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    this.authTimer = setTimeout(() => {
      this.log('relay: sign-in timed out')
      ws.close()
    }, this.timing.authTimeoutMs)
    ws.onmessage = ev => {
      if (this.ws !== ws) return
      if (typeof ev.data === 'string') this.onControl(ws, ev.data)
      else this.onBinary(ev.data)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.onClosed()
    }
    ws.onerror = () => {
      // A close event follows.
    }
  }

  private onControl(ws: SocketLike, text: string): void {
    let message: RelayControl
    try {
      message = RelayControl.parse(JSON.parse(text))
    } catch {
      this.log('relay: ignored a message it sent that this version does not understand')
      return
    }
    switch (message.t) {
      case 'challenge': {
        const signature = sign(this.o.identity, authMessage(message.nonce, this.o.kind))
        ws.send(JSON.stringify({ t: 'auth', v: RELAY_PROTOCOL_VERSION, id: this.id, kind: this.o.kind, sig: toBase64url(signature) }))
        return
      }
      case 'ready': {
        if (this.authTimer) clearTimeout(this.authTimer)
        this.authTimer = null
        this.isReady = true
        this.failures = 0
        this.lastPong = Date.now()
        this.pingTimer = setInterval(() => this.heartbeat(), this.timing.pingMs)
        for (const done of [...this.readyWaiters]) done()
        this.o.onReady?.()
        return
      }
      case 'pong':
        this.lastPong = Date.now()
        return
      case 'presence':
        this.presence.set(message.peer, message.online)
        this.o.onPresence?.(message.peer, message.online)
        return
      case 'undeliverable':
        this.o.onUndeliverable?.(message.peer, fromBase64url(message.session), message.reason)
        return
      case 'error':
        this.log(`relay: ${message.code}: ${message.message}`)
        return
    }
  }

  private onBinary(data: unknown): void {
    if (!this.isReady) return
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else return
    let frame: DataFrame
    try {
      frame = decodeFrame(bytes)
    } catch {
      return
    }
    this.o.onFrame(frame)
  }

  private heartbeat(): void {
    if (!this.ws || !this.isReady) return
    if (Date.now() - this.lastPong > this.timing.pingMs + this.timing.pongTimeoutMs) {
      this.log('relay: no reply to pings; reconnecting')
      this.ws.close()
      return
    }
    this.ws.send(JSON.stringify({ t: 'ping' }))
  }

  private onClosed(): void {
    const wasReady = this.isReady
    this.isReady = false
    this.ws = null
    this.clearTimers()
    this.presence.clear()
    if (wasReady) this.o.onDisconnect?.()
    if (!this.stopped) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const base = Math.min(this.timing.maxBackoffMs, this.timing.minBackoffMs * 2 ** this.failures)
    this.failures = Math.min(this.failures + 1, 16)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.authTimer) clearTimeout(this.authTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = this.authTimer = this.pingTimer = null
  }

  private log(line: string): void {
    this.o.log?.(line)
  }
}
