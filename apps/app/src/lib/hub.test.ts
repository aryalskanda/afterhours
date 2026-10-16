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
    expect(h.getState().attention).toMatchObject({ type: 'plan_review', code: 'revie' })
    const r = await h.request(machine.id, { type: 'answer', code: 'perma', decision: 'allow' })
    expect(r.ok).toBe(true)
    await until(() => needsYou(h.getState().machines).length === 2)
    // Answering another request leaves the banner; answering its own takes it down.
    expect(h.getState().attention?.code).toBe('revie')
    await h.request(machine.id, { type: 'answer', code: 'revie', decision: 'allow' })
    await until(() => h.getState().attention === null)
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
    const storage = memory()
    const h2 = await hub(storage)
    await h2.pair(machine.offer('operator'))
    await until(() => h2.getState().machines[0]?.status === 'connected')
    await h.forget(machine.id)
    expect(h.getState().machines).toEqual([])
    expect(machine.devices()).toEqual([h2.getState().deviceId])
    expect(machine.requests.some(r => r.type === 'devices.remove')).toBe(true)
    // Gone from this device at once, and so is what waited to go to it.
    await h2.queueLater('elsewhere', { type: 'queue', folder: '/x', prompt: 'Not this one' })
    machine.stop()
    await until(() => h2.getState().machines[0]?.status !== 'connected')
    await h2.queueLater(machine.id, { type: 'queue', folder: '/home/me/code/shop/web', prompt: 'Later' })
    const forgetting = h2.forget(machine.id)
    expect(h2.getState().machines).toEqual([])
    await forgetting
    expect(JSON.parse(storage.data.get('afterhours.machines')!)).toEqual([])
    expect(h2.getState().outbox.map(x => x.body.prompt)).toEqual(['Not this one'])
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

describe('push', () => {
  test('machines learn this device’s token and choices; again only when they change; off stops them', async () => {
    const storage = memory()
    const h = await hub(storage)
    await h.pair(machine.offer('viewer'))
    await until(() => h.getState().machines[0]?.synced === true)
    // No token yet: nothing to tell.
    expect(machine.pushes.size).toBe(0)
    await h.setPush('ExponentPushToken[abc]')
    const device = h.getState().deviceId
    await until(() => machine.pushes.get(device)?.token === 'ExponentPushToken[abc]')
    expect(machine.pushes.get(device)!.prefs).toMatchObject({ events: { requests: true, done: true, failed: true, limits: true }, details: true, quiet: null })
    await h.setPrefs({ notify: { ...h.getState().prefs.notify, details: false, quiet: { start: 1320, end: 420 } } })
    await until(() => machine.pushes.get(device)?.prefs.details === false)
    expect(machine.pushes.get(device)!.prefs.quiet).toMatchObject({ start: 1320, end: 420 })
    expect(typeof machine.pushes.get(device)!.prefs.quiet?.tz).toBe('string')
    const asked = machine.requests.filter(r => r.type === 'push.register').length
    // A restart, the same choices: not asked again.
    h.close()
    const again = await hub(storage)
    await until(() => again.getState().machines[0]?.synced === true)
    await Bun.sleep(100)
    expect(machine.requests.filter(r => r.type === 'push.register').length).toBe(asked)
    await again.setPush(null)
    await until(() => machine.pushes.get(device)?.token === null)
  })
})

describe('backup', () => {
  test('a new phone restores the backup: the same device, its machines, and no pushes to the old phone', async () => {
    const old = await hub()
    await old.pair(machine.offer('operator'))
    await until(() => old.getState().machines[0]?.synced === true)
    await old.setPush('ExponentPushToken[old-phone]')
    const device = old.getState().deviceId
    await until(() => machine.pushes.get(device)?.token === 'ExponentPushToken[old-phone]')
    await old.savePrompt('Run the tests')
    const text = await old.backup('correct horse battery')
    old.close()
    const fresh = await hub()
    expect(fresh.getState().deviceId).not.toBe(device)
    await expect(fresh.restore(text, 'wrong passphrase!')).rejects.toThrow('Wrong passphrase')
    await fresh.restore(text, 'correct horse battery')
    expect(fresh.getState().deviceId).toBe(device)
    expect(fresh.getState().saved).toEqual(['Run the tests'])
    expect(fresh.getState().push.token).toBeNull()
    await until(() => fresh.getState().machines[0]?.status === 'connected')
    await until(() => machine.pushes.get(device)?.token === null)
  })
})

describe('prompts kept on this device', () => {
  test('saved prompts and drafts survive a restart; a queued draft is gone', async () => {
    const storage = memory()
    const first = await hub(storage)
    await first.savePrompt('  Run the tests and fix what fails  ')
    await first.savePrompt('Write release notes')
    await first.savePrompt('Run the tests and fix what fails')
    await first.saveDraft('m1', { prompt: 'Half a thought', folder: '/home/me/code/shop/web', at: 1 })
    expect(first.getState().saved).toEqual(['Run the tests and fix what fails', 'Write release notes'])
    first.close()
    const again = await hub(storage)
    expect(again.getState().saved).toEqual(['Run the tests and fix what fails', 'Write release notes'])
    expect(again.draftFor('m1')).toEqual({ prompt: 'Half a thought', folder: '/home/me/code/shop/web', at: 1 })
    await again.saveDraft('m1', null)
    await again.removeSaved('Write release notes')
    expect(again.draftFor('m1')).toBeNull()
    expect(again.getState().saved).toEqual(['Run the tests and fix what fails'])
  })

  test('while you were away: from when you last left, after a real absence', async () => {
    const storage = memory()
    let now = 1_000_000
    const make = async () => {
      const h = new Hub({ storage, defaultName: 'Test phone', platform: 'test', app: 'afterhours-test/0', now: () => now })
      hubs.push(h)
      await h.init()
      return h
    }
    const first = await make()
    expect(first.getState().away).toBeNull()
    first.leave()
    now += 60_000
    first.wake()
    // A minute in another app isn't being away.
    expect(first.getState().away).toBeNull()
    first.leave()
    const left = now
    now += 3_600_000
    first.wake()
    expect(first.getState().away).toBe(left)
    first.dismissAway()
    expect(first.getState().away).toBeNull()
    // Closed in the background: the next start remembers when.
    first.leave()
    const closed = now
    first.close()
    now += 86_400_000
    expect((await make()).getState().away).toBe(closed)
  })

  test('the outbox sends what waited once the machine is there; what it refuses stays, with why', async () => {
    const h = await hub()
    const paired = await h.pair(machine.offer())
    await until(() => h.getState().machines[0]?.status === 'connected')
    await h.queueLater(paired.machine.id, { type: 'queue', folder: '/home/me/code/shop/web', prompt: 'Sent later' })
    await until(() => h.getState().outbox.length === 0)
    expect(machine.requests.some(r => r.type === 'queue' && r.prompt === 'Sent later')).toBe(true)
    await h.queueLater(paired.machine.id, { type: 'queue', folder: '/etc', prompt: 'Not allowed' })
    await until(() => h.getState().outbox[0]?.error !== undefined)
    expect(h.getState().outbox[0]!.error).toContain('outside the folders')
    await h.cancelOutgoing(h.getState().outbox[0]!.id)
    expect(h.getState().outbox).toEqual([])
  })
})
