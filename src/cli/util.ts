import { userInfo } from 'node:os'
import type { Health } from '../daemon/main'
import { LAUNCH_AGENT_LABEL, loadConfig, readToken, searchPath } from '../shared/config'
import type { TelegramStatus } from '../telegram/bot'

export function run(argv: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(argv, { env: { ...process.env, PATH: searchPath() }, stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
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

export function launchDomain(): string {
  return `gui/${userInfo().uid}`
}

export function agentLoaded(): boolean {
  return run(['launchctl', 'print', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]).ok
}

/** Restarts the installed daemon; false when it isn't installed. */
export function restartAgent(): boolean {
  return run(['launchctl', 'kickstart', '-k', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]).ok
}

/** Asks a question on the terminal; empty input returns the default. */
export function ask(question: string, fallback = ''): string {
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ''}`)
  return (answer ?? '').trim() || fallback
}

export function confirmYes(question: string): boolean {
  return /^y(es)?$/i.test(ask(`${question} (Y/n)`, 'y'))
}
