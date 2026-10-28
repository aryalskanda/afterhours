import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaneInfo, TmuxDriver } from '../src/daemon/tmux'
import type { PowerKind, PowerSystem, SleepSwitch } from '../src/platform/power'

/** root/{alpha(repo)/src/components, alpha/node_modules/x, beta/docs, beta/build/out, gamma-web/web/app, .hidden/x} */
export function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-tree-'))
  for (const dir of ['alpha/.git', 'alpha/src/components', 'alpha/node_modules/x', 'beta/docs', 'gamma-web/web/app', '.hidden/x', 'beta/build/out']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, 'beta', 'README.md'), '# beta')
  return root
}

export interface FakeWindow {
  cwd: string
  env: Record<string, string>
  argv: string[]
  dead: boolean
  deadStatus: number | null
  screen: string
  input: string[]
  /** The pane's process, for a test with fake processes (see kill). */
  pid?: number
}

/** Records what the runner does to tmux; tests set `screen`/`dead` to play Claude's side. */
export class FakeTmux implements TmuxDriver {
  windows = new Map<string, FakeWindow>()

  async spawnWindow(name: string, cwd: string, env: Record<string, string>, argv: string[]): Promise<void> {
    this.windows.set(name, { cwd, env, argv, dead: false, deadStatus: null, screen: '', input: [] })
  }
  async pane(name: string): Promise<PaneInfo | null> {
    const w = this.windows.get(name)
    // No real process behind a fake window, unless a test gives it one (and fake processes).
    return w ? { dead: w.dead, deadStatus: w.deadStatus, pid: w.pid ?? null } : null
  }
  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    this.must(name).input.push(...keys)
  }
  async sendText(name: string, text: string): Promise<void> {
    this.must(name).input.push(`text:${text}`)
  }
  async capture(name: string): Promise<string> {
    return this.windows.get(name)?.screen ?? ''
  }
  async killWindow(name: string): Promise<void> {
    this.windows.delete(name)
  }
  private must(name: string): FakeWindow {
    const w = this.windows.get(name)
    if (!w) throw new Error(`no window ${name}`)
    return w
  }
}

/** A pretend computer that sleeps when asked (only counting it), for every system Afterhours runs on. */
export class FakePower implements PowerSystem {
  idle: number | null = 900
  slept = 0
  /** Sleep is turned off for the whole machine (macOS: pmset disablesleep). */
  stuckOff = false
  /** Sleeping fails with this (a polkit refusal, say). */
  sleepFails: string | null = null
  batteryNow: { pct: number; charging: boolean } | null = { pct: 100, charging: true }
  constructor(readonly kind: PowerKind = 'mac') {}

  async sleepDisabled() {
    return this.stuckOff
  }
  async idleSeconds() {
    return this.idle
  }
  async battery() {
    return this.batteryNow
  }
  async sleepNow() {
    if (this.sleepFails) return { ok: false, error: this.sleepFails }
    this.slept++
    return { ok: true }
  }
}

/** Turning sleep off and on, on a FakePower Mac: with the sudo rule in place (`allowed`) or not. */
export class FakeSleepSwitch implements SleepSwitch {
  allowedNow = true
  calls: boolean[] = []
  constructor(private readonly mac: FakePower) {}
  async allowed() {
    return this.allowedNow
  }
  async set(off: boolean) {
    return this.setNow(off)
  }
  setNow(off: boolean) {
    if (!this.allowedNow) return false
    this.calls.push(off)
    this.mac.stuckOff = off
    return true
  }
}
