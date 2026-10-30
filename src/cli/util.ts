import type { Health } from '../daemon/main'
import { loadConfig, readToken, searchPath } from '../shared/config'
import { service } from '../platform/service'
import type { TelegramStatus } from '../telegram/bot'

export function run(argv: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(argv, { env: { ...process.env, PATH: searchPath() }, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
  } catch (err) {
    // A program that isn't there is a failure like any other (Windows throws for it).
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

/** Runs a command in this terminal (its prompts and output shown); false if it failed or isn't there. */
export function runHere(argv: string[]): boolean {
  try {
    return Bun.spawnSync(argv, { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode === 0
  } catch {
    return false
  }
}

export function daemonUrl(path: string): string {
  return `http://127.0.0.1:${process.env.CQ_PORT ?? loadConfig().port}${path}`
}

export async function daemonHealth(): Promise<Health | null> {
  try {
    const res = await fetch(daemonUrl('/api/health'), { signal: AbortSignal.timeout(3000) })
    return (await res.json()) as Health
  } catch {
    return null
  }
}

export async function daemonTelegram(): Promise<TelegramStatus | null> {
  try {
    const res = await fetch(daemonUrl('/api/telegram'), {
      headers: { 'x-cq-token': readToken() ?? '' },
      signal: AbortSignal.timeout(3000),
    })
    return res.ok ? ((await res.json()) as TelegramStatus) : null
  } catch {
    return null
  }
}

/** Set up to run in the background (a LaunchAgent, a systemd user service). */
export function agentLoaded(): boolean {
  return service().installed()
}

/** Restarts the installed daemon; false when it isn't installed. */
export function restartAgent(): boolean {
  return service().restart()
}

/** Asks a question on the terminal; empty input returns the default. */
export function ask(question: string, fallback = ''): string {
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ''}`)
  return (answer ?? '').trim() || fallback
}

export function confirmYes(question: string): boolean {
  return /^y(es)?$/i.test(ask(`${question} (Y/n)`, 'y'))
}
