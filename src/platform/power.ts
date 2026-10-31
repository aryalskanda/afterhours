// Keeping the computer awake and putting it to sleep, with what the system itself has: nothing extra
// to install.
//
// - macOS: `caffeinate` holds off idle sleep while there's work (platform/desktop.ts). A closed lid
//   sleeps a Mac through that, so "awake with the lid closed" turns sleep off (`pmset disablesleep`)
//   while there's work, through a sudo rule that allows exactly that (`cq awake lid on`). Sleeping is
//   `pmset sleepnow`.
// - Linux: a systemd-inhibit lock holds off idle sleep, and the lid switch too when asked (no root
//   needed). Sleeping is `systemctl suspend`.
// - Windows (natively, or from WSL2): Windows' own SetThreadExecutionState holds off sleep while there's work; sleeping
//   is SetSuspendState. Both go through powershell.exe, which WSL can run too. With the lid closed,
//   Windows' own lid action is set to "do nothing" while there's work, and put back after (powercfg,
//   no administrator rights needed).
//
// The system calls sit behind PowerSystem, so tests use a fake and never sleep the computer.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { paths } from '../shared/config'
import { parseBattery } from '../daemon/health'
import { inContainer, isLinux, isMac, isWindows, isWsl } from './os'

/** 'wsl' is Windows' power, whether Afterhours runs natively on Windows or inside WSL. */
export type PowerKind = 'mac' | 'linux' | 'wsl'

export interface PowerSystem {
  readonly kind: PowerKind
  /** Whether sleep is turned off for the whole machine (macOS: pmset disablesleep). */
  sleepDisabled(): Promise<boolean>
  /** Seconds since someone last used the keyboard, mouse or trackpad; null if unknown. */
  idleSeconds(): Promise<number | null>
  /** The battery, on a laptop. */
  battery(): Promise<{ pct: number; charging: boolean } | null>
  /** Puts the computer to sleep; an error says why it couldn't. */
  sleepNow(): Promise<{ ok: boolean; error?: string }>
}

/** What "This Mac", "This computer" and "This PC" are called, for the messages. */
export function machineWord(kind: PowerKind): string {
  return kind === 'mac' ? 'Mac' : kind === 'wsl' ? 'PC' : 'computer'
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

/**
 * `loginctl show-user` (IdleHint, IdleSinceHint in microseconds): how long the person at the desktop
 * has been away; 0 when they're there; null when the desktop doesn't say.
 */
export function parseLoginctlIdle(text: string, nowMs: number): number | null {
  const hint = /^IdleHint=(yes|no)$/m.exec(text)?.[1]
  if (hint === 'no') return 0
  const since = Number(/^IdleSinceHint=(\d+)$/m.exec(text)?.[1] ?? 0)
  if (hint !== 'yes' || !since) return null
  return Math.max(0, Math.floor((nowMs - since / 1000) / 1000))
}

async function output(argv: string[], timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, out, err }
  } finally {
    clearTimeout(timer)
  }
}

export const macPower: PowerSystem = {
  kind: 'mac',
  async sleepDisabled() {
    return sleepDisabled((await output(['pmset', '-g'])).out)
  },
  async idleSeconds() {
    return parseIdle((await output(['ioreg', '-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'])).out)
  },
  async battery() {
    const out = (await output(['pmset', '-g', 'batt'])).out
    return /InternalBattery/.test(out) ? parseBattery(out, null) : null
  },
  async sleepNow() {
    const r = await output(['pmset', 'sleepnow'])
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.trim() || 'pmset sleepnow failed' }
  },
}

function linuxBattery(): { pct: number; charging: boolean } | null {
  try {
    return parseBattery(null, { capacity: readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf8'), status: readFileSync('/sys/class/power_supply/BAT0/status', 'utf8') })
  } catch {
    return null // a server or a desktop: no battery
  }
}

export const linuxPower: PowerSystem = {
  kind: 'linux',
  async sleepDisabled() {
    return false
  },
  async idleSeconds() {
    const uid = process.getuid?.()
    if (uid === undefined || !Bun.which('loginctl')) return null
    return parseLoginctlIdle((await output(['loginctl', 'show-user', String(uid), '-p', 'IdleHint', '-p', 'IdleSinceHint'])).out, Date.now())
  },
  async battery() {
    return linuxBattery()
  },
  async sleepNow() {
    const r = await output(['systemctl', 'suspend'])
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.trim() || 'systemctl suspend failed' }
  },
}

/** Windows' own idle time (GetLastInputInfo), in seconds. */
const WINDOWS_IDLE = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO i); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }' -Name U -Namespace W; $i = New-Object W.U+LASTINPUTINFO; $i.cbSize = 8; [void][W.U]::GetLastInputInfo([ref]$i); [math]::Floor(([Environment]::TickCount - $i.dwTime) / 1000)`
const WINDOWS_SLEEP = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)`

/** Charge and state of the first battery; nothing on a desktop. */
const WINDOWS_BATTERY = `$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining) $($b.BatteryStatus)" }`

/** "85 2" (percent, Win32_Battery's BatteryStatus) as a battery; 1, 4 and 5 are running on the battery. */
export function parseWindowsBattery(text: string): { pct: number; charging: boolean } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text)
  return m ? { pct: Number(m[1]), charging: ![1, 4, 5].includes(Number(m[2])) } : null
}

export function powershell(): string | null {
  return Bun.which('powershell.exe') ?? (isWsl() ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : null)
}

export const wslPower: PowerSystem = {
  kind: 'wsl',
  async sleepDisabled() {
    return false
  },
  async idleSeconds() {
    const ps = powershell()
    if (!ps) return null
    const n = Number((await output([ps, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDLE])).out.trim())
    return Number.isFinite(n) && n >= 0 ? n : null
  },
  async battery() {
    const ps = powershell()
    if (!ps) return null
    return parseWindowsBattery((await output([ps, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_BATTERY])).out)
  },
  async sleepNow() {
    const ps = powershell()
    if (!ps) return { ok: false, error: isWindows ? 'powershell.exe isn’t on the Path' : 'powershell.exe isn’t reachable from WSL' }
    const r = await output([ps, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SLEEP])
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.trim() || 'Windows didn’t sleep' }
  },
}

/** This computer's power controls; null where there's nothing to sleep (a container). */
export function powerSystem(): PowerSystem | null {
  if (isMac) return macPower
  if (isWindows) return wslPower
  if (!isLinux || inContainer()) return null
  return isWsl() ? wslPower : linuxPower
}

/**
 * Sleep turned off and on (`pmset -a disablesleep`) without a password: what keeps a Mac awake
 * with its lid closed. It takes root, so `cq awake lid on` puts a rule in /etc/sudoers.d that
 * allows exactly these two commands, and nothing else.
 */
export interface SleepSwitch {
  /** The rule is in place: it can be done without asking for a password. */
  allowed(): Promise<boolean>
  /** Turns sleep off (`true`) or back on; false if it didn't work. */
  set(off: boolean): Promise<boolean>
  /** The same, waiting for it (as the engine stops). */
  setNow(off: boolean): boolean
}

export const SUDOERS_FILE = '/etc/sudoers.d/afterhours'
const PMSET = '/usr/bin/pmset'

/** The sudoers rule for `user`: these two commands, without a password. */
export function sudoersRule(user: string): string {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) throw new Error(`not a user name: ${user}`)
  return `# Afterhours: keeps the Mac awake with its lid closed while tasks run (cq awake lid on).\n${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0\n`
}

/** A rule that was there a moment ago still is: status asks often, `sudo -l` shouldn't run every time. */
let allowedUntil = 0

export const systemSleepSwitch: SleepSwitch = {
  async allowed() {
    if (Date.now() < allowedUntil) return true
    const ok = (await output(['sudo', '-n', '-l', PMSET, '-a', 'disablesleep', '1'])).code === 0
    if (ok) allowedUntil = Date.now() + 60_000
    return ok
  },
  async set(off) {
    return (await output(['sudo', '-n', PMSET, '-a', 'disablesleep', off ? '1' : '0'])).code === 0
  },
  setNow(off) {
    return Bun.spawnSync(['sudo', '-n', PMSET, '-a', 'disablesleep', off ? '1' : '0'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  },
}

// --- Windows: the lid action --------------------------------------------------------------------
//
// "When I close the lid" is a setting of the power plan, per power source (plugged in, on battery):
// 0 does nothing. While there's work it's set to 0 and what it was is kept in a file, so a crash
// still gets it put back.

/** The lid action's values from `powercfg /query … LIDACTION`: plugged in, then on battery. Language-proof. */
export function parseLidAction(text: string): { ac: number; dc: number } | null {
  const values = [...text.matchAll(/0x([0-9a-f]{8})/gi)].map(m => parseInt(m[1]!, 16))
  return values.length >= 2 ? { ac: values.at(-2)!, dc: values.at(-1)! } : null
}

export interface PowercfgRun {
  (args: string[]): { code: number; out: string }
}

/** The SleepSwitch for Windows' lid action. `run` is powercfg, `stateFile` holds the values to put back. */
export function lidActionSwitch(run: PowercfgRun, stateFile: string): SleepSwitch {
  const LID = ['SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION']
  const write = (ac: number, dc: number) =>
    run(['/setacvalueindex', ...LID, String(ac)]).code === 0 && run(['/setdcvalueindex', ...LID, String(dc)]).code === 0 && run(['/setactive', 'SCHEME_CURRENT']).code === 0
  const apply = (off: boolean): boolean => {
    if (off) {
      if (existsSync(stateFile)) return write(0, 0) // already ours (a crash before): keep the values saved then
      const q = run(['/query', ...LID])
      const now = q.code === 0 ? parseLidAction(q.out) : null
      if (!now) return false
      if (now.ac === 0 && now.dc === 0) return true // it already does nothing: nothing to put back
      writeFileSync(stateFile, JSON.stringify(now))
      if (write(0, 0)) return true
      rmSync(stateFile, { force: true })
      return false
    }
    if (!existsSync(stateFile)) return true
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { ac: number; dc: number }
      if (!write(Number(saved.ac), Number(saved.dc))) return false
    } catch {
      // A file nobody can read: drop it rather than hold the lid forever.
    }
    rmSync(stateFile, { force: true })
    return true
  }
  return {
    async allowed() {
      return run(['/query', ...LID]).code === 0
    },
    async set(off) {
      return apply(off)
    },
    setNow: apply,
  }
}

function powercfg(): string | null {
  return Bun.which('powercfg.exe') ?? (isWsl() ? '/mnt/c/Windows/System32/powercfg.exe' : null)
}

export const windowsLidSwitch: SleepSwitch = lidActionSwitch(args => {
  const exe = powercfg()
  if (!exe) return { code: 1, out: '' }
  const r = Bun.spawnSync([exe, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  return { code: r.exitCode, out: r.stdout.toString() }
}, paths.lidAction)
