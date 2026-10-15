// Every app install and every machine has one Ed25519 key pair. Its public key is the peer's id
// on the relay and in pairing links. Noise sessions use the X25519 form of the same key, so one
// id names one Noise key and nobody can pair an id with someone else's key. (Using one key pair
// for Ed25519 signatures and X25519 key agreement is analysed in Thormarker, "On using the same
// key pair for Ed25519 and an X25519 based KEM", 2021.)

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, fromBase64url, toBase64url, toHex, utf8 } from './bytes'

export interface Identity {
  /** The 32-byte Ed25519 seed. Never leaves the device. */
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export interface DhKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function newIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen()
  return { secretKey, publicKey }
}

export function identityFromSecret(secretKey: Uint8Array): Identity {
  if (secretKey.length !== 32) throw new Error('an identity secret is 32 bytes')
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

/** The public key as text: 43 base64url characters. */
export function peerId(publicKey: Uint8Array): string {
  return toBase64url(publicKey)
}

/** The public key in a peer id, checked to be a valid Ed25519 point. */
export function publicKeyOf(id: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('not a peer id')
  const key = fromBase64url(id)
  // One spelling per key: unused low bits in the last character must be zero.
  if (toBase64url(key) !== id) throw new Error('not a peer id')
  ed25519.Point.fromBytes(key) // throws when it isn't a point on the curve
  return key
}

export function isPeerId(id: string): boolean {
  try {
    publicKeyOf(id)
    return true
  } catch {
    return false
  }
}

/** The X25519 key pair Noise uses for this identity. */
export function dhKeyPair(id: Identity): DhKeyPair {
  const secretKey = ed25519.utils.toMontgomerySecret(id.secretKey)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** The X25519 public key Noise sees for a peer id. */
export function dhPublicKey(id: string): Uint8Array {
  return ed25519.utils.toMontgomery(publicKeyOf(id))
}

export function sign(id: Identity, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, id.secretKey)
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

/** What people compare by eye, e.g. "4F2A 9C1B 77E0 D3A8". */
export function fingerprint(id: string): string {
  const hex = toHex(sha256(concat(utf8('afterhours-fingerprint-v1\n'), publicKeyOf(id))).slice(0, 8)).toUpperCase()
  return hex.match(/.{4}/g)!.join(' ')
}

/** Text for a 0600 file or a keychain item. */
export function encodeIdentity(id: Identity): string {
  return JSON.stringify({ v: 1, secretKey: toBase64url(id.secretKey) })
}

export function decodeIdentity(text: string): Identity {
  const parsed = JSON.parse(text) as { v?: number; secretKey?: string }
  if (parsed.v !== 1 || typeof parsed.secretKey !== 'string') throw new Error('not an identity file')
  return identityFromSecret(fromBase64url(parsed.secretKey))
}
