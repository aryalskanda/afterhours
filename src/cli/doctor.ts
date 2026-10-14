import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../daemon/main'
import { isTrusted } from '../daemon/sessions'
import { BRAND } from '../shared/brand'
import { codeRoots, findExecutable, loadConfig, paths, readToken } from '../shared/config'
import { launcherPath } from './install'
import { agentLoaded, daemonHealth, run } from './util'

export interface Check {
  level: 'ok' | 'bad' | 'info'
  text: string
}

export interface ClaudeStatus {
  path: string | null
  version: string | null
  loggedIn: boolean
  authMethod: string | null
}

export function claudeStatus(): ClaudeStatus {
  const path = findExecutable('claude', loadConfig().claudePath)
  if (!path) return { path: null, version: null, loggedIn: false, authMethod: null }
  const version = run([path, '--version']).out.split('\n')[0] ?? null
  let loggedIn = false
  let authMethod: string | null = null
  try {
    const status = JSON.parse(run([path, 'auth', 'status']).out) as { loggedIn?: boolean; authMethod?: string }
    loggedIn = status.loggedIn === true
    authMethod = status.authMethod ?? null
  } catch {
    // older Claude Code without `auth status`: assume signed in, the first job will tell
    loggedIn = true
  }
  return { path, version, loggedIn, authMethod }
}

export async function checks(): Promise<Check[]> {
  const out: Check[] = []
  const ok = (text: string) => out.push({ level: 'ok', text })
  const bad = (text: string) => out.push({ level: 'bad', text })
  const info = (text: string) => out.push({ level: 'info', text })
  const config = loadConfig()

  const claude = claudeStatus()
  if (!claude.path) bad('Claude Code not found: install it from https://claude.com/claude-code')
  else if (!claude.loggedIn) bad(`Claude Code ${claude.version} is not signed in: run \`claude\` and sign in`)
  else ok(`Claude Code: ${claude.version}, signed in${claude.authMethod ? ` (${claude.authMethod})` : ''}`)

  const tmux = findExecutable('tmux', config.tmuxPath)
  if (tmux) ok(`tmux: ${run([tmux, '-V']).out}`)
  else bad('tmux not found: brew install tmux')

  const health = await daemonHealth()
  if (!health) {
    bad(`${BRAND.name} is not running (cq install, or cq daemon to run it in this terminal)`)
  } else {
    ok(`${BRAND.name} ${health.version} is running (pid ${health.pid}, ${health.home})`)
    if (health.fullDiskAccess) ok('Full Disk Access: yes (Claude sessions can work in your folders unattended)')
    else bad(`Full Disk Access: missing. Add ${existsSync(launcherPath) ? launcherPath : paths.binary} in System Settings → Privacy & Security → Full Disk Access, then cq restart`)
    const tg = health.telegram
    if ('bot' in tg && tg.ok && tg.paired) ok(`Telegram: ${tg.bot} · paired with ${tg.owner ?? 'you'}`)
    else if ('bot' in tg && tg.ok) bad(`Telegram: ${tg.bot} is running but not paired yet (cq telegram shows the code)`)
    else if (config.telegram.enabled) bad(`Telegram: ${tg.error ?? 'not running'}`)
    else info('Telegram: not set up (cq telegram <token>)')
    const im = health.imessage
    if (im.ok && 'selfChats' in im) ok(`iMessage: reading chat.db · ${im.selfChats} chat(s) with yourself`)
    else if (config.imessage.enabled) bad(`iMessage: ${im.error}`)
  }

  if (agentLoaded()) ok('Starts at login')
  else info('Not set to start at login: run cq install')
  if (!readToken()) bad(`no token at ${paths.token} (the daemon creates it)`)

  info(`Code folders: ${codeRoots(config).map(r => r.replace(homedir(), '~')).join(', ')}`)
  for (const [name, dir] of Object.entries(config.aliases)) {
    const trusted = config.trustedDirs.includes(dir) || isTrusted(dir)
    info(`project ${name} → ${dir}${existsSync(dir) ? '' : ' (missing!)'}${trusted ? '' : ' (Claude will ask to trust it on first run)'}`)
  }
  const d = config.defaults
  info(
    `New tasks: ${d.review ? 'review' : d.plan ? 'plan' : 'no plan'} → ${d.execMode} · ${d.model}/${d.effort} · ` +
      `${config.isolate ? 'own branch' : 'in your checkout'} · notifications ${config.notify}`,
  )
  return out
}

const SYMBOL = { ok: '✔', bad: '✖', info: '•' }

export function formatChecks(list: Check[]): string {
  return list.map(c => `${SYMBOL[c.level]} ${c.text}`).join('\n')
}

export async function doctor(): Promise<void> {
  console.log(formatChecks(await checks()))
}

/** Hides bot tokens and your home path. */
export function redact(text: string): string {
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{25,}/g, '<telegram-token>').split(homedir()).join('~')
}

/**
 * A log line without what quotes your prompts or Claude's replies: notices keep only their type,
 * and older "launched" lines lose the session name.
 */
export function redactLogLine(line: string): string {
  return line
    .replace(/(notice \w+):.*$/, '$1: <text left out>')
    .replace(/(--name ).*?(?= --)/, '$1<left out>')
    .replace(/(paired with) .*$/, '$1 <you>')
}

/** A text file for support: versions, checks, settings and recent activity, but no prompts or code. */
export async function report(): Promise<void> {
  const config = loadConfig()
  const sections: string[] = []
  sections.push(`${BRAND.name} ${VERSION} report · ${new Date().toISOString()}`)
  sections.push(`macOS ${run(['sw_vers', '-productVersion']).out} · ${process.arch}`)
  sections.push(`== Checks ==\n${formatChecks(await checks())}`)

  const safeConfig = {
    ...config,
    telegram: { ...config.telegram, token: config.telegram.token ? '<set>' : null, ownerId: config.telegram.ownerId ? '<set>' : null, ownerName: null },
  }
  sections.push(`== Settings ==\n${JSON.stringify(safeConfig, null, 2)}`)

  if (existsSync(paths.db)) {
    const db = new Database(paths.db, { readonly: true })
    try {
      const jobs = db
        .query(
          `SELECT id, status, phase, plan, review, exec_mode, model, effort, isolate, launches, source,
                  substr(hold_reason, 1, 80) AS hold_reason, substr(error, 1, 80) AS error,
                  datetime(created_at / 1000, 'unixepoch') AS created, datetime(finished_at / 1000, 'unixepoch') AS finished
           FROM jobs ORDER BY id DESC LIMIT 20`,
        )
        .all()
      sections.push(`== Recent jobs (prompts left out) ==\n${jobs.map(j => JSON.stringify(j)).join('\n')}`)
      const events = db
        .query(`SELECT job_id, datetime(ts / 1000, 'unixepoch') AS at, type, data FROM events ORDER BY id DESC LIMIT 80`)
        .all()
      sections.push(`== Recent events ==\n${events.map(e => JSON.stringify(e)).join('\n')}`)
    } finally {
      db.close()
    }
  }
  if (existsSync(paths.log)) {
    const lines = readFileSync(paths.log, 'utf8').split('\n').slice(-300).map(redactLogLine)
    sections.push(`== Log (last 300 lines) ==\n${lines.join('\n')}`)
  }

  const desktop = join(homedir(), 'Desktop')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const file = join(existsSync(desktop) ? desktop : paths.home, `${BRAND.slug}-report-${stamp}.txt`)
  writeFileSync(file, redact(sections.join('\n\n')) + '\n')
  console.log(`Wrote ${file}\nIt has no prompts or code (bot tokens and your home path are hidden), but skim it before sharing.`)
}
