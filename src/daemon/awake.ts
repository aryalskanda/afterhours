// A Mac awake with the lid closed. While there are tasks, `caffeinate` (platform/desktop.ts) keeps
// an open Mac from idle sleep, but closing the lid sleeps it through any assertion. With
// `keepAwakeLidClosed` on, sleep is turned off altogether while there's work (`pmset disablesleep`)
// and back on when it's done. It needs the sudo rule `cq awake lid on` puts in
// place. Sleep is only ever turned back on if this turned it off, and a low battery turns it back on.

import type { PowerSystem, SleepSwitch } from '../platform/power'
import type { Store } from './store'

/** Stored, so the engine started again after a crash still turns sleep back on. */
const KEY = 'awake.lid'
/** On battery below this, the Mac may sleep again: a closed laptop in a bag shouldn't run flat. */
export const LOW_BATTERY_PCT = 20
/** How often to look again after it didn't turn sleep off, or found the battery low. */
const RETRY_MS = 60_000

export interface AwakeDeps {
  system: Pick<PowerSystem, 'sleepDisabled' | 'battery'>
  sleep: SleepSwitch
  store: Store
  now: () => number
  log: (line: string) => void
}

export class LidAwake {
  private holding: boolean
  private retryAt = 0
  private checkedAt = 0
  private busy = false
  private failed = false

  constructor(private readonly d: AwakeDeps) {
    this.holding = Boolean(d.store.kvGet<{ since: number } | null>(KEY))
  }

  /** It turned sleep off, and turns it back on when the work is done. */
  get holds(): boolean {
    return this.holding
  }

  /** Every few seconds: `want` is whether there's work and the setting is on. */
  async tick(want: boolean): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = this.d.now()
      if (!want) {
        if (this.holding) await this.release('the tasks are done')
        return
      }
      if (now < this.retryAt) return
      if (this.holding) {
        // While it holds: the battery, now and then.
        if (now - this.checkedAt < RETRY_MS) return
        this.checkedAt = now
        if (await this.low()) {
          await this.release(`the battery is below ${LOW_BATTERY_PCT}%`)
          this.retryAt = now + RETRY_MS
        }
        return
      }
      this.retryAt = now + RETRY_MS
      // Already off (turned off by hand): nothing to do, and nothing to turn back on later.
      if (await this.d.system.sleepDisabled()) return
      if (await this.low()) return
      if (!(await this.d.sleep.set(true))) {
        if (!this.failed) this.d.log("awake: couldn't turn sleep off for a closed lid; at the Mac, run: cq awake lid on")
        this.failed = true
        return
      }
      this.failed = false
      this.holding = true
      this.checkedAt = now
      this.d.store.kvSet(KEY, { since: now })
      this.d.log('awake: sleep is off while tasks run, lid closed or not')
    } finally {
      this.busy = false
    }
  }

  /** Turns sleep back on, if this turned it off. `pauseMs`: don't turn it off again for that long. */
  async release(why: string, pauseMs = 0): Promise<void> {
    if (pauseMs) this.retryAt = this.d.now() + pauseMs
    if (!this.holding) return
    if (!(await this.d.sleep.set(false))) {
      this.d.log(`awake: couldn't turn sleep back on (${why}); at the Mac: sudo pmset -a disablesleep 0`)
      return
    }
    this.holding = false
    this.d.store.kvSet(KEY, null)
    this.d.log(`awake: sleep is on again (${why})`)
  }

  /** As the engine stops: sleep back on at once (it can't wait for a reply). */
  releaseNow(): void {
    if (!this.holding) return
    if (!this.d.sleep.setNow(false)) return
    this.holding = false
    this.d.store.kvSet(KEY, null)
  }

  private async low(): Promise<boolean> {
    const b = await this.d.system.battery()
    return b !== null && !b.charging && b.pct < LOW_BATTERY_PCT
  }
}
