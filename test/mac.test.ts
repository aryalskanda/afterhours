// Quitting apps and sleeping the Mac, against a pretend Mac: what macOS reports (as captured on a
// real one), and what quitting and sleeping do. No real app is quit and nothing sleeps.

import { describe, expect, test } from 'bun:test'
import { MacControl } from '../src/daemon/mac'
import type { Notice } from '../src/daemon/notify'
import type { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { listApps, parseApps, parseAssertions, parseIdle, quitBeforeSleep, sleepDisabled } from '../src/platform/mac'
import { FakeMac, MAC_APPS_JXA as JXA, MAC_ASSERTIONS as ASSERTIONS, MAC_HOME as HOME, MAC_PMSET as PMSET } from './fakes'

function control(o: { paused?: boolean } = {}) {
  const sys = new FakeMac()
  const store = new Store(':memory:')
  const notices: Notice[] = []
  let now = 1_000_000
  const later: (() => void)[] = []
  const mac = new MacControl({
    system: sys,
    store,
    runner: { paused: o.paused ?? false } as Runner,
    notify: n => notices.push(n),
    now: () => now,
    log: () => {},
    sleep: async () => {},
    later: run => later.push(run),
  })
  return {
    sys,
    store,
    mac,
    notices,
    later,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("what macOS reports", () => {
  test('the apps you would quit: regular ones, and menu-bar apps of their own; not the system or helpers', () => {
    const apps = listApps(parseApps(JXA), parseAssertions(ASSERTIONS({ vorssaint: true })), HOME)
    expect(apps.map(a => `${a.kind}:${a.name}${a.keepsAwake ? '*' : ''}`)).toEqual(['app:Code', 'app:Mail', 'menu:Monosnap', 'menu:Vorssaint*'])
  })

  test('who holds what, whether sleep is turned off, and how long nobody has touched the Mac', () => {
    const held = parseAssertions(ASSERTIONS({ vorssaint: true }))
    expect(held.filter(a => a.process === 'Vorssaint').map(a => a.type)).toEqual(['PreventUserIdleSystemSleep', 'PreventUserIdleDisplaySleep'])
    expect(held.find(a => a.process === 'coreaudiod')?.pid).toBe(429)
    expect(sleepDisabled(PMSET(true))).toBe(true)
    expect(sleepDisabled(PMSET(false))).toBe(false)
    expect(parseIdle('    | |     "HIDIdleTime" = 23367880083')).toBe(23)
    expect(parseIdle('nothing')).toBeNull()
  })

  test('sleeping quits keep-awake menu-bar apps only while sleep is turned off', () => {
    const apps = listApps(parseApps(JXA), parseAssertions(ASSERTIONS({ vorssaint: true })), HOME)
    expect(quitBeforeSleep(apps, true).map(a => a.name)).toEqual(['Vorssaint'])
    // `pmset sleepnow` sleeps through a keep-awake assertion; only `disablesleep` stops it.
    expect(quitBeforeSleep(apps, false)).toEqual([])
  })
})

describe('quitting and sleeping', () => {
  test('status: the apps, sleep turned off by Vorssaint, and what sleeping quits first', async () => {
    const { mac } = control()
    const s = await mac.status()
    expect(s.sleepDisabled).toBe(true)
    expect(s.quitFirst).toEqual([83628])
    expect(s.sleepWhenDone).toEqual({ on: false, quit: [], waiting: null })
    expect(s.idleSeconds).toBe(900)
  })

  test('an app quits when asked; one asking about unsaved work stays open until forced', async () => {
    const { sys, mac } = control()
    expect(await mac.quit(9002)).toEqual({ ok: true, text: 'Quit Monosnap.', open: false })
    sys.stubborn.add(19268)
    const asked = await mac.quit(19268)
    expect(asked).toMatchObject({ ok: false, open: true })
    expect(asked.text).toContain('Force quit')
    expect(await mac.quit(19268, { force: true })).toEqual({ ok: true, text: 'Force quit Mail.', open: false })
    // Only apps from the list: never the engine, Finder or a system process.
    expect((await mac.quit(652)).text).toBe("That app isn't open any more.")
    expect((await mac.quit(process.pid)).ok).toBe(false)
    expect(sys.asked.map(a => a.pid)).toEqual([9002, 19268, 19268])
  })

  test('sleep: quits Vorssaint (which turned sleep off), says so, then sleeps a moment later', async () => {
    const { sys, mac, notices, later } = control()
    const r = await mac.sleepNow({ quit: [83628], by: 'iPhone' })
    expect(r).toMatchObject({ ok: true })
    expect(r.text).toContain('after quitting Vorssaint')
    expect(notices).toEqual([{ type: 'sleeping', by: 'iPhone', quit: ['Vorssaint'] }])
    // The reply and the message go first.
    expect(sys.slept).toBe(0)
    later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
  })

  test("sleep doesn't pretend: with sleep still turned off, it says why and stays awake", async () => {
    const { sys, mac, notices, later } = control()
    // Without quitting Vorssaint.
    const kept = await mac.sleepNow({ quit: [], by: 'iPhone' })
    expect(kept).toEqual({ ok: false, text: 'Sleep is turned off while Vorssaint runs. Quit it first.' })
    // Turned off by something that isn't an app.
    sys.stuckOff = true
    const stuck = await mac.sleepNow({ quit: [83628], by: 'iPhone' })
    expect(stuck.ok).toBe(false)
    expect(stuck.text).toContain('sudo pmset -a disablesleep 0')
    expect([notices.length, later.length, sys.slept]).toEqual([0, 0, 0])
  })

  test("a keep-awake app that won't quit is forced, so it can't keep the Mac up", async () => {
    const { sys, mac } = control()
    sys.stubborn.add(83628)
    expect((await mac.sleepNow({ quit: [83628], by: 'Telegram' })).ok).toBe(true)
    expect(sys.asked).toEqual([
      { pid: 83628, force: false },
      { pid: 83628, force: true },
    ])
  })

  test('sleep when the queue is done: waits for the queue, a quiet minute and nobody at the Mac, then sleeps once', async () => {
    const { sys, store, mac, notices, later, advance } = control()
    store.addJob({ prompt: 'x', projectDir: '/tmp', execMode: 'auto', plan: false, review: false, model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'cli' }, 1_000_000)
    const on = await mac.sleepWhenDone({ on: true, by: 'iPhone' })
    expect(on.text).toBe('The Mac sleeps once the queue is done, after quitting Vorssaint.')
    expect((await mac.status()).sleepWhenDone).toEqual({ on: true, quit: ['Vorssaint'], waiting: 'the queue' })
    await mac.tick()
    expect(notices).toEqual([])

    // The queue is done: a minute later, with someone at the Mac, it waits.
    store.updateJob(store.queued()[0]!.id, { status: 'done' })
    sys.idle = 20
    await mac.tick()
    advance(61_000)
    await mac.tick()
    expect(notices).toEqual([])
    expect((await mac.status()).sleepWhenDone.waiting).toBe('someone is using the Mac')

    // They leave.
    sys.idle = 400
    advance(31_000)
    await mac.tick()
    expect(notices).toEqual([{ type: 'sleeping', by: 'iPhone', quit: ['Vorssaint'] }])
    later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
    // Once: the switch is off now.
    expect((await mac.status()).sleepWhenDone.on).toBe(false)
  })

  test('sleep when done is kept across a restart, and can be turned off', async () => {
    const { store, mac } = control()
    await mac.sleepWhenDone({ on: true, by: 'iPhone' })
    const again = new MacControl({ system: new FakeMac(), store, runner: { paused: false } as Runner, notify: () => {}, now: Date.now, log: () => {} })
    expect((await again.status()).sleepWhenDone.on).toBe(true)
    expect((await again.sleepWhenDone({ on: false, by: 'iPhone' })).text).toBe('The Mac stays awake after the queue is done.')
    expect((await mac.status()).sleepWhenDone.on).toBe(false)
  })
})
