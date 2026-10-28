// Staying awake and sleeping, against a pretend computer: what sleeping does, sleeping once the
// queue is done, and a Mac kept awake with its lid closed. Nothing really sleeps.

import { describe, expect, test } from 'bun:test'
import { LidAwake } from '../src/daemon/awake'
import { PowerControl } from '../src/daemon/power'
import type { Notice } from '../src/daemon/notify'
import type { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { keepAwakeCommand } from '../src/platform/desktop'
import { machineWord, parseIdle, parseLoginctlIdle, sleepDisabled, type PowerKind } from '../src/platform/power'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import { FakePower, FakeSleepSwitch } from './fakes'

function control(o: { paused?: boolean; kind?: PowerKind; canInhibitLid?: boolean } = {}) {
  const sys = new FakePower(o.kind ?? 'mac')
  const store = new Store(':memory:')
  const notices: Notice[] = []
  let now = 1_000_000
  let config: Config = { ...DEFAULT_CONFIG }
  const later: (() => void)[] = []
  const power = new PowerControl({
    system: sys,
    store,
    runner: { paused: o.paused ?? false } as Runner,
    config: () => config,
    saveConfig: c => (config = c),
    notify: n => notices.push(n),
    now: () => now,
    log: () => {},
    later: run => later.push(run),
    canInhibitLid: o.canInhibitLid,
  })
  return { sys, store, power, notices, later, config: () => config, advance: (ms: number) => (now += ms) }
}

describe('what the system reports', () => {
  test('macOS: sleep turned off, and how long nobody has touched it', () => {
    expect(sleepDisabled(' SleepDisabled\t\t1\n sleep 45\n')).toBe(true)
    expect(sleepDisabled(' SleepDisabled\t\t0\n')).toBe(false)
    expect(parseIdle('    |   "HIDIdleTime" = 912345678901\n')).toBe(912)
    expect(parseIdle('')).toBeNull()
  })

  test('Linux: the desktop says whether someone is there', () => {
    const now = 1_800_000_000_000
    expect(parseLoginctlIdle('IdleHint=no\nIdleSinceHint=0\n', now)).toBe(0)
    expect(parseLoginctlIdle(`IdleHint=yes\nIdleSinceHint=${(now - 600_000) * 1000}\n`, now)).toBe(600)
    expect(parseLoginctlIdle('IdleHint=yes\nIdleSinceHint=0\n', now)).toBeNull()
    expect(parseLoginctlIdle('', now)).toBeNull()
  })

  test('what each system is called', () => {
    expect([machineWord('mac'), machineWord('linux'), machineWord('wsl')]).toEqual(['Mac', 'computer', 'PC'])
  })

  test('staying awake uses the system’s own tool, and nothing else', () => {
    const argv = keepAwakeCommand(4242, { lid: true })
    if (process.platform === 'darwin') expect(argv).toEqual(['caffeinate', '-i', '-w', '4242'])
    else if (argv) expect(argv.join(' ')).toMatch(/systemd-inhibit --what=idle:sleep:handle-lid-switch|SetThreadExecutionState/)
  })
})

describe('sleeping', () => {
  test('sleep now: it says so first, then sleeps', async () => {
    const { sys, power, notices, later } = control()
    const r = await power.sleepNow({ by: 'iPhone' })
    expect(r).toEqual({ ok: true, text: "Going to sleep. It can't be woken from your phone: open its lid or press a key." })
    expect(notices).toEqual([{ type: 'sleeping', by: 'iPhone', quit: [] }])
    // The reply and the message go first.
    expect(sys.slept).toBe(0)
    later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
  })

  test("sleep doesn't pretend: with sleep turned off by hand on a Mac, it says how to turn it on", async () => {
    const { sys, power, notices, later } = control()
    sys.stuckOff = true
    const stuck = await power.sleepNow({ by: 'iPhone' })
    expect(stuck.ok).toBe(false)
    expect(stuck.text).toContain('sudo pmset -a disablesleep 0')
    expect([notices.length, later.length, sys.slept]).toEqual([0, 0, 0])
  })

  test('a system that refuses to sleep (polkit on Linux, say) is reported, not hidden', async () => {
    const { sys, power, notices, later } = control({ kind: 'linux' })
    sys.sleepFails = 'Access denied'
    expect((await power.sleepNow({ by: 'Telegram' })).ok).toBe(true)
    later.forEach(run => run())
    await Bun.sleep(0)
    expect(notices.at(-1)).toEqual({ type: 'sleeping', by: 'Telegram', quit: [], failed: "It didn't sleep: Access denied" })
  })

  test('sleep when the queue is done: waits for the queue, a quiet minute and nobody there, then sleeps once', async () => {
    const { sys, store, power, notices, later, advance } = control()
    store.addJob({ prompt: 'x', projectDir: '/tmp', execMode: 'auto', plan: false, review: false, model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'cli' }, 1_000_000)
    const on = await power.sleepWhenDone({ on: true, by: 'iPhone' })
    expect(on.text).toBe('The Mac sleeps once the queue is done.')
    expect((await power.status()).sleepWhenDone).toEqual({ on: true, quit: [], waiting: 'the queue' })
    await power.tick()
    expect(notices).toEqual([])

    // The queue is done: a minute later, with someone at the Mac, it waits.
    store.updateJob(store.queued()[0]!.id, { status: 'done' })
    sys.idle = 20
    await power.tick()
    advance(61_000)
    await power.tick()
    expect(notices).toEqual([])
    expect((await power.status()).sleepWhenDone.waiting).toBe('someone is using the Mac')

    // They leave.
    sys.idle = 400
    advance(31_000)
    await power.tick()
    expect(notices).toEqual([{ type: 'sleeping', by: 'iPhone', quit: [] }])
    later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
    // Once: the switch is off now.
    expect((await power.status()).sleepWhenDone.on).toBe(false)
  })

  test('sleep when done is kept across a restart, and can be turned off; a PC is called a PC', async () => {
    const { store, power } = control()
    await power.sleepWhenDone({ on: true, by: 'iPhone' })
    const again = new PowerControl({ system: new FakePower('wsl'), store, runner: { paused: false } as Runner, config: () => DEFAULT_CONFIG, saveConfig: () => {}, notify: () => {}, now: Date.now, log: () => {} })
    expect((await again.status()).sleepWhenDone.on).toBe(true)
    expect((await again.sleepWhenDone({ on: false, by: 'iPhone' })).text).toBe('The PC stays awake after the queue is done.')
    expect((await power.status()).sleepWhenDone.on).toBe(false)
  })

  test('staying awake while tasks run can be turned off and on; off also lets the lid sleep it', async () => {
    const t = control({ kind: 'linux', canInhibitLid: true })
    expect((await t.power.status()).keepAwake).toBe(true)
    expect((await t.power.lidClosed(true)).ok).toBe(true)
    expect(t.power.keepAwake(false).text).toBe('The computer sleeps as it usually does, tasks or not.')
    expect(t.config()).toMatchObject({ keepAwake: false, keepAwakeLidClosed: false })
    t.power.keepAwake(true)
    expect(t.config().keepAwake).toBe(true)
  })
})

describe('staying awake for a while, tasks or not', () => {
  test('held for the hours asked, then it sleeps as usual again; a restart keeps it', async () => {
    const { store, power, advance } = control()
    expect(power.awakeHeld()).toBe(false)
    expect((await power.status()).awake).toBeNull()
    const r = power.stayAwake({ hours: 4, by: 'Telegram' })
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^The Mac stays awake until .+, tasks or not\.$/)
    expect(power.awakeHeld()).toBe(true)
    expect((await power.status()).awake).toEqual({ until: 1_000_000 + 4 * 3_600_000, hours: 4 })
    const again = new PowerControl({ system: new FakePower(), store, runner: { paused: false } as Runner, config: () => DEFAULT_CONFIG, saveConfig: () => {}, notify: () => {}, now: () => 1_000_000, log: () => {} })
    expect(again.awakeHeld()).toBe(true)
    advance(4 * 3_600_000)
    expect(power.awakeHeld()).toBe(false)
    expect((await power.status()).awake).toBeNull()
  })

  test('stopped by hand, by sleeping now, or by sleeping when done; it never holds longer than a day', async () => {
    const { power } = control()
    power.stayAwake({ hours: 2, by: 'Telegram' })
    expect(power.stayAwake({ hours: null, by: 'Telegram' }).text).toBe('The Mac sleeps as usual again when nothing runs.')
    expect(power.awakeHeld()).toBe(false)
    expect(power.stayAwake({ hours: null, by: 'Telegram' }).text).toBe('The Mac wasn’t being kept awake.')

    power.stayAwake({ hours: 2, by: 'Telegram' })
    await power.sleepNow({ by: 'Telegram' })
    expect(power.awakeHeld()).toBe(false)

    power.stayAwake({ hours: 2, by: 'Telegram' })
    expect((await power.sleepWhenDone({ on: true, by: 'Telegram' })).text).toContain('It no longer stays awake for a while first.')
    expect(power.awakeHeld()).toBe(false)
    // And the other way round: staying awake turns sleeping when done off.
    expect(power.stayAwake({ hours: 1, by: 'Telegram' }).text).toContain('It no longer sleeps when the queue is done.')
    expect((await power.status()).sleepWhenDone.on).toBe(false)

    power.stayAwake({ hours: 100, by: 'Telegram' })
    expect((await power.status()).awake!.hours).toBe(24)
  })
})

describe('awake with the lid closed', () => {
  test('Linux: a lock on the lid switch, no password; Windows: its own power settings', async () => {
    const linux = control({ kind: 'linux', canInhibitLid: true })
    expect(await linux.power.lidClosed(true)).toEqual({ ok: true, text: 'While tasks run, the computer stays awake with its lid closed too.' })
    expect(linux.config()).toMatchObject({ keepAwake: true, keepAwakeLidClosed: true })
    expect((await linux.power.status()).lidClosed).toEqual({ on: true, ready: true, holding: false })
    const noSystemd = control({ kind: 'linux', canInhibitLid: false })
    expect((await noSystemd.power.lidClosed(true)).ok).toBe(false)
    const wsl = control({ kind: 'wsl' })
    const r = await wsl.power.lidClosed(true)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('When I close the lid: Do nothing')
  })

  function lid(o: { allowed?: boolean } = {}) {
    const sys = new FakePower('mac')
    const sleep = new FakeSleepSwitch(sys)
    sleep.allowedNow = o.allowed ?? true
    const store = new Store(':memory:')
    const logs: string[] = []
    let now = 1_000_000
    const awake = new LidAwake({ system: sys, sleep, store, now: () => now, log: l => logs.push(l) })
    let config: Config = { ...DEFAULT_CONFIG }
    const power = new PowerControl({
      system: sys,
      store,
      runner: { paused: false } as Runner,
      config: () => config,
      saveConfig: c => (config = c),
      notify: () => {},
      now: () => now,
      log: () => {},
      later: () => {},
      lid: { awake, sleep },
    })
    return { sys, sleep, store, awake, power, logs, config: () => config, advance: (ms: number) => (now += ms) }
  }

  test('Mac: sleep is off while there is work, and on again once it is done', async () => {
    const t = lid()
    await t.awake.tick(true)
    expect(t.sleep.calls).toEqual([true])
    expect(t.awake.holds).toBe(true)
    await t.awake.tick(true)
    expect(t.sleep.calls).toEqual([true]) // once, not every tick
    await t.awake.tick(false)
    expect(t.sleep.calls).toEqual([true, false])
    expect(t.awake.holds).toBe(false)
  })

  test('sleep someone else turned off is left alone, and never turned on by the lid', async () => {
    const t = lid()
    t.sys.stuckOff = true
    await t.awake.tick(true)
    await t.awake.tick(false)
    expect(t.sleep.calls).toEqual([])
  })

  test('with the sudo rule in place, sleeping now turns sleep back on even when something else turned it off', async () => {
    const t = lid()
    t.sys.stuckOff = true
    expect((await t.power.sleepNow({ by: 'Telegram' })).ok).toBe(true)
    expect(t.sleep.calls).toEqual([false])
  })

  test('a battery running low lets the Mac sleep', async () => {
    const t = lid()
    await t.awake.tick(true)
    t.sys.batteryNow = { pct: 15, charging: false }
    t.advance(61_000)
    await t.awake.tick(true)
    expect(t.sleep.calls).toEqual([true, false])
    expect(t.logs.at(-1)).toContain('battery is below 20%')
    // Not off again while it's low.
    t.advance(61_000)
    await t.awake.tick(true)
    expect(t.sleep.calls).toEqual([true, false])
  })

  test('the engine started again after a crash still turns sleep back on', async () => {
    const t = lid()
    await t.awake.tick(true)
    const again = new LidAwake({ system: t.sys, sleep: t.sleep, store: t.store, now: () => 2_000_000, log: () => {} })
    expect(again.holds).toBe(true)
    await again.tick(false)
    expect(t.sleep.calls).toEqual([true, false])
  })

  test('not set up: it says how, once, and changes nothing', async () => {
    const t = lid({ allowed: false })
    await t.awake.tick(true)
    t.advance(61_000)
    await t.awake.tick(true)
    expect(t.logs.filter(l => l.includes('cq awake lid on'))).toHaveLength(1)
    expect((await t.power.lidClosed(true)).text).toContain('cq awake lid on')
    expect(t.config().keepAwakeLidClosed).toBe(false)
    expect((await t.power.status()).lidClosed).toEqual({ on: false, ready: false, holding: false })
  })

  test('turned on and off from your phone; sleeping now turns sleep back on first', async () => {
    const t = lid()
    expect((await t.power.lidClosed(true)).ok).toBe(true)
    expect(t.config().keepAwakeLidClosed).toBe(true)
    await t.awake.tick(true)
    expect((await t.power.status()).lidClosed).toEqual({ on: true, ready: true, holding: true })
    const r = await t.power.sleepNow({ by: 'iPhone' })
    expect(r.ok).toBe(true)
    expect(t.sleep.calls).toEqual([true, false])
    // Still work to do, but it stays on while the Mac sleeps.
    await t.awake.tick(true)
    expect(t.sleep.calls).toEqual([true, false])
    await t.power.lidClosed(false)
    expect(t.config().keepAwakeLidClosed).toBe(false)
  })
})
