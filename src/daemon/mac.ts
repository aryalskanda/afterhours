// Quitting apps and sleeping the Mac, for the apps, the bot and text commands: what's open and what
// keeps the Mac awake, quitting an app (or force quitting one that won't), sleeping now, and
// sleeping once the queue is done. The system calls are in platform/mac.ts.

import { listApps, parseAssertions, quitBeforeSleep, sleepDisabled, type MacApp, type MacSystem, type SleepSwitch } from '../platform/mac'
import type { Config } from '../shared/config'
import type { LidAwake } from './awake'
import type { Notice } from './notify'
import type { Runner } from './runner'
import type { Store } from './store'

export interface MacStatus {
  apps: MacApp[]
  /** Sleep is turned off (pmset disablesleep): the Mac won't sleep, lid closed or not. */
  sleepDisabled: boolean
  /** What sleeping quits first: the keep-awake apps, while sleep is turned off. */
  quitFirst: number[]
  /** Sleep once the queue is done: the apps it quits first, and what it's waiting for. */
  sleepWhenDone: { on: boolean; quit: string[]; waiting: string | null }
  /** Seconds since someone last used the keyboard or trackpad. */
  idleSeconds: number | null
  /** The task that pauses while the Mac sleeps. */
  running: number | null
  /**
   * Awake with the lid closed while tasks run: `on` (the setting), `ready` (the sudo rule that lets
   * it turn sleep off is in place), `holding` (sleep is off for tasks right now).
   */
  lidClosed: { on: boolean; ready: boolean; holding: boolean }
}

export interface QuitResult {
  ok: boolean
  text: string
  /** Still open after asking: it may be asking about unsaved work; force quit closes it. */
  open: boolean
}

/** Sleep once the queue is done; stored, so a restart keeps it. */
interface SleepPlan {
  /** Bundle ids (or names) of the apps to quit first. */
  quit: string[]
  names: string[]
  by: string
  at: number
}

const PLAN_KEY = 'mac.sleepWhenDone'
const QUIT_WAIT_MS = 5000
/** How long a keep-awake app that just quit has to turn sleep back on. */
const SLEEP_ALLOWED_WAIT_MS = 10_000
/** The reply and the bot's message go out before the Mac sleeps. */
const SLEEP_DELAY_MS = 3000
/** How long the queue stays done before sleeping (a follow-up often comes right after a task). */
const DONE_FOR_MS = 60_000
/** Someone who used the Mac this recently is still there: it waits for them to leave. */
const AWAY_SECONDS = 300
const IDLE_CHECK_MS = 30_000

export interface MacDeps {
  system: MacSystem
  store: Store
  runner: Runner
  notify: (n: Notice) => void
  now: () => number
  log: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  later?: (run: () => void, ms: number) => void
  /** Awake with the lid closed; missing where it can't be done. */
  lid?: { awake: LidAwake; sleep: SleepSwitch; config: () => Config; saveConfig: (c: Config) => void }
}

export class MacControl {
  private doneSince: number | null = null
  private idleCheckedAt = 0
  private someoneThere = false
  private goingToSleep = false
  private ticking = false

  constructor(private readonly d: MacDeps) {}

  private wait(ms: number): Promise<void> {
    return (this.d.sleep ?? Bun.sleep)(ms)
  }

  async apps(): Promise<MacApp[]> {
    const [running, assertions] = await Promise.all([this.d.system.runningApps(), this.d.system.pmset(['-g', 'assertions'])])
    return listApps(running, parseAssertions(assertions))
  }

  private async disabled(): Promise<boolean> {
    return sleepDisabled(await this.d.system.pmset(['-g']))
  }

  private plan(): SleepPlan | null {
    return this.d.store.kvGet<SleepPlan | null>(PLAN_KEY) ?? null
  }

  async status(): Promise<MacStatus> {
    const [apps, disabled, idle, ready] = await Promise.all([this.apps(), this.disabled(), this.d.system.idleSeconds(), this.d.lid?.sleep.allowed() ?? false])
    const plan = this.plan()
    const lid = this.d.lid
    return {
      apps,
      sleepDisabled: disabled,
      quitFirst: quitBeforeSleep(apps, disabled).map(a => a.pid),
      sleepWhenDone: plan ? { on: true, quit: plan.names, waiting: this.waitingFor() } : { on: false, quit: [], waiting: null },
      idleSeconds: idle,
      running: this.d.store.active()?.id ?? null,
      lidClosed: { on: lid?.config().keepAwakeLidClosed ?? false, ready, holding: lid?.awake.holds ?? false },
    }
  }

  /** Awake with the lid closed while tasks run, or not. */
  async lidClosed(on: boolean): Promise<{ ok: boolean; text: string }> {
    const lid = this.d.lid
    if (!lid) return { ok: false, text: "This Mac can't do that." }
    if (on && !(await lid.sleep.allowed())) {
      return { ok: false, text: 'It needs your password once, at the Mac. In Terminal: cq awake lid on' }
    }
    lid.saveConfig({ ...lid.config(), keepAwakeLidClosed: on })
    if (!on) await lid.awake.release('turned off')
    return {
      ok: true,
      text: on ? 'While tasks run, the Mac stays awake with its lid closed too. Below 20% battery it may sleep.' : 'Closing the lid sleeps the Mac again, tasks or not.',
    }
  }

  /** Quits an app that's open (by its pid in `apps()`); `force` ends it without asking. */
  async quit(pid: number, o: { force?: boolean } = {}): Promise<QuitResult> {
    const app = (await this.apps()).find(a => a.pid === pid)
    if (!app) return { ok: false, text: "That app isn't open any more.", open: false }
    return this.quitApp(app, o.force ?? false)
  }

  private async quitApp(app: MacApp, force: boolean): Promise<QuitResult> {
    if (!(await this.d.system.terminate(app.pid, force)) && this.d.system.alive(app.pid)) {
      return { ok: false, text: `${app.name} didn't take the request to quit.`, open: true }
    }
    for (let waited = 0; waited < QUIT_WAIT_MS; waited += 250) {
      if (!this.d.system.alive(app.pid)) {
        this.d.log(`mac: ${force ? 'force quit' : 'quit'} ${app.name}`)
        return { ok: true, text: `${force ? 'Force quit' : 'Quit'} ${app.name}.`, open: false }
      }
      await this.wait(250)
    }
    return force
      ? { ok: false, text: `${app.name} is still open.`, open: true }
      : { ok: false, text: `${app.name} is still open: it may be asking something on screen, like whether to save. Force quit closes it without asking.`, open: true }
  }

  /** Puts the Mac to sleep, quitting `quit` (pids) first. */
  async sleepNow(o: { quit: number[]; by: string }): Promise<{ ok: boolean; text: string }> {
    if (this.goingToSleep) return { ok: true, text: 'The Mac is already going to sleep.' }
    const apps = await this.apps()
    const quitted: string[] = []
    for (const pid of o.quit) {
      const app = apps.find(a => a.pid === pid)
      if (!app) continue
      let r = await this.quitApp(app, false)
      // An app quit so the Mac can sleep doesn't get to keep it awake by not answering.
      if (r.open) r = await this.quitApp(app, true)
      if (!r.ok) return { ok: false, text: `${app.name} wouldn't quit, so the Mac didn't sleep.` }
      quitted.push(app.name)
    }
    // Sleep turned off for tasks: on again, and left on while the Mac sleeps.
    await this.d.lid?.awake.release('sleeping now', 10 * 60_000)
    // A keep-awake app turns sleep back on as it goes.
    let disabled = await this.disabled()
    for (let waited = 0; disabled && quitted.length > 0 && waited < SLEEP_ALLOWED_WAIT_MS; waited += 500) {
      await this.wait(500)
      disabled = await this.disabled()
    }
    if (disabled) {
      const keeping = quitBeforeSleep(await this.apps(), true).map(a => a.name)
      return {
        ok: false,
        text: keeping.length
          ? `Sleep is turned off while ${names(keeping)} runs. Quit it first.`
          : 'Sleep is turned off on this Mac (pmset disablesleep), and no open app is holding it. At the Mac: sudo pmset -a disablesleep 0',
      }
    }
    this.goingToSleep = true
    this.d.notify({ type: 'sleeping', by: o.by, quit: quitted })
    this.d.log(`mac: going to sleep (asked from ${o.by})`)
    ;(this.d.later ?? setTimeout)(() => {
      void this.d.system.sleepNow().finally(() => {
        this.goingToSleep = false
      })
    }, SLEEP_DELAY_MS)
    const running = this.d.store.active()
    return {
      ok: true,
      text:
        `Going to sleep${quitted.length ? `, after quitting ${names(quitted)}` : ''}.` +
        `${running ? ` #${running.id} pauses until the Mac wakes.` : ''} It can't be woken from your phone: open its lid or press a key.`,
    }
  }

  /** Sleep once the queue is done (`quit`: pids to quit first; by default the keep-awake apps). */
  async sleepWhenDone(o: { on: boolean; quit?: number[]; by: string }): Promise<{ ok: boolean; text: string }> {
    if (!o.on) {
      this.d.store.kvSet(PLAN_KEY, null)
      return { ok: true, text: 'The Mac stays awake after the queue is done.' }
    }
    const apps = await this.apps()
    const chosen = o.quit ? apps.filter(a => o.quit!.includes(a.pid)) : quitBeforeSleep(apps, await this.disabled())
    const plan: SleepPlan = { quit: chosen.map(a => a.bundleId ?? a.name), names: chosen.map(a => a.name), by: o.by, at: this.d.now() }
    this.d.store.kvSet(PLAN_KEY, plan)
    this.doneSince = null
    this.someoneThere = false
    const now = this.d.now()
    const waiting = this.d.store.queued().filter(j => j.onHold || (j.notBefore !== null && j.notBefore > now)).length
    return {
      ok: true,
      text:
        `The Mac sleeps once the queue is done${chosen.length ? `, after quitting ${names(chosen.map(a => a.name))}` : ''}.` +
        `${waiting ? ` ${waiting === 1 ? 'A task on hold or set for later waits' : `${waiting} tasks on hold or set for later wait`} until it wakes.` : ''}`,
    }
  }

  /** Nothing is running, and nothing in the queue can start now. */
  private queueDone(): boolean {
    if (this.d.store.active()) return false
    if (this.d.runner.paused) return true
    const now = this.d.now()
    return this.d.store.queued().every(j => j.onHold || (j.notBefore !== null && j.notBefore > now))
  }

  /** Why sleep-when-done hasn't slept yet. */
  private waitingFor(): string | null {
    if (!this.queueDone()) return 'the queue'
    if (this.someoneThere) return 'someone is using the Mac'
    return null
  }

  /** Call every few seconds: sleeps once the queue has been done a minute and nobody is at the Mac. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const plan = this.plan()
      if (!plan || this.goingToSleep || !this.queueDone()) {
        this.doneSince = null
        return
      }
      const now = this.d.now()
      this.doneSince ??= now
      if (now - this.doneSince < DONE_FOR_MS || now - this.idleCheckedAt < IDLE_CHECK_MS) return
      this.idleCheckedAt = now
      const idle = await this.d.system.idleSeconds()
      if (idle !== null && idle < AWAY_SECONDS) {
        if (!this.someoneThere) this.d.log('mac: the queue is done, but someone is using the Mac; it sleeps once they have been away 5 minutes')
        this.someoneThere = true
        return
      }
      this.d.store.kvSet(PLAN_KEY, null)
      const apps = await this.apps()
      const quit = apps.filter(a => plan.quit.includes(a.bundleId ?? a.name)).map(a => a.pid)
      const r = await this.sleepNow({ quit, by: plan.by })
      if (!r.ok) this.d.notify({ type: 'sleeping', by: plan.by, quit: [], failed: r.text })
    } catch (err) {
      this.d.log(`mac: sleeping when the queue is done failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.ticking = false
    }
  }
}

/** "Vorssaint", "Vorssaint and Docker", "A, B and C". */
function names(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}
