import { expect, test } from 'bun:test'
import { NetworkWatch, OFFLINE_FOR_MS, reconnectSteps, REST_MS, STEP_WAIT_MS } from '../src/daemon/network'
import { macSaved, macWifiDevice, netshSaved, nmcliDevice, nmcliSaved, reachable, type WifiSystem } from '../src/platform/network'
import { backOnlineView } from '../src/telegram/ui'

/** A Wi-Fi that does what it's told, and an internet that's up or down. */
function fake(o: { device?: string | null; saved?: string[]; idle?: number | null; reconnect?: boolean; prefer?: string[]; fixes?: string } = {}) {
  let now = 1_000_000
  let up = true
  const calls: string[] = []
  const logs: string[] = []
  const back: { since: number; how: string | null }[] = []
  const config = { reconnect: o.reconnect ?? true, prefer: o.prefer ?? [] }
  const wifi: WifiSystem = {
    async device() {
      return o.device === undefined ? 'en0' : o.device
    },
    async cycle(device) {
      calls.push(`cycle ${device}`)
      if (o.fixes === 'cycle') up = true
      return true
    },
    async join(device, name) {
      calls.push(`join ${name}`)
      if (o.fixes === name) up = true
      return true
    },
    async saved() {
      return o.saved ?? ['Home', 'OnePlus 10 Pro 5G']
    },
  }
  const watch = new NetworkWatch({
    wifi,
    online: async () => up,
    idleSeconds: async () => (o.idle === undefined ? 3600 : o.idle),
    config: () => config,
    backOnline: b => back.push(b),
    now: () => now,
    log: l => logs.push(l),
  })
  return {
    watch,
    calls,
    logs,
    back,
    config,
    down: () => (up = false),
    up: () => (up = true),
    advance: (ms: number) => (now += ms),
    now: () => now,
  }
}

test('the steps: Wi-Fi off and on, then the saved networks, preferred ones first', () => {
  expect(reconnectSteps(['Home', 'Office', 'Phone'], ['Phone', 'Gone'])).toEqual([{ kind: 'cycle' }, { kind: 'join', name: 'Phone' }, { kind: 'join', name: 'Home' }, { kind: 'join', name: 'Office' }])
  expect(reconnectSteps(['Home'], [], false)).toEqual([{ kind: 'join', name: 'Home' }])
})

test('a blip under a minute does nothing; after it, Wi-Fi off and on, and it says it is back', async () => {
  const f = fake({ fixes: 'cycle' })
  f.down()
  await f.watch.tick()
  f.advance(OFFLINE_FOR_MS - 1000)
  await f.watch.tick()
  expect(f.calls).toEqual([])
  f.advance(2000)
  await f.watch.tick()
  expect(f.calls).toEqual(['cycle en0'])
  await f.watch.tick()
  expect(f.back).toEqual([{ since: 1_000_000, how: 'turned the Wi-Fi off and on' }])
  // Back online: nothing more, and no second message.
  await f.watch.tick()
  expect(f.back).toHaveLength(1)
})

test('then each saved network, preferred first, a step at a time; all failed, it rests and starts over', async () => {
  const f = fake({ prefer: ['OnePlus 10 Pro 5G'] })
  f.down()
  await f.watch.tick()
  f.advance(OFFLINE_FOR_MS + 1)
  await f.watch.tick()
  await f.watch.tick() // too soon for the next step
  expect(f.calls).toEqual(['cycle en0'])
  for (let i = 0; i < 3; i++) {
    f.advance(STEP_WAIT_MS + 1)
    await f.watch.tick()
  }
  expect(f.calls).toEqual(['cycle en0', 'join OnePlus 10 Pro 5G', 'join Home'])
  expect(f.logs.at(-1)).toContain('trying again in 5 minutes')
  f.advance(REST_MS - 1000)
  await f.watch.tick()
  expect(f.calls).toHaveLength(3)
  f.advance(2000)
  await f.watch.tick()
  expect(f.calls.at(-1)).toBe('cycle en0')
  // It came back by itself in the end: said so, with what it last did.
  f.up()
  await f.watch.tick()
  expect(f.back).toEqual([{ since: 1_000_000, how: 'turned the Wi-Fi off and on' }])
})

test('never while someone uses the computer, without Wi-Fi, or when turned off', async () => {
  for (const o of [{ idle: 30 }, { device: null }, { reconnect: false }]) {
    const f = fake(o)
    f.down()
    await f.watch.tick()
    f.advance(OFFLINE_FOR_MS * 3)
    await f.watch.tick()
    expect(f.calls).toEqual([])
    f.up()
    await f.watch.tick()
    expect(f.back).toEqual([])
  }
})

test('reading what the systems say', () => {
  expect(macWifiDevice('Hardware Port: Ethernet\nDevice: en1\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: x')).toBe('en0')
  expect(macWifiDevice('Hardware Port: Ethernet\nDevice: en1\n')).toBeNull()
  expect(macSaved('Preferred networks on en0:\n\tDevendra lamsal \n\tBisesta Home\n\tOnePlus 10 Pro 5G\n')).toEqual(['Devendra lamsal', 'Bisesta Home', 'OnePlus 10 Pro 5G'])
  expect(nmcliSaved('Home Wi\\:Fi:802-11-wireless\nWired connection 1:802-3-ethernet\nPhone:802-11-wireless\n')).toEqual(['Home Wi:Fi', 'Phone'])
  expect(nmcliDevice('lo:loopback\nwlp2s0:wifi\nenp3s0:ethernet\n')).toBe('wlp2s0')
  expect(netshSaved('User profiles\r\n-------------\r\n    All User Profile     : Home\r\n    All User Profile     : My Phone\r\n')).toEqual(['Home', 'My Phone'])
})

test('online means any of them answers at all; none answering means offline', async () => {
  const answers = (async (url: string) => {
    if (url.includes('down')) throw new Error('no route')
    return new Response('', { status: 404 })
  }) as unknown as typeof fetch
  expect(await reachable(['https://down.example', 'https://up.example'], 1000, answers)).toBe(true)
  expect(await reachable(['https://down.example'], 1000, answers)).toBe(false)
})

test('the message once it is back', () => {
  const v = backOnlineView({ since: Date.UTC(2026, 10, 12, 9, 12), how: 'joined “OnePlus 10 Pro 5G”' }, Date.UTC(2026, 10, 12, 9, 14), 'Mac')
  expect(v.html).toContain('<b>Back online.</b> The Mac lost the network at')
  expect(v.html).toContain('Afterhours joined “OnePlus 10 Pro 5G” after 2m')
  expect(v.silent).toBe(true)
})
