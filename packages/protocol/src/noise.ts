// The Noise Protocol Framework (revision 34) with DH = 25519, cipher = ChaChaPoly and
// hash = SHA256, for the handshake patterns below. Apps open sessions to machines with IK (the
// app knows the machine's key) and pair with IKpsk2 (plus the one-time secret from the QR code).
// test/noise.test.ts runs it against the cacophony test vectors.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, utf8 } from './bytes'
import type { DhKeyPair } from './identity'

/** The largest handshake or transport message Noise allows. */
export const MAX_NOISE_MESSAGE = 65535
export const TAG_LENGTH = 16
const DH_LENGTH = 32
const HASH_LENGTH = 32
const EMPTY = new Uint8Array(0)

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

interface Pattern {
  /** Pre-messages: static keys the other side knows before the handshake starts. */
  initiatorKnown: boolean
  responderKnown: boolean
  messages: Token[][]
}

const PATTERNS = {
  NN: { initiatorKnown: false, responderKnown: false, messages: [['e'], ['e', 'ee']] },
  XX: { initiatorKnown: false, responderKnown: false, messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  IK: { initiatorKnown: false, responderKnown: true, messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  IKpsk1: { initiatorKnown: false, responderKnown: true, messages: [['e', 'es', 's', 'ss', 'psk'], ['e', 'ee', 'se']] },
  IKpsk2: { initiatorKnown: false, responderKnown: true, messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se', 'psk']] },
} satisfies Record<string, Pattern>

export type PatternName = keyof typeof PATTERNS

/** ChaChaPoly's nonce: 32 bits of zeros, then the 64-bit counter, little-endian. */
function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12)
  let v = n
  for (let i = 4; i < 12; i++) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  return out
}

function dh(own: DhKeyPair, theirs: Uint8Array): Uint8Array {
  // Throws on an all-zero result, i.e. a low-order public key.
  return x25519.getSharedSecret(own.secretKey, theirs)
}

function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const temp = hmac(sha256, chainingKey, input)
  const one = hmac(sha256, temp, Uint8Array.of(1))
  const two = hmac(sha256, temp, concat(one, Uint8Array.of(2)))
  return outputs === 2 ? [one, two] : [one, two, hmac(sha256, temp, concat(two, Uint8Array.of(3)))]
}

export class CipherState {
  private key: Uint8Array | null = null
  private n = 0

  initializeKey(key: Uint8Array | null): void {
    this.key = key
    this.n = 0
  }

  hasKey(): boolean {
    return this.key !== null
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new Error('nonce exhausted')
    const out = chacha20poly1305(this.key, nonce(this.n), ad).encrypt(plaintext)
    this.n++
    return out
  }

  /** Throws when the message was changed, or isn't the next one in order. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext
    const out = chacha20poly1305(this.key, nonce(this.n), ad).decrypt(ciphertext)
    this.n++
    return out
  }
}

class SymmetricState {
  chainingKey: Uint8Array
  hash: Uint8Array
  readonly cipher = new CipherState()

  constructor(protocolName: string) {
    const name = utf8(protocolName)
    if (name.length <= HASH_LENGTH) {
      this.hash = new Uint8Array(HASH_LENGTH)
      this.hash.set(name)
    } else {
      this.hash = sha256(name)
    }
    this.chainingKey = this.hash.slice()
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf(this.chainingKey, input, 2) as [Uint8Array, Uint8Array]
    this.chainingKey = ck
    this.cipher.initializeKey(key)
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concat(this.hash, data))
  }

  mixKeyAndHash(input: Uint8Array): void {
    const [ck, tempHash, key] = hkdf(this.chainingKey, input, 3) as [Uint8Array, Uint8Array, Uint8Array]
    this.chainingKey = ck
    this.mixHash(tempHash)
    this.cipher.initializeKey(key)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.chainingKey, EMPTY, 2) as [Uint8Array, Uint8Array]
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(k1)
    c2.initializeKey(k2)
    return [c1, c2]
  }
}

/** Both directions of an established session. Messages must arrive in order and unchanged. */
export class Transport {
  constructor(
    private readonly sender: CipherState,
    private readonly receiver: CipherState,
  ) {}

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length + TAG_LENGTH > MAX_NOISE_MESSAGE) throw new Error('message too long for one Noise message')
    return this.sender.encryptWithAd(EMPTY, plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw new Error('message too long')
    return this.receiver.decryptWithAd(EMPTY, ciphertext)
  }
}

export interface HandshakeOptions {
  pattern: PatternName
  initiator: boolean
  prologue?: Uint8Array
  /** Our static key pair. */
  s?: DhKeyPair
  /** The other side's static public key, when the pattern has it known in advance (IK: the responder's). */
  rs?: Uint8Array
  /** A 32-byte pre-shared key, for the psk patterns. */
  psk?: Uint8Array
  /** A fixed ephemeral key pair. Only for test vectors: real handshakes make a fresh one. */
  e?: DhKeyPair
}

export class Handshake {
  readonly initiator: boolean
  private readonly pattern: Pattern
  private readonly pskMode: boolean
  private readonly symmetric: SymmetricState
  private readonly s?: DhKeyPair
  private e?: DhKeyPair
  private rs?: Uint8Array
  private re?: Uint8Array
  private readonly psk?: Uint8Array
  private step = 0

  constructor(o: HandshakeOptions) {
    this.pattern = PATTERNS[o.pattern]
    this.initiator = o.initiator
    this.s = o.s
    this.e = o.e
    this.rs = o.rs
    this.psk = o.psk
    this.pskMode = this.pattern.messages.some(m => m.includes('psk'))
    if (this.pskMode && this.psk?.length !== 32) throw new Error(`${o.pattern} needs a 32-byte pre-shared key`)
    const needsOwnStatic = this.pattern.messages.some((m, i) => (i % 2 === 0) === o.initiator && m.includes('s'))
    if ((needsOwnStatic || (this.pattern.responderKnown && !o.initiator)) && !this.s) throw new Error(`${o.pattern} needs our static key`)
    this.symmetric = new SymmetricState(`Noise_${o.pattern}_25519_ChaChaPoly_SHA256`)
    this.symmetric.mixHash(o.prologue ?? EMPTY)
    if (this.pattern.initiatorKnown) this.symmetric.mixHash(o.initiator ? this.s!.publicKey : this.required(this.rs, 'rs'))
    if (this.pattern.responderKnown) this.symmetric.mixHash(o.initiator ? this.required(this.rs, 'rs') : this.s!.publicKey)
  }

  /** All handshake messages have been written or read. */
  get finished(): boolean {
    return this.step >= this.pattern.messages.length
  }

  /** The other side's static public key, once a message carried it (or it was known in advance). */
  get remoteStatic(): Uint8Array | null {
    return this.rs ?? null
  }

  /** Identifies this handshake; both sides end with the same value. */
  get handshakeHash(): Uint8Array {
    return this.symmetric.hash
  }

  private get ourTurn(): boolean {
    return (this.step % 2 === 0) === this.initiator
  }

  private required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`handshake is missing ${name}`)
    return value
  }

  private mixDh(token: 'ee' | 'es' | 'se' | 'ss'): void {
    const e = () => this.required(this.e, 'e')
    const s = () => this.required(this.s, 's')
    const re = () => this.required(this.re, 're')
    const rs = () => this.required(this.rs, 'rs')
    const i = this.initiator
    const secret =
      token === 'ee' ? dh(e(), re()) : token === 'ss' ? dh(s(), rs()) : token === 'es' ? (i ? dh(e(), rs()) : dh(s(), re())) : i ? dh(s(), re()) : dh(e(), rs())
    this.symmetric.mixKey(secret)
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.finished || !this.ourTurn) throw new Error("it isn't our turn to write a handshake message")
    const parts: Uint8Array[] = []
    for (const token of this.pattern.messages[this.step]!) {
      if (token === 'e') {
        if (!this.e) {
          const secretKey = x25519.utils.randomSecretKey()
          this.e = { secretKey, publicKey: x25519.getPublicKey(secretKey) }
        }
        parts.push(this.e.publicKey)
        this.symmetric.mixHash(this.e.publicKey)
        if (this.pskMode) this.symmetric.mixKey(this.e.publicKey)
      } else if (token === 's') {
        parts.push(this.symmetric.encryptAndHash(this.required(this.s, 's').publicKey))
      } else if (token === 'psk') {
        this.symmetric.mixKeyAndHash(this.psk!)
      } else {
        this.mixDh(token)
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload))
    this.step++
    const message = concat(...parts)
    if (message.length > MAX_NOISE_MESSAGE) throw new Error('handshake message too long')
    return message
  }

  /** Returns the payload. Throws when the message is malformed or fails authentication. */
  readMessage(message: Uint8Array): Uint8Array {
    if (this.finished || this.ourTurn) throw new Error("it isn't our turn to read a handshake message")
    if (message.length > MAX_NOISE_MESSAGE) throw new Error('handshake message too long')
    let at = 0
    const take = (n: number) => {
      if (at + n > message.length) throw new Error('handshake message too short')
      const out = message.slice(at, at + n)
      at += n
      return out
    }
    for (const token of this.pattern.messages[this.step]!) {
      if (token === 'e') {
        this.re = take(DH_LENGTH)
        this.symmetric.mixHash(this.re)
        if (this.pskMode) this.symmetric.mixKey(this.re)
      } else if (token === 's') {
        this.rs = this.symmetric.decryptAndHash(take(DH_LENGTH + (this.symmetric.cipher.hasKey() ? TAG_LENGTH : 0)))
      } else if (token === 'psk') {
        this.symmetric.mixKeyAndHash(this.psk!)
      } else {
        this.mixDh(token)
      }
    }
    const payload = this.symmetric.decryptAndHash(message.slice(at))
    this.step++
    return payload
  }

  /** The transport, once the handshake is finished. */
  transport(): Transport {
    if (!this.finished) throw new Error('the handshake is not finished')
    const [c1, c2] = this.symmetric.split()
    return this.initiator ? new Transport(c1, c2) : new Transport(c2, c1)
  }
}
