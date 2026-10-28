// Awake and asleep, for the apps, the bot and text commands: staying awake while tasks run (with the
// lid closed too, where the system allows it), staying awake for a while with nothing running,
// sleeping now, and sleeping once the queue is done. It's done with the system's own tools only
// (platform/power.ts): no keep-awake app to install.

import { machineWord, type PowerKind, type PowerSystem, type SleepSwitch } from '../platform/power'
import type { Config } from '../shared/config'
import type { LidAwake } from './awake'
import { formatClock } from './limits'
import type { Notice } from './notify'
import type { Runner } from './runner'
import type { Store } from './store'

export interface PowerStatus {
  /** Which system this is: what it's called, and what it can do. */
  kind: PowerKind
  /** Always empty: apps aren't listed or quit any more (kept for apps that read it). */
  apps: never[]
  /** Sleep is turned off for the whole machine (macOS: pmset disablesleep), by something else. */
  sleepDisabled: boolean
  /** Always empty (kept for apps that read it). */
  quitFirst: number[]
  /** Sleep once the queue is done, and what it's waiting for. */
  sleepWhenDone: { on: boolean; quit: string[]; waiting: string | null }
  /** Seconds since someone last used the keyboard, mouse or trackpad. */
  idleSeconds: number | null
  /** The task that pauses while the computer sleeps. */
  running: number | null
  /** Stays awake while tasks run (holds off idle sleep). */
  keepAwake: boolean
  /**
   * Awake with the lid closed while tasks run: `on` (the setting), `ready` (it can be done here: on
   * a Mac, once the sudo rule is in place), `holding` (held for tasks right now).
   */
  lidClosed: { on: boolean; ready: boolean; holding: boolean }
  /** Staying awake for a while even with nothing running (stayAwake): until when, and for how many hours it was asked. */
  awake: { until: number; hours: number } | null
}

/** Sleep once the queue is done; stored, so a restart keeps it. */
interface SleepPlan {
  by: string
  at: number
}

const PLAN_KEY = 'mac.sleepWhenDone'

/** Awake until a time, tasks or not; stored, so a restart keeps it. */
interface AwakeHold {
  until: number
  hours: number
  by: string
}

const HOLD_KEY = 'power.awakeUntil'
const HOUR_MS = 3_600_000
/** The longest it may be held awake in one go: a laptop forgotten in a bag shouldn't run flat for days. */
export const MAX_AWAKE_HOURS = 24
/** The reply and the bot's message go out before the computer sleeps. */
const SLEEP_DELAY_MS = 3000
/** How long the queue stays done before sleeping (a follow-up often comes right after a task). */
const DONE_FOR_MS = 60_000
/** Someone who used the computer this recently is still there: it waits for them to leave. */
const AWAY_SECONDS = 300
const IDLE_CHECK_MS = 30_000

export interface PowerDeps {
  system: PowerSystem
  store: Store
  runner: Runner
  config: () => Config
  saveConfig: (c: Config) => void
  notify: (n: Notice) => void
  now: () => number
  log: (line: string) => void
  later?: (run: () => void, ms: number) => void
  /** macOS: awake with the lid closed, through the sudo rule. */
  lid?: { awake: LidAwake; sleep: SleepSwitch }
  /** Linux: whether systemd-inhibit is there to hold off the lid switch. */
  canInhibitLid?: boolean
  /** Holding off idle sleep right now (platform/desktop.ts KeepAwake). */
  holdingAwake?: () => boolean
}

export class PowerControl {
  private doneSince: number | null = null
  private idleCheckedAt = 0
  private someoneThere = false
  private goingToSleep = false
  private ticking = false

  constructor(private readonly d: PowerDeps) {}

  /** "Mac", "computer" or "PC". */
  get word(): string {
    return machineWord(this.d.system.kind)
  }

  private plan(): SleepPlan | null {
    return this.d.store.kvGet<SleepPlan | null>(PLAN_KEY) ?? null
  }

  /** The stay-awake hold while it lasts; null once it has run out. */
  private hold(): AwakeHold | null {
    const h = this.d.store.kvGet<AwakeHold | null>(HOLD_KEY) ?? null
    return h && h.until > this.d.now() ? h : null
  }

  /** Whether it's held awake right now with nothing needing it (stayAwake). The engine checks this every tick. */
  awakeHeld(): boolean {
    return this.hold() !== null
  }

  /** Whether "awake with the lid closed" can be done here, set up or not. */
  get lidSupported(): boolean {
    return this.d.system.kind === 'mac' ? Boolean(this.d.lid) : this.d.system.kind === 'linux' ? Boolean(this.d.canInhibitLid) : false
  }

  private async lidReady(): Promise<boolean> {
    if (this.d.system.kind === 'mac') return (await this.d.lid?.sleep.allowed()) ?? false
    return this.lidSupported
  }

  async status(): Promise<PowerStatus> {
    const config = this.d.config()
    const [disabled, idle, ready] = await Promise.all([this.d.system.sleepDisabled(), this.d.system.idleSeconds(), this.lidReady()])
    const plan = this.plan()
    const holding = this.d.system.kind === 'mac' ? (this.d.lid?.awake.holds ?? false) : config.keepAwakeLidClosed && (this.d.holdingAwake?.() ?? false)
    return {
      kind: this.d.system.kind,
      apps: [],
      sleepDisabled: disabled && !(this.d.lid?.awake.holds ?? false),
      quitFirst: [],
      sleepWhenDone: plan ? { on: true, quit: [], waiting: this.waitingFor() } : { on: false, quit: [], waiting: null },
      idleSeconds: idle,
      running: this.d.store.running().at(-1)?.id ?? null,
      keepAwake: config.keepAwake,
      lidClosed: { on: config.keepAwakeLidClosed && this.lidSupported, ready, holding },
      awake: (h => (h ? { until: h.until, hours: h.hours } : null))(this.hold()),
    }
  }

  /**
   * Stays awake for `hours` from now, with or without tasks (for a task set for later, or to reach the
   * computer), then sleeps as usual again; null lets it sleep as usual now. It's the opposite of
   * sleeping once the queue is done, so it turns that off.
   */
  stayAwake(o: { hours: number | null; by: string }): { ok: boolean; text: string } {
    if (o.hours === null) {
      const had = this.hold() !== null
      this.d.store.kvSet(HOLD_KEY, null)
      return { ok: true, text: had ? `The ${this.word} sleeps as usual again when nothing runs.` : `The ${this.word} wasn’t being kept awake.` }
    }
    const hours = Math.min(MAX_AWAKE_HOURS, Math.max(0.25, o.hours))
    const now = this.d.now()
    const until = now + hours * HOUR_MS
    const sleepPlanned = this.plan() !== null
    this.d.store.kvSet(HOLD_KEY, { until, hours, by: o.by } satisfies AwakeHold)
    this.d.store.kvSet(PLAN_KEY, null)
    this.d.log(`power: staying awake until ${new Date(until).toISOString()} (asked from ${o.by})`)
    return {
      ok: true,
      text: `The ${this.word} stays awake until ${formatClock(until, now)}, tasks or not.${sleepPlanned ? ' It no longer sleeps when the queue is done.' : ''}`,
    }
  }

  /** Stays awake while tasks run, or may sleep as usual. */
  keepAwake(on: boolean): { ok: boolean; text: string } {
    const config = this.d.config()
    this.d.saveConfig({ ...config, keepAwake: on, ...(on ? {} : { keepAwakeLidClosed: false }) })
    return { ok: true, text: on ? `While tasks run, the ${this.word} stays awake.` : `The ${this.word} sleeps as it usually does, tasks or not.` }
  }

  /** Awake with the lid closed while tasks run, or not. */
  async lidClosed(on: boolean): Promise<{ ok: boolean; text: string }> {
    if (!this.lidSupported) {
      return {
        ok: false,
        text: this.d.system.kind === 'wsl' ? 'Windows sleeps when the lid closes. Set "When I close the lid: Do nothing" in Windows’ power settings.' : `This ${this.word} can’t do that.`,
      }
    }
    if (on && this.d.system.kind === 'mac' && !(await this.lidReady())) {
      return { ok: false, text: 'It needs your password once, at the Mac. In Terminal: cq awake lid on' }
    }
    const config = this.d.config()
    this.d.saveConfig({ ...config, keepAwakeLidClosed: on, ...(on ? { keepAwake: true } : {}) })
    if (!on) await this.d.lid?.awake.release('turned off')
    return {
      ok: true,
      text: on
        ? `While tasks run, the ${this.word} stays awake with its lid closed too.${this.d.system.kind === 'mac' ? ' Below 20% battery it may sleep.' : ''}`
        : `Closing the lid sleeps the ${this.word} again, tasks or not.`,
    }
  }

  /** Puts the computer to sleep. */
  async sleepNow(o: { by: string }): Promise<{ ok: boolean; text: string }> {
    if (this.goingToSleep) return { ok: true, text: `The ${this.word} is already going to sleep.` }
    // Sleep turned off for tasks: on again, and left on while it sleeps.
    await this.d.lid?.awake.release('sleeping now', 10 * 60_000)
    if (await this.d.system.sleepDisabled()) {
      // Something else turned sleep off (pmset disablesleep). With the sudo rule, turn it back on.
      if (!(this.d.lid && (await this.d.lid.sleep.set(false)) && !(await this.d.system.sleepDisabled()))) {
        return { ok: false, text: 'Sleep is turned off on this Mac (pmset disablesleep). At the Mac, run: sudo pmset -a disablesleep 0, or cq awake lid on once so Afterhours can turn it back on itself.' }
      }
      this.d.log('power: sleep was turned off; turned it back on to sleep')
    }
    this.goingToSleep = true
    // Asked to sleep: staying awake for a while is over.
    this.d.store.kvSet(HOLD_KEY, null)
    this.d.notify({ type: 'sleeping', by: o.by, quit: [] })
    this.d.log(`power: going to sleep (asked from ${o.by})`)
    ;(this.d.later ?? setTimeout)(() => {
      void this.d.system
        .sleepNow()
        .then(r => {
          if (!r.ok) {
            this.d.log(`power: it didn't sleep: ${r.error}`)
            this.d.notify({ type: 'sleeping', by: o.by, quit: [], failed: `It didn't sleep: ${r.error}` })
          }
        })
        .finally(() => {
          this.goingToSleep = false
        })
    }, SLEEP_DELAY_MS)
    const running = this.d.store.running()
    return {
      ok: true,
      text:
        'Going to sleep.' +
        `${running.length ? ` ${running.map(j => `#${j.id}`).join(' and ')} ${running.length === 1 ? 'pauses' : 'pause'} until it wakes.` : ''} It can't be woken from your phone: open its lid or press a key.`,
    }
  }

  /** Sleep once the queue is done, or not. */
  async sleepWhenDone(o: { on: boolean; by: string }): Promise<{ ok: boolean; text: string }> {
    if (!o.on) {
      this.d.store.kvSet(PLAN_KEY, null)
      return { ok: true, text: `The ${this.word} stays awake after the queue is done.` }
    }
    const held = this.hold() !== null
    this.d.store.kvSet(PLAN_KEY, { by: o.by, at: this.d.now() } satisfies SleepPlan)
    this.d.store.kvSet(HOLD_KEY, null)
    this.doneSince = null
    this.someoneThere = false
    const now = this.d.now()
    const waiting = this.d.store.queued().filter(j => j.onHold || (j.notBefore !== null && j.notBefore > now)).length
    return {
      ok: true,
      text:
        `The ${this.word} sleeps once the queue is done.` +
        `${held ? ' It no longer stays awake for a while first.' : ''}` +
        `${waiting ? ` ${waiting === 1 ? 'A task on hold or set for later waits' : `${waiting} tasks on hold or set for later wait`} until it wakes.` : ''}`,
    }
  }

  /** Nothing is running, and nothing in the queue can start now. */
  private queueDone(): boolean {
    if (this.d.store.running().length > 0) return false
    if (this.d.runner.paused) return true
    const now = this.d.now()
    return this.d.store.queued().every(j => j.onHold || (j.notBefore !== null && j.notBefore > now))
  }

  /** Why sleep-when-done hasn't slept yet. */
  private waitingFor(): string | null {
    if (!this.queueDone()) return 'the queue'
    if (this.someoneThere) return `someone is using the ${this.word}`
    return null
  }

  /** Call every few seconds: sleeps once the queue has been done a minute and nobody is at the computer. */
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
        if (!this.someoneThere) this.d.log(`power: the queue is done, but someone is using the ${this.word}; it sleeps once they have been away 5 minutes`)
        this.someoneThere = true
        return
      }
      this.d.store.kvSet(PLAN_KEY, null)
      const r = await this.sleepNow({ by: plan.by })
      if (!r.ok) this.d.notify({ type: 'sleeping', by: plan.by, quit: [], failed: r.text })
    } catch (err) {
      this.d.log(`power: sleeping when the queue is done failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.ticking = false
    }
  }
}
