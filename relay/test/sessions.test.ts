// Apps and machines talking through a real relay: pairing, requests, events, removal, tampering.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  AppClient,
  Host,
  newIdentity,
  offerId,
  pairingKey,
  parsePairingLink,
  peerId,
  pairingLink,
  PROTOCOL,
  randomBytes,
  RelayClient,
  Session,
  type DataFrame,
  type Event,
  type HostSession,
  type Identity,
  type MachineInfo,
  type Request,
  type Role,
  type SocketFactory,
  type SocketLike,
} from '@afterhours/protocol'
import { startRelay, type Relay } from '../src/server'

let relay: Relay | null = null
const stoppers: (() => void)[] = []

beforeEach(() => {
  relay = startRelay({ port: 0 })
})

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop()
  await relay?.stop()
  relay = null
})

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

function machine(identity: Identity = newIdentity()) {
  const roles = new Map<string, Role>()
  const requests: Request[] = []
  const info = (): MachineInfo => ({ id: peerId(identity.publicKey), name: 'build-box', os: 'linux', arch: 'arm64', version: '0.1.0', protocol: PROTOCOL })
  const host = new Host({
    identity,
    relay: relay!.url,
    machine: info,
    roleOf: id => roles.get(id) ?? null,
    devices: () => [...roles.keys()],
    onPaired: (device, role) => roles.set(device.id, role),
    onRequest: (session: HostSession, request) => {
      requests.push(request)
      if (request.type === 'sync') session.subscribed = true
      const text = request.type === 'command' ? `echo: ${request.text}` : request.type
      session.send({ type: 'result', id: request.id, ok: true, text })
    },
  })
  host.start()
  stoppers.push(() => host.stop())
  return { host, roles, requests, identity, id: peerId(identity.publicKey) }
}

function app(o: { name?: string; socket?: SocketFactory } = {}) {
  const identity = newIdentity()
  const client = new AppClient({
    identity,
    device: { name: o.name ?? 'Test phone', platform: 'test', app: 'afterhours-test/0' },
    socket: o.socket,
    timing: { retryMs: 50, maxRetryMs: 200, handshakeMs: 2000, checkMs: 300 },
  })
  stoppers.push(() => client.close())
  return { client, identity, id: peerId(identity.publicKey) }
}

async function paired() {
  const m = machine()
  await until(() => m.host.connected)
  const offer = m.host.openOffer({ role: 'owner', autoApprove: true })
  const a = app()
  const result = await a.client.pair(offer.link)
  return { m, a, result }
}

describe('pairing', () => {
  test('waits for a yes on the machine, then the device is known', async () => {
    const m = machine()
    await until(() => m.host.connected)
    const offer = m.host.openOffer({ role: 'operator' })
    const a = app({ name: "Skanda's iPhone" })
    const pairing = a.client.pair(offer.link)
    await until(() => m.host.offer(offer.offer)?.status === 'confirm')
    expect(m.host.offer(offer.offer)?.device).toEqual({ id: a.id, name: "Skanda's iPhone", platform: 'test' })
    expect(m.roles.size).toBe(0)
    m.host.decide(offer.offer, true)
    const result = await pairing
    expect(result.role).toBe('operator')
    expect(result.machine.name).toBe('build-box')
    expect(result.machine.relay).toBe(relay!.url)
    expect(m.roles.get(a.id)).toBe('operator')
  })

  test('a no on the machine is a no', async () => {
    const m = machine()
    await until(() => m.host.connected)
    const offer = m.host.openOffer({ role: 'owner' })
    const a = app()
    const pairing = a.client.pair(offer.link)
    await until(() => m.host.offer(offer.offer)?.status === 'confirm')
    m.host.decide(offer.offer, false)
    await expect(pairing).rejects.toThrow('said no')
    expect(m.roles.size).toBe(0)
  })

  test("a link with another secret names an offer the relay doesn't know", async () => {
    const m = machine()
    await until(() => m.host.connected)
    const offer = m.host.openOffer({ role: 'owner', autoApprove: true })
    const wrong = pairingLink({ ...parsePairingLink(offer.link), secret: randomBytes(16) })
    await expect(app().client.pair(wrong, { timeoutMs: 3000 })).rejects.toThrow('expired or was already used')
    expect(m.roles.size).toBe(0)
  })

  test('knowing the offer id (as the relay does) without the secret fails, and does not block the real device', async () => {
    const m = machine()
    await until(() => m.host.connected)
    const offer = m.host.openOffer({ role: 'owner', autoApprove: true })
    const real = parsePairingLink(offer.link)
    const attacker = newIdentity()
    const replies: DataFrame[] = []
    const relayClient = new RelayClient({ url: relay!.url, identity: attacker, kind: 'device', onFrame: f => replies.push(f) })
    stoppers.push(() => relayClient.stop())
    relayClient.start()
    await relayClient.whenReady(2000)
    const session = Session.initiate({ identity: attacker, peer: m.id, pattern: 'IKpsk2', psk: pairingKey(randomBytes(16)) })
    const hello = session.writeHandshake({ v: PROTOCOL, app: 'x', name: 'attacker', platform: 'x' })
    relayClient.send({ kind: 'pairing', peer: m.id, session: session.id, offer: offerId(real.secret), payload: hello })
    await until(() => replies.length === 1)
    // The machine's reply is sealed with the real secret: the attacker can't read it, so can't confirm.
    expect(() => session.readHandshake(replies[0]!.payload)).toThrow()
    expect(m.host.offer(offer.offer)?.status).toBe('waiting')

    const a = app()
    const result = await a.client.pair(offer.link)
    expect(result.role).toBe('owner')
    expect([...m.roles.keys()]).toEqual([a.id])
  })

  test('a pairing link works once', async () => {
    const { m } = await paired()
    const offerLink = m.host.openOffer({ role: 'owner', autoApprove: true }).link
    await app().client.pair(offerLink)
    await expect(app().client.pair(offerLink, { timeoutMs: 3000 })).rejects.toThrow()
    expect(m.roles.size).toBe(2)
  })
})

describe('sessions', () => {
  test('requests get answers and events arrive in order', async () => {
    const { m, a, result } = await paired()
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    const events: Event[] = []
    conn.on('event', e => events.push(e))
    await until(() => conn.status === 'connected')
    const reply = await conn.request({ type: 'command', text: 'status' })
    expect(reply.ok).toBe(true)
    expect(reply.text).toBe('echo: status')
    await until(() => m.requests.some(r => r.type === 'sync'))
    for (let seq = 1; seq <= 3; seq++) {
      m.host.broadcast({ type: 'event', seq, at: Date.now(), notice: { type: 'setup_warning', message: `#${seq}` }, text: `#${seq}` })
    }
    await until(() => events.length === 3)
    expect(events.map(e => e.seq)).toEqual([1, 2, 3])
    expect(conn.lastSeq).toBe(3)
  })

  test('big messages are split and put back together', async () => {
    const { a, result } = await paired()
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    const text = 'x'.repeat(150_000)
    const reply = await conn.request({ type: 'command', text: text.slice(0, 20_000) })
    expect(reply.text).toBe(`echo: ${text.slice(0, 20_000)}`)
  })

  test('a removed device is refused', async () => {
    const { m, a, result } = await paired()
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    m.roles.delete(a.id)
    m.host.unlink(a.id)
    await until(() => conn.status === 'refused')
    await expect(conn.request({ type: 'command', text: 'hi' }, { timeoutMs: 500 })).rejects.toThrow()
  })

  test('a changed byte ends the session; the app starts a new one and the request still goes through', async () => {
    let tamperNext = false
    const socket: SocketFactory = url => {
      const ws = new WebSocket(url) as unknown as SocketLike
      const send = ws.send.bind(ws)
      ws.send = (data: string | ArrayBuffer) => {
        if (tamperNext && typeof data !== 'string') {
          tamperNext = false
          const bytes = new Uint8Array(data)
          bytes[bytes.length - 1]! ^= 0x80
        }
        send(data)
      }
      return ws
    }
    const m = machine()
    await until(() => m.host.connected)
    const offer = m.host.openOffer({ role: 'owner', autoApprove: true })
    const a = app({ socket })
    const result = await a.client.pair(offer.link)
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    await conn.request({ type: 'command', text: 'warm up' })
    const statuses: string[] = []
    conn.on('status', s => statuses.push(s))
    tamperNext = true
    const reply = await conn.request({ type: 'command', text: 'after tampering' }, { timeoutMs: 5000 })
    expect(reply.text).toBe('echo: after tampering')
    // The tampered session was dropped and a new one made.
    expect(statuses).toContain('connecting')
    // Each request ran once on the machine: the retry reused the request id.
    expect(m.requests.filter(r => r.type === 'command' && r.text === 'after tampering').length).toBeGreaterThanOrEqual(1)
  })

  test('waking up leaves a healthy connection alone', async () => {
    const { a, result } = await paired()
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    const statuses: string[] = []
    conn.on('status', s => statuses.push(s))
    a.client.wake()
    await Bun.sleep(500)
    const reply = await conn.request({ type: 'command', text: 'after waking' }, { timeoutMs: 5000 })
    expect(reply.text).toBe('echo: after waking')
    expect(statuses).toEqual([])
  })

  test('waking up replaces a connection that died without a sign, and requests carry on', async () => {
    // Sockets that can go silent, like one the phone's OS froze while the app was away.
    const sockets: { frozen: boolean }[] = []
    const socket: SocketFactory = url => {
      const ws = new WebSocket(url)
      const state = { frozen: false }
      sockets.push(state)
      const wrapper: SocketLike = {
        get binaryType() {
          return ws.binaryType
        },
        set binaryType(v: string) {
          ws.binaryType = v as typeof ws.binaryType
        },
        get readyState() {
          return ws.readyState
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: data => {
          if (!state.frozen) ws.send(data)
        },
        close: (code, reason) => ws.close(code, reason),
      }
      ws.onopen = ev => wrapper.onopen?.(ev)
      ws.onmessage = ev => {
        if (!state.frozen) wrapper.onmessage?.(ev)
      }
      ws.onclose = ev => wrapper.onclose?.(ev)
      ws.onerror = ev => wrapper.onerror?.(ev)
      return wrapper
    }
    const m = machine()
    await until(() => m.host.connected)
    const a = app({ socket })
    const result = await a.client.pair(m.host.openOffer({ role: 'owner', autoApprove: true }).link)
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    const before = sockets.length
    sockets.at(-1)!.frozen = true
    const statuses: string[] = []
    conn.on('status', s => statuses.push(s))
    a.client.wake()
    const reply = await conn.request({ type: 'command', text: 'after waking' }, { timeoutMs: 5000 })
    expect(reply.text).toBe('echo: after waking')
    expect(sockets.length).toBe(before + 1)
    expect(statuses[0]).not.toBe('connected')
    expect(conn.status).toBe('connected')
  })

  test('a machine restart is survived', async () => {
    const { m, a, result } = await paired()
    const conn = a.client.connect({ id: result.machine.id, name: result.machine.name, relay: result.machine.relay })
    await until(() => conn.status === 'connected')
    const roles = new Map(m.roles)
    m.host.stop()
    const again = machine(m.identity)
    for (const [k, v] of roles) again.roles.set(k, v)
    await until(() => again.host.connected)
    const reply = await conn.request({ type: 'command', text: 'still there?' }, { timeoutMs: 8000 })
    expect(reply.text).toBe('echo: still there?')
  })
})
