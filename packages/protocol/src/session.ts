// One end-to-end encrypted session between an app and a machine, on top of Noise. The app
// (initiator) knows the machine's key from pairing, so sessions use IK; pairing itself uses IKpsk2
// with the one-time secret from the QR code. Messages are JSON, split into chunks when they're
// bigger than one Noise message.

import { concat, equal, fromUtf8, randomBytes, utf8 } from './bytes'
import { SESSION_ID_LENGTH } from './frames'
import { dhKeyPair, dhPublicKey, peerId, publicKeyOf, type Identity } from './identity'
import { Handshake, type Transport } from './noise'

/** Message bytes per Noise message; one more byte flags "more follows". Below the Noise limit, with room. */
export const CHUNK_BYTES = 60_000
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

export type SessionPattern = 'IK' | 'IKpsk2'

export interface SessionOptions {
  identity: Identity
  /** The other side's peer id. */
  peer: string
  pattern: SessionPattern
  /** IKpsk2 only: 32 bytes, from the pairing secret. */
  psk?: Uint8Array
  /** Chosen by the initiator; the responder takes it from the frame. */
  id?: Uint8Array
}

export class Session {
  readonly id: Uint8Array
  readonly peer: string
  readonly initiator: boolean
  private handshake: Handshake | null
  private transport: Transport | null = null
  private pieces: Uint8Array[] = []
  private pieceBytes = 0

  private constructor(o: SessionOptions, initiator: boolean) {
    this.id = o.id ?? randomBytes(SESSION_ID_LENGTH)
    if (this.id.length !== SESSION_ID_LENGTH) throw new Error('bad session id')
    this.peer = o.peer
    this.initiator = initiator
    const me = publicKeyOf(peerId(o.identity.publicKey))
    const them = publicKeyOf(o.peer)
    // Binds the session to both peer ids and this session id: a relay that swaps any of them
    // breaks the handshake.
    const prologue = concat(utf8('afterhours-session-v1'), initiator ? me : them, initiator ? them : me, this.id)
    this.handshake = new Handshake({
      pattern: o.pattern,
      initiator,
      prologue,
      s: dhKeyPair(o.identity),
      rs: initiator ? dhPublicKey(o.peer) : undefined,
      psk: o.psk,
    })
  }

  /** The app's side. */
  static initiate(o: SessionOptions): Session {
    return new Session(o, true)
  }

  /** The machine's side, for a session the app started. */
  static respond(o: SessionOptions & { id: Uint8Array }): Session {
    return new Session(o, false)
  }

  get established(): boolean {
    return this.transport !== null
  }

  /** The next handshake message, carrying `payload` (JSON, encrypted as far as the pattern allows). */
  writeHandshake(payload: unknown): Uint8Array {
    const hs = this.mustHandshake()
    const message = hs.writeMessage(encodeJson(payload))
    if (hs.finished) this.finishHandshake()
    return message
  }

  /** Reads a handshake message and returns its payload. Throws when it fails authentication. */
  readHandshake(message: Uint8Array): unknown {
    const hs = this.mustHandshake()
    const payload = hs.readMessage(message)
    // The machine checks that the key the app proved it holds is the key of the peer id the relay
    // says the frame came from.
    if (!this.initiator && !equal(hs.remoteStatic ?? new Uint8Array(0), dhPublicKey(this.peer))) {
      throw new Error("the session key doesn't match the sender")
    }
    if (hs.finished) this.finishHandshake()
    return decodeJson(payload)
  }

  /** Encrypts one message into as many frame payloads as it takes. */
  seal(message: unknown): Uint8Array[] {
    const transport = this.mustTransport()
    const bytes = encodeJson(message)
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('message too large')
    const out: Uint8Array[] = []
    for (let at = 0; at === 0 || at < bytes.length; at += CHUNK_BYTES) {
      const piece = bytes.subarray(at, at + CHUNK_BYTES)
      const more = at + CHUNK_BYTES < bytes.length ? 1 : 0
      out.push(transport.encrypt(concat(Uint8Array.of(more), piece)))
    }
    return out
  }

  /**
   * Decrypts one frame payload: the whole message once its last chunk arrives, else undefined.
   * Throws when anything was changed, replayed or reordered; the session is unusable afterwards.
   */
  open(payload: Uint8Array): unknown {
    const transport = this.mustTransport()
    let plain: Uint8Array
    try {
      plain = transport.decrypt(payload)
    } catch (err) {
      this.transport = null
      throw err
    }
    if (plain.length === 0) throw new Error('empty chunk')
    this.pieces.push(plain.subarray(1))
    this.pieceBytes += plain.length - 1
    if (this.pieceBytes > MAX_MESSAGE_BYTES) {
      this.transport = null
      throw new Error('message too large')
    }
    if (plain[0] === 1) return undefined
    const whole = concat(...this.pieces)
    this.pieces = []
    this.pieceBytes = 0
    return decodeJson(whole)
  }

  private finishHandshake(): void {
    this.transport = this.handshake!.transport()
    this.handshake = null
  }

  private mustHandshake(): Handshake {
    if (!this.handshake) throw new Error('the handshake is over')
    return this.handshake
  }

  private mustTransport(): Transport {
    if (!this.transport) throw new Error('the session is not established')
    return this.transport
  }
}

export function encodeJson(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value ?? null))
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(fromUtf8(bytes))
}
