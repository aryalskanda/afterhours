// The hub against a real relay and a scripted machine: pairing, what the app knows, answering,
// remembering machines across restarts, and forgetting one.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { startRelay, type Relay } from '../../../../relay/src/server'
import { askSamples, fakeMachine, type FakeMachine } from '../../e2e/fake-machine'
import { Hub, type Storage } from './hub'
import { needsYou } from './state'

let relay: Relay
let machine: FakeMachine
const hubs: Hub[] = []

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getSecret: async k => data.get(`secret:${k}`) ?? null,
    setSecret: async (k, v) => void data.set(`secret:${k}`, v),
    get: async k => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
  }
}

async function hub(storage = memory()): Promise<Hub> {
  const h = new Hub({ storage, defaultName: 'Test phone', platform: 'test', app: 'afterhours-test/0' })
  hubs.push(h)
  await h.init()
  return h
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

beforeEach(async () => {
  relay = startRelay({ port: 0 })
  machine = fakeMachine({ relay: relay.url })
  await Bun.sleep(100)
})

afterEach(async () => {
  for (const h of hubs.splice(0)) h.close()
  machine.stop()
  await relay.stop()
})

describe('the hub', () => {
  test('pairs, then knows the machine: its queue, requests and defaults', async () => {
    const h = await hub()
    await h.pair(machine.offer())
    await until(() => h.getState().machines[0]?.synced === true)
    const m = h.getState().machines[0]!
    expect(m).toMatchObject({ name: 'build-box', status: 'connected', role: 'owner' })
    expect(m.active?.id).toBe(14)
    expect(m.queued.map(j => j.id)).toEqual([15])
    expect(m.defaults?.model).toBe('sonnet')
    expect(h.choicesFor(m.id)).toMatchObject({ model: 'sonnet', mode: 'auto', isolate: true })
  })

  test('requests arrive live, and answering one settles it', async () => {
    const h = await hub()
    await h.pair(machine.offer())
    await until(() => h.getState().machines[0]?.synced === true)
    askSamples(machine)
    await until(() => needsYou(h.getState().machines).length === 3)
    const needs = needsYou(h.getState().machines)
    expect(needs.map(n => n.approval.kind)).toEqual(['permission', 'question', 'review'])
    expect(h.getState().attention?.type).toBe('plan_review')
    const r = await h.request(machine.id, { type: 'answer', code: 'perma', decision: 'allow' })
    expect(r.ok).toBe(true)
    await until(() => needsYou(h.getState().machines).length === 2)
  })

  test('machines and where they left off survive a restart', async () => {
    const storage = memory()
    const first = await hub(storage)
    await first.pair(machine.offer())
    await until(() => first.getState().machines[0]?.synced === true)
    machine.emit({ type: 'setup_warning', message: 'one' }, 'one')
    await until(() => first.getState().machines[0]!.lastSeq === 1)
    await Bun.sleep(1700) // the hub saves within 1.5 s
    first.close()

    const again = await hub(storage)
    expect(again.getState().machines.map(m => [m.name, m.lastSeq])).toEqual([['build-box', 1]])
    expect(again.getState().deviceId).toBe(first.getState().deviceId)
    await until(() => again.getState().machines[0]?.status === 'connected')
  })

  test('forgetting a machine asks it to forget this device too', async () => {
    const h = await hub()
    await h.pair(machine.offer('viewer'))
    await until(() => h.getState().machines[0]?.status === 'connected')
    await h.forget(machine.id)
    expect(h.getState().machines).toEqual([])
    expect(machine.devices()).toEqual([])
    expect(machine.requests.some(r => r.type === 'devices.remove')).toBe(true)
  })

  test('a device the machine removed shows as removed', async () => {
    const h = await hub()
    await h.pair(machine.offer())
    await until(() => h.getState().machines[0]?.status === 'connected')
    machine.removeDevice(h.getState().deviceId)
    await until(() => h.getState().machines[0]?.status === 'refused')
    const r = await h.request(machine.id, { type: 'snapshot' })
    expect(r.ok).toBe(false)
  })
})
