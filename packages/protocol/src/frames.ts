// What travels between a peer (an app or a machine) and the relay. Control messages are JSON text
// frames the relay reads. Data frames are binary: a small header the relay routes by, and an
// end-to-end encrypted payload it can't read.

import { z } from 'zod'
import { fromBase64url, toBase64url, utf8 } from './bytes'
import { peerId } from './identity'

export const RELAY_PROTOCOL_VERSION = 1
export const SESSION_ID_LENGTH = 16
export const OFFER_ID_LENGTH = 16
/** One Noise message (64 KiB at most) plus the header, with room to spare. */
export const MAX_FRAME_BYTES = 70_000

export type PeerKind = 'agent' | 'device'
/** `session`: a paired app and machine. `pairing`: a pairing in progress. `reset`: "that session is gone, start over". */
export type FrameKind = 'session' | 'pairing' | 'reset'

const KIND_BYTE: Record<FrameKind, number> = { session: 1, pairing: 2, reset: 3 }
const BYTE_KIND = new Map(Object.entries(KIND_BYTE).map(([k, v]) => [v, k as FrameKind]))

export interface DataFrame {
  kind: FrameKind
  /** The recipient when sending; the relay replaces it with the sender before delivering. */
  peer: string
  session: Uint8Array
  /** Pairing frames name the pairing offer (derived from the QR code's secret). */
  offer?: Uint8Array
  payload: Uint8Array
}

// version(1) kind(1) peer(32) session(16) [offer(16)] payload
export function encodeFrame(f: DataFrame): Uint8Array {
  const peer = fromBase64url(f.peer)
  if (peer.length !== 32) throw new Error('bad peer id')
  if (f.session.length !== SESSION_ID_LENGTH) throw new Error('bad session id')
  const offer = f.kind === 'pairing' ? f.offer : undefined
  if (f.kind === 'pairing' && offer?.length !== OFFER_ID_LENGTH) throw new Error('a pairing frame needs its offer id')
  const header = 2 + 32 + SESSION_ID_LENGTH + (offer ? OFFER_ID_LENGTH : 0)
  const out = new Uint8Array(header + f.payload.length)
  out[0] = RELAY_PROTOCOL_VERSION
  out[1] = KIND_BYTE[f.kind]
  out.set(peer, 2)
  out.set(f.session, 34)
  if (offer) out.set(offer, 34 + SESSION_ID_LENGTH)
  out.set(f.payload, header)
  if (out.length > MAX_FRAME_BYTES) throw new Error('frame too large')
  return out
}

export function decodeFrame(bytes: Uint8Array): DataFrame {
  if (bytes.length > MAX_FRAME_BYTES) throw new Error('frame too large')
  if (bytes.length < 2 + 32 + SESSION_ID_LENGTH || bytes[0] !== RELAY_PROTOCOL_VERSION) throw new Error('not a data frame')
  const kind = BYTE_KIND.get(bytes[1]!)
  if (!kind) throw new Error('unknown frame kind')
  const peer = peerId(bytes.slice(2, 34))
  const session = bytes.slice(34, 34 + SESSION_ID_LENGTH)
  let at = 34 + SESSION_ID_LENGTH
  let offer: Uint8Array | undefined
  if (kind === 'pairing') {
    if (bytes.length < at + OFFER_ID_LENGTH) throw new Error('pairing frame without an offer id')
    offer = bytes.slice(at, at + OFFER_ID_LENGTH)
    at += OFFER_ID_LENGTH
  }
  return { kind, peer, session, offer, payload: bytes.slice(at) }
}

const PeerIdText = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const OfferText = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
const SessionText = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/** Peer → relay. */
export const PeerControl = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), v: z.literal(RELAY_PROTOCOL_VERSION), id: PeerIdText, kind: z.enum(['agent', 'device']), sig: z.string().max(100) }),
  z.object({ t: z.literal('ping') }),
  /** Machines only: the complete list of apps allowed to reach it (sent after every sign-in). */
  z.object({ t: z.literal('links'), peers: z.array(PeerIdText).max(1000) }),
  z.object({ t: z.literal('link'), peer: PeerIdText }),
  /** Machines drop an app; an app drops a machine. */
  z.object({ t: z.literal('unlink'), peer: PeerIdText }),
  /** Machines only: a pairing offer apps may use until `expires` (ms since 1970). */
  z.object({ t: z.literal('offer'), offer: OfferText, expires: z.number().int() }),
  z.object({ t: z.literal('offer.close'), offer: OfferText }),
])
export type PeerControl = z.infer<typeof PeerControl>

/** Relay → peer. */
export const RelayControl = z.discriminatedUnion('t', [
  z.object({ t: z.literal('challenge'), v: z.literal(RELAY_PROTOCOL_VERSION), nonce: z.string().max(100) }),
  z.object({ t: z.literal('ready'), id: PeerIdText, time: z.number() }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('presence'), peer: PeerIdText, online: z.boolean() }),
  z.object({
    t: z.literal('undeliverable'),
    peer: PeerIdText,
    session: SessionText,
    reason: z.enum(['offline', 'not-linked', 'no-offer', 'busy']),
  }),
  z.object({ t: z.literal('error'), code: z.string().max(40), message: z.string().max(500) }),
])
export type RelayControl = z.infer<typeof RelayControl>

/** What a peer signs to prove it holds its key: fresh for every connection, so it can't be replayed. */
export function authMessage(nonce: string, kind: PeerKind): Uint8Array {
  return utf8(`afterhours-relay-auth-v1\n${kind}\n${nonce}`)
}

export const sessionText = (id: Uint8Array): string => toBase64url(id)
