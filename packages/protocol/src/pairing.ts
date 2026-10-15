// Pairing links: what `cq pair` shows as a QR code and as text to paste. They carry the relay,
// the machine's key and a one-time secret; the secret never goes to the relay, only a hash of it
// that names the offer.

import { sha256 } from '@noble/hashes/sha2.js'
import { concat, fromBase64url, toBase64url, utf8 } from './bytes'
import { OFFER_ID_LENGTH } from './frames'
import { isPeerId } from './identity'

export const PAIRING_SECRET_BYTES = 16
export const PAIRING_TTL_MS = 10 * 60_000
const PREFIX = 'afterhours://pair?'

export interface PairingOffer {
  /** ws:// or wss:// */
  relay: string
  /** The machine's peer id. */
  machine: string
  /** The machine's name, shown while pairing. */
  name: string
  secret: Uint8Array
  /** ms since 1970 */
  expires: number
}

export function pairingLink(o: PairingOffer): string {
  const fields: [string, string][] = [
    ['r', o.relay],
    ['m', o.machine],
    ['s', toBase64url(o.secret)],
    ['n', o.name],
    ['x', String(Math.floor(o.expires / 1000))],
  ]
  return PREFIX + fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

/** Reads a pairing link, alone or inside pasted text. Throws a message people can act on. */
export function parsePairingLink(text: string): PairingOffer {
  const match = /afterhours:\/\/pair\?[^\s"'<>]+/.exec(text)
  if (!match) throw new Error("That isn't a pairing link. Run cq pair on the machine to get one.")
  const fields = new Map<string, string>()
  for (const part of match[0].slice(PREFIX.length).split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    try {
      fields.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)))
    } catch {
      throw new Error('That pairing link is damaged.')
    }
  }
  const relay = fields.get('r') ?? ''
  const machine = fields.get('m') ?? ''
  const name = (fields.get('n') ?? '').slice(0, 80)
  const expires = Number(fields.get('x')) * 1000
  let secret: Uint8Array
  try {
    secret = fromBase64url(fields.get('s') ?? '')
  } catch {
    throw new Error('That pairing link is damaged.')
  }
  if (!/^wss?:\/\/[^\s/]+/.test(relay)) throw new Error('That pairing link has no relay address.')
  if (!isPeerId(machine) || secret.length !== PAIRING_SECRET_BYTES || !Number.isFinite(expires)) {
    throw new Error('That pairing link is damaged.')
  }
  return { relay, machine, name: name || 'machine', secret, expires }
}

/** Names the offer on the relay. One-way: the relay can't get the secret back from it. */
export function offerId(secret: Uint8Array): Uint8Array {
  return sha256(concat(utf8('afterhours-offer-v1'), secret)).slice(0, OFFER_ID_LENGTH)
}

/** The Noise pre-shared key for the pairing handshake. */
export function pairingKey(secret: Uint8Array): Uint8Array {
  return sha256(concat(utf8('afterhours-psk-v1'), secret))
}
