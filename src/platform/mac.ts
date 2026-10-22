// Your Mac from your phone: the apps that are open (to quit one), what keeps the Mac awake, and
// putting it to sleep. macOS only. The system calls sit behind MacSystem, so tests use a fake and
// never quit an app or sleep the Mac.
//
// Quitting asks the app the way the Dock does (NSRunningApplication's terminate, the 'quit' Apple
// event, which needs no Automation permission); force quitting ends it at once. Sleeping is
// `pmset sleepnow`, which sleeps through everything but `pmset disablesleep` (what keep-awake apps
// such as Vorssaint turn on, so even closing the lid doesn't sleep the Mac).

import { homedir } from 'node:os'
import { isMac } from './os'

/** An app as macOS lists it (NSWorkspace's runningApplications). */
export interface RunningApp {
  pid: number
  name: string | null
  bundleId: string | null
  /** The app's bundle on disk, if it has one. */
  path: string | null
  /** 0: a regular app (in the Dock), 1: one without a Dock icon (the menu bar's), 2: in the background. */
  policy: number
}

export interface MacApp {
  pid: number
  name: string
  bundleId: string | null
  /** A regular app, or one that lives in the menu bar. */
  kind: 'app' | 'menu'
  /** It holds an assertion that keeps the Mac awake. */
  keepsAwake: boolean
}

/** One line of `pmset -g assertions`: who holds what. */
export interface Assertion {
  pid: number
  process: string
  type: string
  name: string
}

export interface MacSystem {
  runningApps(): Promise<RunningApp[]>
  /** `pmset` with these arguments: its output. */
  pmset(args: string[]): Promise<string>
  /** Asks the app to quit (or ends it, with `force`); false when it couldn't be asked. */
  terminate(pid: number, force: boolean): Promise<boolean>
  alive(pid: number): boolean
  /** Seconds since someone last used the keyboard, mouse or trackpad; null if unknown. */
  idleSeconds(): Promise<number | null>
  sleepNow(): Promise<void>
}

/** Apps you'd quit: regular ones, and menu-bar ones installed in an Applications folder. */
export function listApps(running: RunningApp[], assertions: Assertion[], home = homedir()): MacApp[] {
  const folders = ['/Applications/', `${home}/Applications/`]
  const awake = new Set(assertions.filter(a => KEEPS_AWAKE.has(a.type)).map(a => a.pid))
  const out: MacApp[] = []
  for (const a of running) {
    if (!a.name || a.pid <= 1 || NEVER_QUIT.has(a.bundleId ?? '')) continue
    // A menu-bar app is an app of its own in an Applications folder; anything else without a Dock
    // icon is part of the system or a helper inside another app.
    const topLevel = a.path !== null && folders.some(f => a.path!.startsWith(f) && !a.path!.slice(f.length).includes('/')) && a.path.endsWith('.app')
    const kind = a.policy === 0 ? 'app' : a.policy === 1 && topLevel ? 'menu' : null
    if (!kind) continue
    out.push({ pid: a.pid, name: a.name, bundleId: a.bundleId, kind, keepsAwake: awake.has(a.pid) })
  }
  return out.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'app' ? -1 : 1))
}

/** Assertions that keep the Mac from sleeping by itself (not just its display). */
const KEEPS_AWAKE = new Set(['PreventUserIdleSystemSleep', 'PreventSystemSleep', 'NoIdleSleepAssertion'])
/** Always running, and not quit from a phone. */
const NEVER_QUIT = new Set(['com.apple.finder', 'com.apple.loginwindow', 'com.apple.dock', 'com.apple.systemuiserver'])

export function parseApps(json: string): RunningApp[] {
  const raw = JSON.parse(json) as { pid: unknown; name: unknown; bundleId: unknown; path: unknown; policy: unknown }[]
  return raw.map(a => ({
    pid: Number(a.pid),
    name: typeof a.name === 'string' && a.name ? a.name : null,
    bundleId: typeof a.bundleId === 'string' && a.bundleId ? a.bundleId : null,
    path: typeof a.path === 'string' && a.path ? a.path : null,
    // JXA hands enums over as text.
    policy: Number(a.policy),
  }))
}

/** `pmset -g assertions`, the part listed by owning process. */
export function parseAssertions(text: string): Assertion[] {
  const out: Assertion[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*pid (\d+)\((.*?)\): \[0x[0-9a-f]+\] [\d:]+ (\w+) named: "(.*)"/.exec(line)
    if (m) out.push({ pid: Number(m[1]), process: m[2]!, type: m[3]!, name: m[4]! })
  }
  return out
}

/**
 * What to quit before sleeping: with sleep turned off, the menu-bar apps that keep the Mac awake
 * (a keep-awake app such as Vorssaint turns it off). A browser playing a video holds the same kind
 * of assertion, but `pmset sleepnow` sleeps through that.
 */
export function quitBeforeSleep(apps: MacApp[], disabled: boolean): MacApp[] {
  return disabled ? apps.filter(a => a.keepsAwake && a.kind === 'menu') : []
}

/** Whether `pmset -g` says sleep is turned off (pmset disablesleep). */
export function sleepDisabled(pmsetG: string): boolean {
  return /^\s*SleepDisabled\s+1\s*$/m.test(pmsetG)
}

/** `ioreg -c IOHIDSystem`'s HIDIdleTime (nanoseconds), in seconds. */
export function parseIdle(ioreg: string): number | null {
  const m = /"HIDIdleTime" = (\d+)/.exec(ioreg)
  return m ? Math.floor(Number(m[1]) / 1e9) : null
}

async function output(argv: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { code, out }
  } finally {
    clearTimeout(timer)
  }
}

const LIST_APPS = `
ObjC.import('AppKit')
const apps = $.NSWorkspace.sharedWorkspace.runningApplications
const out = []
for (let i = 0; i < apps.count; i++) {
  const a = apps.objectAtIndex(i)
  out.push({ pid: a.processIdentifier, name: ObjC.unwrap(a.localizedName), bundleId: ObjC.unwrap(a.bundleIdentifier), path: ObjC.unwrap(a.bundleURL.path), policy: a.activationPolicy })
}
JSON.stringify(out)
`

const terminateScript = (pid: number, force: boolean) => `
ObjC.import('AppKit')
const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})
a.isNil() ? 'gone' : a.${force ? 'forceTerminate' : 'terminate'} ? 'asked' : 'refused'
`

export const systemMac: MacSystem = {
  async runningApps() {
    const r = await output(['osascript', '-l', 'JavaScript', '-e', LIST_APPS])
    if (r.code !== 0) throw new Error("couldn't list the apps")
    return parseApps(r.out)
  },
  async pmset(args) {
    return (await output(['pmset', ...args])).out
  },
  async terminate(pid, force) {
    if (!Number.isInteger(pid) || pid <= 1) return false
    const r = await output(['osascript', '-l', 'JavaScript', '-e', terminateScript(pid, force)])
    return r.code === 0 && r.out.trim() === 'asked'
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  async idleSeconds() {
    return parseIdle((await output(['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'])).out)
  },
  async sleepNow() {
    await output(['pmset', 'sleepnow'])
  },
}

/** This Mac's controls, or null on other systems. */
export function macSystem(): MacSystem | null {
  return isMac ? systemMac : null
}
