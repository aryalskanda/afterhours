// Back online by itself: when the Wi-Fi (or a phone's hotspot) drops and the computer stays
// offline, it turns the Wi-Fi off and on (the system rejoins the network it knows best), then tries
// the saved networks one by one, your preferred ones first. Never while someone is using the
// computer, and never when there's no Wi-Fi to reconnect (a cable, a server). It says so once it's
// back, so you know why messages came late.

import type { WifiSystem } from '../platform/network'

/** Offline this long before it does anything: a blip sorts itself out. */
export const OFFLINE_FOR_MS = 60_000
/** Between one step and the next: time for the system to join and get an address. */
export const STEP_WAIT_MS = 30_000
/** After every step failed: a rest before starting over. */
export const REST_MS = 5 * 60_000
/** Someone who used the keyboard or mouse this recently is there to fix it themselves. */
const SOMEONE_THERE_SEC = 300

export interface NetworkDeps {
  wifi: WifiSystem
  /** Whether the internet answers now. */
  online(): Promise<boolean>
  /** Seconds since the keyboard or mouse was used; null if unknown. */
  idleSeconds(): Promise<number | null>
  config(): { reconnect: boolean; prefer: string[] }
  /** Tells you it's back: when it dropped, how long, and what brought it back (null: by itself). */
  backOnline(o: { since: number; how: string | null }): void
  now(): number
  log(line: string): void
}

type Step = { kind: 'cycle' } | { kind: 'join'; name: string }

/** The steps, in order: Wi-Fi off and on, then each saved network, preferred ones first. */
export function reconnectSteps(saved: string[], prefer: string[], canCycle = true): Step[] {
  const first = prefer.filter(p => saved.includes(p))
  const rest = saved.filter(s => !first.includes(s))
  return [...(canCycle ? [{ kind: 'cycle' } as Step] : []), ...[...first, ...rest].map(name => ({ kind: 'join', name }) as Step)]
}

function stepText(s: Step): string {
  return s.kind === 'cycle' ? 'turned the Wi-Fi off and on' : `joined “${s.name}”`
}

export class NetworkWatch {
  private offlineSince: number | null = null
  private steps: Step[] | null = null
  private next = 0
  private nextAt = 0
  private last: Step | null = null
  private busy = false
  private toldThere = false

  constructor(private readonly d: NetworkDeps) {}

  /** Every 30 seconds or so. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.check()
    } finally {
      this.busy = false
    }
  }

  private async check(): Promise<void> {
    const config = this.d.config()
    if (!config.reconnect) return this.reset()
    const now = this.d.now()
    if (await this.d.online()) {
      if (this.offlineSince !== null && this.steps !== null) {
        const how = this.last ? stepText(this.last) : null
        this.d.log(`network: back online after ${Math.round((now - this.offlineSince) / 1000)}s${how ? ` (${how})` : ''}`)
        this.d.backOnline({ since: this.offlineSince, how })
      }
      return this.reset()
    }
    if (this.offlineSince === null) {
      this.offlineSince = now
      return
    }
    if (now - this.offlineSince < OFFLINE_FOR_MS || now < this.nextAt) return
    const idle = await this.d.idleSeconds()
    if (idle !== null && idle < SOMEONE_THERE_SEC) {
      if (!this.toldThere) this.d.log('network: offline, but someone is using the computer; leaving it to them')
      this.toldThere = true
      return
    }
    const device = await this.d.wifi.device()
    if (!device) return // no Wi-Fi: a cable or a server, nothing to reconnect
    if (this.steps === null) {
      this.steps = reconnectSteps(await this.d.wifi.saved(device), config.prefer)
      this.next = 0
      this.d.log(`network: offline for ${Math.round((now - this.offlineSince) / 1000)}s; reconnecting (${this.steps.length} step${this.steps.length === 1 ? '' : 's'})`)
    }
    if (this.next >= this.steps.length) {
      this.d.log(`network: still offline after every step; trying again in ${REST_MS / 60_000} minutes`)
      this.next = 0
      this.nextAt = now + REST_MS
      return
    }
    const step = this.steps[this.next++]!
    const ok = step.kind === 'cycle' ? await this.d.wifi.cycle(device) : await this.d.wifi.join(device, step.name)
    this.d.log(`network: ${step.kind === 'cycle' ? 'turning the Wi-Fi off and on' : `joining “${step.name}”`}${ok ? '' : ': it didn’t work'}`)
    if (ok) this.last = step
    this.nextAt = this.d.now() + STEP_WAIT_MS
  }

  private reset(): void {
    this.offlineSince = null
    this.steps = null
    this.next = 0
    this.nextAt = 0
    this.last = null
    this.toldThere = false
  }
}
