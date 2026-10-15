// Things a desktop computer has and a server doesn't: sleep, Full Disk Access, VS Code windows.

import type { Subprocess } from 'bun'
import { closeSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import { hasDisplay, isLinux, isMac } from './os'

/**
 * Keeps the computer from going to sleep while there's queued or running work: a `caffeinate`
 * assertion on macOS, a systemd-inhibit lock on Linux (laptops; servers don't sleep). Either one
 * ends with the daemon, even if it crashes.
 */
export class KeepAwake {
  private proc: Subprocess | null = null

  set(on: boolean): void {
    if (on && !this.proc) {
      const argv = keepAwakeCommand(process.pid)
      try {
        if (argv) this.proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      } catch {
        // Staying awake is a nicety; never worth failing over.
      }
    } else if (!on && this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

export function keepAwakeCommand(pid: number): string[] | null {
  if (isMac) return ['caffeinate', '-i', '-w', String(pid)]
  const inhibit = isLinux ? Bun.which('systemd-inhibit') : null
  if (!inhibit) return null
  return [
    inhibit,
    '--what=idle:sleep',
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
export function reopenInVsCode(sessionId: string, log: (line: string) => void): void {
  if (!hasDisplay() || !vsCodeRunning()) return
  const url = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
  const opener = isMac ? ['open', '-g', url] : Bun.which('xdg-open') ? ['xdg-open', url] : null
  if (!opener) return
  Bun.spawn(opener, { stdout: 'ignore', stderr: 'ignore' })
  log(`opened chat ${sessionId} in VS Code again`)
}
