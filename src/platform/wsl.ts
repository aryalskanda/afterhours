// Windows (WSL2) shuts Ubuntu down a few seconds after the last window using it closes, and
// Afterhours with it, systemd service or not. A scheduled task at sign-in (Windows' own, made
// through schtasks.exe, which WSL can run) holds Ubuntu open with a process that never ends.

import { isWsl } from './os'

export const KEEP_TASK = 'Afterhours'

/** The command the task runs: a hidden PowerShell holding this distro open. */
export function keepTaskCommand(distro: string): string {
  return `powershell.exe -WindowStyle Hidden -Command wsl.exe -d ${distro} --exec sleep infinity`
}

/** `schtasks.exe` arguments that make the sign-in task (replacing an older one). */
export function createTaskArgs(distro: string): string[] {
  return ['/Create', '/F', '/TN', KEEP_TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', keepTaskCommand(distro)]
}

function schtasks(args: string[]): { ok: boolean; out: string } {
  const exe = Bun.which('schtasks.exe') ?? '/mnt/c/Windows/System32/schtasks.exe'
  try {
    const r = Bun.spawnSync([exe, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

/** Whether the sign-in task is there. */
export function keepTaskExists(): boolean {
  return isWsl() && schtasks(['/Query', '/TN', KEEP_TASK]).ok
}

/** Makes the task and starts it now. `text` says what happened, or what to do by hand. */
export function keepWslRunning(distro = process.env.WSL_DISTRO_NAME): { ok: boolean; text: string } {
  if (!isWsl() || !distro) return { ok: false, text: 'Not inside WSL.' }
  const made = schtasks(createTaskArgs(distro))
  if (!made.ok) {
    return {
      ok: false,
      text: `Couldn't add the sign-in task that keeps Ubuntu running (${made.out.split('\n')[0] || 'schtasks failed'}). In a Windows PowerShell, run: ${keepTaskCommand(distro)}`,
    }
  }
  schtasks(['/Run', '/TN', KEEP_TASK])
  return { ok: true, text: 'Ubuntu now keeps running while you are signed in to Windows, even with its window closed.' }
}
