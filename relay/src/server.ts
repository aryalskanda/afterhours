// The relay: apps and machines connect out to it and it forwards their frames. It checks who is
// connecting (a signature with their key), forwards only between a machine and the apps the
// machine linked (or an app holding a live pairing offer), and never sees inside a frame: those
// are end-to-end encrypted. It stores keys, links and connection times; nothing else.
// It can also serve the app's web build (`appDir`), for a machine that runs its own relay and opens
// the app inside Telegram: the same address then has the app and its relay.

import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Server, ServerWebSocket } from 'bun'
import {
  authMessage,
  decodeFrame,
  encodeFrame,
  fromBase64url,
  MAX_FRAME_BYTES,
  PeerControl,
  publicKeyOf,
  randomBytes,
  RELAY_PROTOCOL_VERSION,
  sessionText,
  toBase64url,
  verify,
  type DataFrame,
  type PeerKind,
  type RelayControl,
} from '@afterhours/protocol'

export interface RelayLimits {
  connectionsPerPeer: number
  framesPerSecond: number
  bytesPerSecond: number
  /** Bursts up to this many seconds' worth are allowed. */
  burstSeconds: number
  authTimeoutMs: number
  offersPerMachine: number
  linksPerMachine: number
  /** Longest a pairing offer may stay open. */
  offerMaxMs: number
  /** Machines carry the traffic of all their devices on one connection, so they get this many times more. */
  machineRateScale: number
}

const DEFAULT_LIMITS: RelayLimits = {
  connectionsPerPeer: 4,
  framesPerSecond: 200,
  bytesPerSecond: 4 * 1024 * 1024,
  burstSeconds: 5,
  authTimeoutMs: 10_000,
  offersPerMachine: 20,
  linksPerMachine: 1000,
  offerMaxMs: 15 * 60_000,
  machineRateScale: 5,
}

export interface RelayOptions {
  /** 0 picks a free port. */
  port?: number
  hostname?: string
  /** SQLite file for keys and links; ':memory:' for tests. */
  db?: string
  log?: (line: string) => void
  now?: () => number
  limits?: Partial<RelayLimits>
  /** The app's web build (the app's dist-web), served at every other address. */
  appDir?: string
}

export interface Relay {
  url: string
  port: number
  stats(): { peers: number; connections: number; links: number; offers: number }
  stop(): Promise<void>
}

interface Conn {
  id: string | null
  kind: PeerKind | null
  nonce: string
  connectedAt: number
  frames: number
  bytes: number
  refilledAt: number
  warnedAt: number
  authTimer: ReturnType<typeof setTimeout> | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  machine TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (machine, device)
);
CREATE INDEX IF NOT EXISTS links_device ON links (device);
`

/**
 * What pages from `appDir` may do: their own scripts (and Telegram's, which the app loads only
 * inside Telegram), connections to relays, and showing inside Telegram's web client.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' wss:",
  "frame-ancestors 'self' https://web.telegram.org",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ')

/** Search engines are told to skip everything this serves, while the app is in development. */
const NO_INDEX = 'noindex, nofollow, noarchive'

/**
 * A file from the app's build, or the app itself for any address that isn't a file (one page app).
 * Pairing links arrive in the query string: it is never logged, and no referrer carries it on.
 */
export function appResponse(dir: string, req: Request): Response {
  const headers: Record<string, string> = {
    'x-robots-tag': NO_INDEX,
    'content-security-policy': APP_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Not here.\n', { status: 405, headers })
  const root = resolve(dir)
  let path: string
  try {
    path = resolve(join(root, decodeURIComponent(new URL(req.url).pathname)))
  } catch {
    return new Response('Bad address.\n', { status: 400, headers })
  }
  if (path !== root && !path.startsWith(root + sep)) return new Response('Not here.\n', { status: 404, headers })
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (isFile(path)) {
    // Bundles and fonts have their content's hash in the name, so they never change.
    const hashed = /[\/](_expo[\/]static|assets)[\/]/.test(path.slice(root.length))
    headers['cache-control'] = hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
    return new Response(Bun.file(path), { headers })
  }
  const index = join(root, 'index.html')
  // An address with a file extension that isn't there is a missing file, not a screen.
  if (/\.[A-Za-z0-9]{1,8}$/.test(path) || !isFile(index)) return new Response('Not here.\n', { status: 404, headers })
  headers['cache-control'] = 'no-cache'
  headers['content-type'] = 'text/html; charset=utf-8'
  return new Response(Bun.file(index), { headers })
}

export function startRelay(o: RelayOptions = {}): Relay {
  const limits = { ...DEFAULT_LIMITS, ...o.limits }
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const db = new Database(o.db ?? ':memory:', { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 3000;')
  db.exec(SCHEMA)

  /** Signed-in connections per peer, oldest first. */
  const online = new Map<string, ServerWebSocket<Conn>[]>()
  const kinds = new Map<string, PeerKind>(db.query<{ id: string; kind: PeerKind }, []>('SELECT id, kind FROM peers').all().map(r => [r.id, r.kind]))
  const machineLinks = new Map<string, Set<string>>()
  const deviceLinks = new Map<string, Set<string>>()
  for (const row of db.query<{ machine: string; device: string }, []>('SELECT machine, device FROM links').all()) addLinkCache(row.machine, row.device)
  /**
   * Machines that sent their link list since the relay started. Until a machine has, a pair that
   * isn't linked may only not be linked again yet (a relay that keeps links in memory), so frames
   * between them are "offline" rather than "not-linked", which an app takes as being unpaired.
   */
  const listed = new Set<string>()
  /** Open pairing offers: offer id → machine. */
  const offers = new Map<string, { machine: string; expires: number }>()
  /** Apps in the middle of pairing, per machine: the machine may answer them before any link exists. */
  const pairing = new Map<string, Map<string, number>>()

  function addLinkCache(machine: string, device: string): void {
    if (!machineLinks.has(machine)) machineLinks.set(machine, new Set())
    if (!deviceLinks.has(device)) deviceLinks.set(device, new Set())
    machineLinks.get(machine)!.add(device)
    deviceLinks.get(device)!.add(machine)
  }

  function dropLinkCache(machine: string, device: string): void {
    machineLinks.get(machine)?.delete(device)
    deviceLinks.get(device)?.delete(machine)
  }

  const linked = (a: string, b: string) => machineLinks.get(a)?.has(b) === true || machineLinks.get(b)?.has(a) === true
  const counterparts = (id: string) => [...(machineLinks.get(id) ?? []), ...(deviceLinks.get(id) ?? [])]

  function pairingAllowed(machine: string, device: string): boolean {
    const until = pairing.get(machine)?.get(device)
    return until !== undefined && until > now()
  }

  function sendControl(ws: ServerWebSocket<Conn>, message: RelayControl): void {
    ws.send(JSON.stringify(message))
  }

  function newest(id: string): ServerWebSocket<Conn> | undefined {
    const list = online.get(id)
    return list?.[list.length - 1]
  }

  function announce(id: string, isOnline: boolean): void {
    for (const other of counterparts(id)) {
      const ws = newest(other)
      if (ws) sendControl(ws, { t: 'presence', peer: id, online: isOnline })
    }
  }

  function signIn(ws: ServerWebSocket<Conn>, message: Extract<PeerControl, { t: 'auth' }>): void {
    let key: Uint8Array
    let signature: Uint8Array
    try {
      key = publicKeyOf(message.id)
      signature = fromBase64url(message.sig)
    } catch {
      return refuse(ws, 'bad-auth', 'That key is not valid.')
    }
    if (!verify(key, authMessage(ws.data.nonce, message.kind), signature)) return refuse(ws, 'bad-auth', 'The signature does not match the key.')
    const known = kinds.get(message.id)
    if (known && known !== message.kind) return refuse(ws, 'kind-mismatch', `This key belongs to a ${known === 'agent' ? 'machine' : 'device'}.`)
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
    ws.data.authTimer = null
    ws.data.id = message.id
    ws.data.kind = message.kind
    const t = now()
    if (!known) kinds.set(message.id, message.kind)
    db.query('INSERT INTO peers (id, kind, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen').run(message.id, message.kind, t, t)
    const list = online.get(message.id) ?? []
    // Over the limit: the oldest connection is most likely a dead one that hasn't timed out yet.
    while (list.length >= limits.connectionsPerPeer) list.shift()?.close(4000, 'replaced by a newer connection')
    list.push(ws)
    online.set(message.id, list)
    sendControl(ws, { t: 'ready', id: message.id, time: t })
    if (list.length === 1) announce(message.id, true)
    for (const other of counterparts(message.id)) if (online.has(other)) sendControl(ws, { t: 'presence', peer: other, online: true })
  }

  function refuse(ws: ServerWebSocket<Conn>, code: string, message: string): void {
    sendControl(ws, { t: 'error', code, message })
    ws.close(4001, code)
  }

  function onControl(ws: ServerWebSocket<Conn>, text: string): void {
    let parsed: PeerControl
    try {
      parsed = PeerControl.parse(JSON.parse(text))
    } catch {
      return sendControl(ws, { t: 'error', code: 'invalid', message: 'Unknown message.' })
    }
    const id = ws.data.id
    if (!id) {
      if (parsed.t === 'auth') signIn(ws, parsed)
      else refuse(ws, 'not-signed-in', 'Sign in first.')
      return
    }
    const isMachine = ws.data.kind === 'agent'
    switch (parsed.t) {
      case 'auth':
        return
      case 'ping':
        return sendControl(ws, { t: 'pong' })
      case 'links': {
        if (!isMachine) return sendControl(ws, { t: 'error', code: 'forbidden', message: 'Only machines set links.' })
        const wanted = new Set(parsed.peers.filter(p => kinds.get(p) !== 'agent').slice(0, limits.linksPerMachine))
        const current = machineLinks.get(id) ?? new Set<string>()
        const added = [...wanted].filter(device => !current.has(device))
        const t = now()
        db.transaction(() => {
          for (const device of current) if (!wanted.has(device)) db.query('DELETE FROM links WHERE machine = ? AND device = ?').run(id, device)
          for (const device of wanted) db.query('INSERT OR IGNORE INTO links (machine, device, created_at) VALUES (?, ?, ?)').run(id, device, t)
        })()
        for (const device of [...current]) if (!wanted.has(device)) dropLinkCache(id, device)
        for (const device of wanted) addLinkCache(id, device)
        listed.add(id)
        // Newly linked pairs hear about each other, as they would have when signing in.
        for (const device of added) {
          const other = newest(device)
          if (!other) continue
          sendControl(other, { t: 'presence', peer: id, online: true })
          sendControl(ws, { t: 'presence', peer: device, online: true })
        }
        return
      }
      case 'link': {
        if (!isMachine) return sendControl(ws, { t: 'error', code: 'forbidden', message: 'Only machines add links.' })
        if (kinds.get(parsed.peer) === 'agent') return sendControl(ws, { t: 'error', code: 'invalid', message: 'That key is a machine.' })
        if ((machineLinks.get(id)?.size ?? 0) >= limits.linksPerMachine) return sendControl(ws, { t: 'error', code: 'limit', message: 'Too many devices.' })
        db.query('INSERT OR IGNORE INTO links (machine, device, created_at) VALUES (?, ?, ?)').run(id, parsed.peer, now())
        addLinkCache(id, parsed.peer)
        const device = newest(parsed.peer)
        if (device) sendControl(device, { t: 'presence', peer: id, online: true })
        return
      }
      case 'unlink': {
        const [machine, device] = isMachine ? [id, parsed.peer] : [parsed.peer, id]
        db.query('DELETE FROM links WHERE machine = ? AND device = ?').run(machine, device)
        dropLinkCache(machine, device)
        return
      }
      case 'offer': {
        if (!isMachine) return sendControl(ws, { t: 'error', code: 'forbidden', message: 'Only machines open pairing offers.' })
        const t = now()
        for (const [key, offer] of offers) if (offer.expires <= t) offers.delete(key)
        const mine = [...offers.entries()].filter(([, offer]) => offer.machine === id)
        if (mine.length >= limits.offersPerMachine) offers.delete(mine[0]![0])
        offers.set(parsed.offer, { machine: id, expires: Math.min(parsed.expires, t + limits.offerMaxMs) })
        return
      }
      case 'offer.close': {
        if (offers.get(parsed.offer)?.machine === id) offers.delete(parsed.offer)
        return
      }
    }
  }

  /** Token buckets per connection; false = over the limit, drop the frame. */
  function withinRate(ws: ServerWebSocket<Conn>, size: number): boolean {
    const c = ws.data
    const t = now()
    const elapsed = (t - c.refilledAt) / 1000
    const scale = c.kind === 'agent' ? limits.machineRateScale : 1
    c.refilledAt = t
    c.frames = Math.min(limits.framesPerSecond * scale * limits.burstSeconds, c.frames + elapsed * limits.framesPerSecond * scale)
    c.bytes = Math.min(limits.bytesPerSecond * scale * limits.burstSeconds, c.bytes + elapsed * limits.bytesPerSecond * scale)
    if (c.frames < 1 || c.bytes < size) {
      if (t - c.warnedAt > 1000) {
        c.warnedAt = t
        sendControl(ws, { t: 'error', code: 'rate-limited', message: 'Too many messages; some were dropped.' })
      }
      return false
    }
    c.frames -= 1
    c.bytes -= size
    return true
  }

  function onData(ws: ServerWebSocket<Conn>, bytes: Uint8Array): void {
    const from = ws.data.id
    if (!from) return refuse(ws, 'not-signed-in', 'Sign in first.')
    if (!withinRate(ws, bytes.length)) return
    let frame: DataFrame
    try {
      frame = decodeFrame(bytes)
    } catch {
      return sendControl(ws, { t: 'error', code: 'invalid', message: 'Malformed frame.' })
    }
    const to = frame.peer
    const fromMachine = ws.data.kind === 'agent'
    const undeliverable = (reason: 'offline' | 'not-linked' | 'no-offer' | 'busy') =>
      sendControl(ws, { t: 'undeliverable', peer: to, session: sessionText(frame.session), reason })

    let allowed = linked(from, to)
    if (frame.kind === 'pairing' && !fromMachine) {
      const offer = frame.offer ? offers.get(toBase64url(frame.offer)) : undefined
      if (!offer || offer.machine !== to || offer.expires <= now()) return undeliverable('no-offer')
      if (!pairing.has(to)) pairing.set(to, new Map())
      pairing.get(to)!.set(from, offer.expires + 60_000)
      allowed = true
    } else if (!allowed && frame.kind !== 'session') {
      // Pairing replies and resets travel between a machine and an app that is pairing with it.
      allowed = fromMachine ? pairingAllowed(from, to) : pairingAllowed(to, from)
    }
    if (!allowed) return undeliverable(listed.has(fromMachine ? from : to) ? 'not-linked' : 'offline')

    const target = newest(to)
    if (!target) return undeliverable('offline')
    const status = target.send(encodeFrame({ ...frame, peer: from }))
    if (status === 0) undeliverable('offline')
  }

  function prune(): void {
    const t = now()
    for (const [key, offer] of offers) if (offer.expires <= t) offers.delete(key)
    for (const [machine, devices] of pairing) {
      for (const [device, until] of devices) if (until <= t) devices.delete(device)
      if (devices.size === 0) pairing.delete(machine)
    }
  }
  const pruneTimer = setInterval(prune, 60_000)

  const server: Server<Conn> = Bun.serve<Conn>({
    port: o.port ?? 8787,
    hostname: o.hostname ?? '0.0.0.0',
    fetch(req, srv) {
      const url = new URL(req.url)
      // Not for search engines yet: neither the pages nor anything else this serves.
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain', 'x-robots-tag': NO_INDEX } })
      if (url.pathname === '/health') {
        return Response.json({ ok: true, protocol: RELAY_PROTOCOL_VERSION, ...stats() })
      }
      if (url.pathname === '/v1' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const data: Conn = { id: null, kind: null, nonce: '', connectedAt: now(), frames: 0, bytes: 0, refilledAt: now(), warnedAt: 0, authTimer: null }
        data.frames = limits.framesPerSecond * limits.burstSeconds
        data.bytes = limits.bytesPerSecond * limits.burstSeconds
        if (srv.upgrade(req, { data })) return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      if (o.appDir) return appResponse(o.appDir, req)
      return new Response('Afterhours relay. Apps and machines connect to /v1.\n', { headers: { 'content-type': 'text/plain', 'x-robots-tag': NO_INDEX } })
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES + 1024,
      idleTimeout: 120,
      backpressureLimit: 8 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      sendPings: true,
      open(ws) {
        ws.data.nonce = toBase64url(randomBytes(24))
        ws.data.authTimer = setTimeout(() => refuse(ws, 'auth-timeout', 'Sign in took too long.'), limits.authTimeoutMs)
        sendControl(ws, { t: 'challenge', v: RELAY_PROTOCOL_VERSION, nonce: ws.data.nonce })
      },
      message(ws, message) {
        try {
          if (typeof message === 'string') onControl(ws, message)
          else onData(ws, new Uint8Array(message.buffer, message.byteOffset, message.byteLength))
        } catch (err) {
          log(`error handling a message: ${err instanceof Error ? err.message : err}`)
        }
      },
      close(ws) {
        if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
        const id = ws.data.id
        if (!id) return
        const list = (online.get(id) ?? []).filter(c => c !== ws)
        if (list.length > 0) {
          online.set(id, list)
          return
        }
        online.delete(id)
        db.query('UPDATE peers SET last_seen = ? WHERE id = ?').run(now(), id)
        announce(id, false)
      },
    },
  })

  function stats() {
    let connections = 0
    for (const list of online.values()) connections += list.length
    let links = 0
    for (const set of machineLinks.values()) links += set.size
    return { peers: online.size, connections, links, offers: offers.size }
  }

  const port = server.port ?? 0
  const bound = o.hostname ?? '0.0.0.0'
  const host = bound === '0.0.0.0' ? '127.0.0.1' : bound
  log(`relay listening on ${bound}:${port}`)
  return {
    url: `ws://${host}:${port}/v1`,
    port,
    stats,
    async stop() {
      clearInterval(pruneTimer)
      // Bun 1.3.3: once the server has closed a WebSocket itself, the promise from stop(true) never
      // settles, although the server does stop and frees the port.
      await Promise.race([server.stop(true), Bun.sleep(500)])
      db.close()
    },
  }
}
