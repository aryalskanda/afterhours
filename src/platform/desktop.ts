// Things a desktop computer has and a server doesn't: sleep, Full Disk Access, VS Code windows.

import type { Subprocess } from 'bun'
import { closeSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import { hasDisplay, isLinux, isMac, isWsl } from './os'
import { powershell } from './power'

/**
 * Keeps the computer from going to sleep while there's queued or running work, with the system's own
 * tools: a `caffeinate` assertion on macOS; a systemd-inhibit lock on Linux, which with `lid` holds
 * off the lid switch too; on Windows (WSL2), SetThreadExecutionState in a powershell.exe that lives
 * as long as this does. Each ends with the daemon, even if it crashes.
 */
export class KeepAwake {
  private proc: Subprocess | null = null
  private lid = false

  /** Holding the computer awake right now. */
  get holding(): boolean {
    return this.proc !== null
  }

  set(on: boolean, o: { lid?: boolean } = {}): void {
    const lid = o.lid ?? false
    // The lid switch changed while holding: hold again, the new way.
    if (on && this.proc && lid !== this.lid) this.set(false)
    if (on && !this.proc) {
      const argv = keepAwakeCommand(process.pid, { lid })
      try {
        // WSL: powershell.exe stops once its input closes, which is when this process ends.
        if (argv) this.proc = Bun.spawn(argv, { stdin: isWsl() ? 'pipe' : 'ignore', stdout: 'ignore', stderr: 'ignore' })
        this.lid = lid
      } catch {
        // Staying awake is a nicety; never worth failing over.
      }
    } else if (!on && this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

/** Windows: system required (continuously) until stdin closes. ES_CONTINUOUS | ES_SYSTEM_REQUIRED. */
const WINDOWS_AWAKE = `$s = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; [void]$s::SetThreadExecutionState(0x80000001); while ($null -ne [Console]::In.ReadLine()) {}`

export function keepAwakeCommand(pid: number, o: { lid?: boolean } = {}): string[] | null {
  if (isMac) return ['caffeinate', '-i', '-w', String(pid)]
  if (isWsl()) {
    const ps = powershell()
    return ps ? [ps, '-NoProfile', '-NonInteractive', '-Command', WINDOWS_AWAKE] : null
  }
  const inhibit = isLinux ? Bun.which('systemd-inhibit') : null
  if (!inhibit) return null
  return [
    inhibit,
    `--what=idle:sleep${o.lid ? ':handle-lid-switch' : ''}`,
    `--who=${BRAND.name}`,
    '--why=Claude Code tasks are running',
    '--mode=block',
    'sh',
    '-c',
    `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`,
  ]
}

/**
 * Whether this process may read files macOS protects with Full Disk Access (and so work in
 * ~/Documents without prompts nobody is there to click). Other systems have no such thing.
 */
export function hasFullDiskAccess(): boolean {
  if (!isMac) return true
  try {
    // chat.db is protected, and checking it never pops up a prompt.
    closeSync(openSync(join(homedir(), 'Library', 'Messages', 'chat.db'), 'r'))
    return true
  } catch {
    return false
  }
}

/** Whether VS Code is running on this desktop (never started just to show a chat). */
function vsCodeRunning(): boolean {
  try {
    if (isMac) return Bun.spawnSync(['pgrep', '-f', 'Visual Studio Code.app/Contents/MacOS/']).exitCode === 0
    return Bun.spawnSync(['pgrep', '-x', 'code']).exitCode === 0
  } catch {
    return false // no pgrep
  }
}

/**
 * Opens a conversation in the VS Code that's running, so it shows what a task did with it. Does
 * nothing without a desktop (a server, VS Code connected over SSH) or without VS Code open.
 */
/** Opens a conversation in VS Code on this machine's screen, starting VS Code if it isn't running. */
export function openInVsCode(sessionId: string, log: (line: string) => void): boolean {
  if (!hasDisplay()) return false
  const url = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
  const opener = isMac ? ['open', url] : Bun.which('xdg-open') ? ['xdg-open', url] : null
  if (!opener) return false
  Bun.spawn(opener, { stdout: 'ignore', stderr: 'ignore' })
  log(`opened chat ${sessionId} in VS Code, as an app asked`)
  return true
}

export function reopenInVsCode(sessionId: string, log: (line: string) => void): void {
  if (!hasDisplay() || !vsCodeRunning()) return
  const url = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
  const opener = isMac ? ['open', '-g', url] : Bun.which('xdg-open') ? ['xdg-open', url] : null
  if (!opener) return
  Bun.spawn(opener, { stdout: 'ignore', stderr: 'ignore' })
  log(`opened chat ${sessionId} in VS Code again`)
}
