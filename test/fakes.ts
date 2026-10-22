import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaneInfo, TmuxDriver } from '../src/daemon/tmux'
import { parseApps, type MacSystem, type RunningApp } from '../src/platform/mac'

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

/** For the pretend Mac below: what macOS reports, as captured on a real one. */
export const MAC_HOME = homedir()

// What NSWorkspace lists (JXA hands the activation policy over as text).
export const MAC_APPS_JXA = JSON.stringify([
  { pid: 422, name: 'loginwindow', bundleId: 'com.apple.loginwindow', path: '/System/Library/CoreServices/loginwindow.app', policy: '1' },
  { pid: 652, name: 'Finder', bundleId: 'com.apple.finder', path: '/System/Library/CoreServices/Finder.app', policy: '0' },
  { pid: 19268, name: 'Mail', bundleId: 'com.apple.mail', path: '/System/Applications/Mail.app', policy: '0' },
  { pid: 19644, name: 'Mail Web Content', bundleId: 'com.apple.WebKit.WebContent', path: null, policy: '1' },
  { pid: 83628, name: 'Vorssaint', bundleId: 'com.vorssaint.utils', path: '/Applications/Vorssaint.app', policy: '1' },
  { pid: 83739, name: 'Code', bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app', policy: '0' },
  { pid: 9001, name: 'Docker Helper', bundleId: 'com.docker.helper', path: '/Applications/Docker.app/Contents/MacOS/Docker Helper.app', policy: '1' },
  { pid: 9002, name: 'Monosnap', bundleId: 'com.monosnap.monosnap', path: `${MAC_HOME}/Applications/Monosnap.app`, policy: '1' },
  { pid: 9003, name: 'mds', bundleId: null, path: null, policy: '2' },
])

export const MAC_ASSERTIONS = (o: { vorssaint: boolean }) => `2026-10-22 20:34:57 +0545
Assertion status system-wide:
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 429(coreaudiod): [0x0015a932000186c2] 00:13:16 PreventUserIdleSystemSleep named: "com.apple.audio.AudioTap.context.preventuseridlesleep"
\tCreated for PID: 634.
   pid 83739(Code): [0x0015ac24000b8f4c] 00:00:41 PreventUserIdleDisplaySleep named: "Electron"
${o.vorssaint ? `   pid 83628(Vorssaint): [0x0015785e0001a415] 03:41:36 PreventUserIdleSystemSleep named: "Vorssaint: keep the Mac awake"
   pid 83628(Vorssaint): [0x0015785e0005a416] 03:41:36 PreventUserIdleDisplaySleep named: "Vorssaint: keep the display on"
` : ''}   pid 359(powerd): [0x001578290001a3e8] 03:42:29 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
No kernel assertions.`

export const MAC_PMSET = (disabled: boolean) => ` SleepDisabled\t\t${disabled ? 1 : 0}\n Sleep On Power Button 1\n sleep                45 (sleep prevented by coreaudiod, powerd)\n`

/** A pretend Mac: apps quit when asked (unless stubborn), and Vorssaint turns sleep off while it runs. */
export class FakeMac implements MacSystem {
  apps: RunningApp[] = parseApps(MAC_APPS_JXA)
  idle: number | null = 900
  stubborn = new Set<number>()
  asked: { pid: number; force: boolean }[] = []
  slept = 0
  /** Something other than an app turned sleep off. */
  stuckOff = false

  async runningApps() {
    return this.apps
  }
  async pmset(args: string[]) {
    const vorssaint = this.alive(83628)
    return args.includes('assertions') ? MAC_ASSERTIONS({ vorssaint }) : MAC_PMSET(vorssaint || this.stuckOff)
  }
  async terminate(pid: number, force: boolean) {
    if (!this.alive(pid)) return false
    this.asked.push({ pid, force })
    if (force || !this.stubborn.has(pid)) this.apps = this.apps.filter(a => a.pid !== pid)
    return true
  }
  alive(pid: number) {
    return this.apps.some(a => a.pid === pid)
  }
  async idleSeconds() {
    return this.idle
  }
  async sleepNow() {
    this.slept++
  }
}
