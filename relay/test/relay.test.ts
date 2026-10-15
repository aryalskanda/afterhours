import { afterEach, describe, expect, test } from 'bun:test'
import {
  authMessage,
  newIdentity,
  offerId,
  peerId,
  randomBytes,
  RelayClient,
  sign,
  toBase64url,
  type DataFrame,
  type Identity,
  type PeerKind,
} from '@afterhours/protocol'
import { startRelay, type Relay } from '../src/server'

let relay: Relay | null = null
const clients: RelayClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop()
  await relay?.stop()
  relay = null
})

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

function peer(kind: PeerKind, identity: Identity = newIdentity()) {
  const frames: DataFrame[] = []
  const undeliverable: string[] = []
  const presence: [string, boolean][] = []
  const client = new RelayClient({
    url: relay!.url,
    identity,
    kind,
    onFrame: f => frames.push(f),
    onUndeliverable: (_p, _s, reason) => undeliverable.push(reason),
    onPresence: (p, online) => presence.push([p, online]),
  })
  clients.push(client)
  client.start()
  return { client, identity, id: peerId(identity.publicKey), frames, undeliverable, presence }
}

const frame = (kind: DataFrame['kind'], to: string, payload = [1, 2, 3], offer?: Uint8Array): DataFrame => ({
  kind,
  peer: to,
  session: randomBytes(16),
  offer,
  payload: Uint8Array.from(payload),
})

describe('relay', () => {
  test('peers sign in with their key', async () => {
    relay = startRelay({ port: 0 })
    const machine = peer('agent')
    await machine.client.whenReady(2000)
    expect(relay.stats().peers).toBe(1)
  })

  test('a wrong signature is refused', async () => {
    relay = startRelay({ port: 0 })
    const who = newIdentity()
    const someoneElse = newIdentity()
    const ws = new WebSocket(relay.url)
    const messages: { t: string; code?: string }[] = []
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data))
      messages.push(m)
      if (m.t === 'challenge') {
        // Signed with a different key than the one it claims.
        const sig = sign(someoneElse, authMessage(m.nonce, 'device'))
        ws.send(JSON.stringify({ t: 'auth', v: 1, id: peerId(who.publicKey), kind: 'device', sig: toBase64url(sig) }))
      }
    }
    await until(() => messages.some(m => m.t === 'error'))
    expect(messages.find(m => m.t === 'error')?.code).toBe('bad-auth')
    expect(messages.some(m => m.t === 'ready')).toBe(false)
  })

  test('a key is either a machine or a device, never both', async () => {
    relay = startRelay({ port: 0 })
    const identity = newIdentity()
    const asMachine = peer('agent', identity)
    await asMachine.client.whenReady(2000)
    asMachine.client.stop()
    const asDevice = peer('device', identity)
    await expect(asDevice.client.whenReady(500)).rejects.toThrow()
  })

  test('frames go only between a machine and the devices it linked', async () => {
    relay = startRelay({ port: 0 })
    const machine = peer('agent')
    const phone = peer('device')
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000)])

    phone.client.send(frame('session', machine.id))
    await until(() => phone.undeliverable.length === 1)
    expect(phone.undeliverable[0]).toBe('not-linked')
    expect(machine.frames).toHaveLength(0)

    machine.client.control({ t: 'link', peer: phone.id })
    await until(() => phone.presence.some(([p, on]) => p === machine.id && on))
    phone.client.send(frame('session', machine.id, [9, 9]))
    await until(() => machine.frames.length === 1)
    // Delivered with the sender in place of the recipient.
    expect(machine.frames[0]!.peer).toBe(phone.id)
    expect([...machine.frames[0]!.payload]).toEqual([9, 9])

    machine.client.send(frame('session', phone.id, [7]))
    await until(() => phone.frames.length === 1)
    expect(phone.frames[0]!.peer).toBe(machine.id)

    machine.client.control({ t: 'unlink', peer: phone.id })
    await Bun.sleep(50)
    phone.client.send(frame('session', machine.id))
    await until(() => phone.undeliverable.length === 2)
    expect(phone.undeliverable[1]).toBe('not-linked')
  })

  test('the machine\'s link list replaces the old one', async () => {
    relay = startRelay({ port: 0 })
    const machine = peer('agent')
    const a = peer('device')
    const b = peer('device')
    await Promise.all([machine.client.whenReady(2000), a.client.whenReady(2000), b.client.whenReady(2000)])
    machine.client.control({ t: 'links', peers: [a.id] })
    await Bun.sleep(50)
    machine.client.control({ t: 'links', peers: [b.id] })
    await Bun.sleep(50)
    a.client.send(frame('session', machine.id))
    b.client.send(frame('session', machine.id))
    await until(() => machine.frames.length === 1 && a.undeliverable.length === 1)
    expect(machine.frames[0]!.peer).toBe(b.id)
  })

  test('a pairing offer lets one unlinked device reach the machine, and the machine answer it', async () => {
    relay = startRelay({ port: 0 })
    const machine = peer('agent')
    const phone = peer('device')
    const stranger = peer('device')
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000), stranger.client.whenReady(2000)])
    const secret = randomBytes(16)
    const offer = offerId(secret)
    machine.client.control({ t: 'offer', offer: toBase64url(offer), expires: Date.now() + 60_000 })
    await Bun.sleep(50)

    phone.client.send(frame('pairing', machine.id, [1], offer))
    await until(() => machine.frames.length === 1)
    expect(machine.frames[0]!.kind).toBe('pairing')
    machine.client.send(frame('pairing', phone.id, [2], offer))
    await until(() => phone.frames.length === 1)

    // Without the offer, or with another one, nothing gets through.
    stranger.client.send(frame('pairing', machine.id, [1], randomBytes(16)))
    await until(() => stranger.undeliverable.length === 1)
    expect(stranger.undeliverable[0]).toBe('no-offer')
    machine.client.send(frame('pairing', stranger.id, [2], offer))
    await until(() => machine.undeliverable.length === 1)
    expect(machine.undeliverable[0]).toBe('not-linked')

    // Closed offers stop working.
    machine.client.control({ t: 'offer.close', offer: toBase64url(offer) })
    await Bun.sleep(50)
    phone.client.send(frame('pairing', machine.id, [1], offer))
    await until(() => phone.undeliverable.length === 1)
    expect(phone.undeliverable[0]).toBe('no-offer')
  })

  test('linked peers hear when the other comes and goes', async () => {
    relay = startRelay({ port: 0 })
    const machine = peer('agent')
    const phone = peer('device')
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000)])
    machine.client.control({ t: 'link', peer: phone.id })
    await until(() => phone.presence.some(([, on]) => on))
    machine.client.stop()
    await until(() => phone.presence.some(([p, on]) => p === machine.id && !on))
    expect(phone.client.isOnline(machine.id)).toBe(false)
  })

  test('links survive a relay restart', async () => {
    const dir = await Bun.$`mktemp -d`.text()
    const db = `${dir.trim()}/relay.db`
    relay = startRelay({ port: 0, db })
    const machineId = newIdentity()
    const phoneId = newIdentity()
    let machine = peer('agent', machineId)
    let phone = peer('device', phoneId)
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000)])
    machine.client.control({ t: 'link', peer: phone.id })
    await Bun.sleep(50)
    for (const c of clients.splice(0)) c.stop()
    await relay.stop()

    relay = startRelay({ port: 0, db })
    machine = peer('agent', machineId)
    phone = peer('device', phoneId)
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000)])
    phone.client.send(frame('session', machine.id))
    await until(() => machine.frames.length === 1)
  })

  test('floods are cut off', async () => {
    relay = startRelay({ port: 0, limits: { framesPerSecond: 5, burstSeconds: 1 } })
    const machine = peer('agent')
    const phone = peer('device')
    await Promise.all([machine.client.whenReady(2000), phone.client.whenReady(2000)])
    machine.client.control({ t: 'link', peer: phone.id })
    await until(() => phone.presence.length > 0)
    for (let i = 0; i < 50; i++) phone.client.send(frame('session', machine.id))
    await Bun.sleep(200)
    expect(machine.frames.length).toBeLessThan(10)
  })
})
