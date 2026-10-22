import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { BRAND } from '../shared/brand'
import { expandHome, type Config } from '../shared/config'
import type { Approval, Effort, ExecMode, JobSpec, SessionPolicy } from '../shared/types'
import { chatState, type ChatSource } from './chats'
import { duration, excerpt, jobLine, oneLine, projectLabel } from './format'
import { formatClock } from './limits'
import type { Runner } from './runner'
import { findSessions, isTrusted } from './sessions'
import type { Store } from './store'

export interface CommandContext {
  runner: Runner
  store: Store
  config: () => Config
  saveConfig: (config: Config) => void
  now: () => number
  /** Working directory of a `cq` CLI call; jobs queued from the CLI default to it. */
  cwd?: string
  source: 'cli' | 'imessage' | 'remote'
  /** Your conversations, for `chats`. */
  chats?: ChatSource
  /** Checks a job before it's queued (remote access applies the machine's rules); a string refuses it. */
  guard?: (spec: JobSpec) => string | null
}

const EFFORTS: Record<string, Effort> = {
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}
const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]', 'opusplan', 'best'])
const EXEC: Record<string, ExecMode> = {
  auto: 'auto',
  edits: 'acceptEdits',
  acceptedits: 'acceptEdits',
  yolo: 'bypassPermissions',
  bypass: 'bypassPermissions',
  ask: 'plan',
}

export interface QueueOptions {
  project?: string
  plan?: boolean
  review?: boolean
  execMode?: ExecMode
  model?: string
  effort?: Effort
  policy?: SessionPolicy
  sessionId?: string
  isolate?: boolean
  takeover?: boolean
  front?: boolean
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function aliasPath(config: Config, name: string): string | undefined {
  const key = Object.keys(config.aliases).find(k => k.toLowerCase() === name.toLowerCase())
  return key ? config.aliases[key] : undefined
}

/** Applies one option word to `out`. Returns false if the word isn't an option. */
export function applyOption(token: string, config: Config, out: QueueOptions): boolean {
  const t = token.toLowerCase()
  if (t in EFFORTS) {
    out.effort = EFFORTS[t]
    return true
  }
  if (MODELS.has(t) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(t)) {
    out.model = t
    return true
  }
  const [first, second] = t.split('+')
  if ((first === 'plan' || first === 'review') && (second === undefined || second in EXEC)) {
    out.plan = true
    out.review = first === 'review'
    if (second) out.execMode = EXEC[second]
    return true
  }
  if (second === undefined && t in EXEC) {
    out.plan = false
    out.review = false
    out.execMode = EXEC[t]
    return true
  }
  if (t === 'new') {
    out.policy = 'new'
    return true
  }
  if (t === 'now') {
    out.front = true
    return true
  }
  if (t === 'branch') {
    out.isolate = true
    return true
  }
  if (t === 'here') {
    out.isolate = false
    return true
  }
  if (t === 'take') {
    out.takeover = true
    return true
  }
  if (t.startsWith('@') && t.length >= 7) {
    out.policy = 'session'
    out.sessionId = t.slice(1)
    return true
  }
  const alias = aliasPath(config, t)
  if (alias) {
    out.project = alias
    return true
  }
  if ((token.startsWith('/') || token.startsWith('~/')) && isDir(expandHome(token))) {
    out.project = resolve(expandHome(token))
    return true
  }
  return false
}

/**
 * "nacho plan opus max: add CSV export" → options + prompt. The words before the first
 * colon count as options only if every one of them is an option; otherwise it's all prompt.
 */
export function parseQueueText(text: string, config: Config): { options: QueueOptions; prompt: string } {
  const colon = text.indexOf(':')
  if (colon > 0) {
    const tokens = text.slice(0, colon).trim().split(/\s+/).filter(Boolean)
    const options: QueueOptions = {}
    if (tokens.length > 0 && tokens.every(t => applyOption(t, config, options))) {
      return { options, prompt: text.slice(colon + 1).trim() }
    }
  }
  return { options: {}, prompt: text.trim() }
}

export function buildSpec(text: string, ctx: CommandContext): JobSpec | string {
  const config = ctx.config()
  const d = config.defaults
  const { options, prompt } = parseQueueText(text, config)
  let projectDir = options.project
  let sessionId: string | undefined
  if (options.sessionId) {
    const found = findSessions(options.sessionId)
    if (found.length === 0) return `No conversation id starts with ${options.sessionId}.`
    if (found.length > 1) return `${options.sessionId} matches ${found.length} conversations; use more of the id.`
    sessionId = found[0]!.sessionId
    projectDir ??= found[0]!.cwd ?? undefined
  }
  const cliDir = ctx.source === 'cli' && ctx.cwd && ctx.cwd !== homedir() ? ctx.cwd : undefined
  projectDir ??= cliDir ?? d.project ?? ctx.store.kvGet<string>('lastProject')
  if (!projectDir) {
    const names = Object.keys(config.aliases)
    return `Which project? Reply q <project>: <prompt>${names.length ? ` (projects: ${names.join(', ')})` : ', after adding one with alias <name> <path>'}.`
  }
  if (!isDir(projectDir)) return `Folder not found: ${projectDir}`
  if (!prompt) return 'Nothing to queue: put the prompt after the colon.'
  const plan = options.plan ?? d.plan
  return {
    projectDir,
    prompt,
    plan,
    review: options.review ?? (plan ? d.review : false),
    execMode: options.execMode ?? d.execMode,
    model: options.model ?? d.model,
    effort: options.effort ?? d.effort,
    sessionPolicy: options.policy ?? 'continue',
    sessionId,
    isolate: options.isolate ?? config.isolate,
    takeover: options.takeover,
    front: options.front,
    source: ctx.source,
  }
}

export const HELP = `${BRAND.name}: queue Claude Code prompts.
q <prompt> · queue with your defaults
q myapp plan opus max: <prompt> · options before the colon
  modes: plan review auto edits yolo plan+edits plan+yolo · ask = answer only, read-only
  models: opus sonnet haiku fable · effort: low med high xhigh max
  new = fresh conversation · now = run next · @<id> = that conversation
  take = close that conversation where it's open (VS Code, a terminal) and continue it here
  branch = on its own git branch · here = in your checkout
ls · st · peek [lines] · plan [#] · chats [project]
pause · go · stop · skip · kill [#] (ends it now, and what it started) · rm <#> · top <#>
say <text> · keys <keys> (e.g. keys 1, keys Enter) · fork · take
y <code> · n <code> [note] · a <code> <answer>
projects · alias <name> <path> · trust <name|path> · default <options> · notify all|important|off`

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!)
}

function enqueue(text: string, ctx: CommandContext): string {
  if (!text) return 'Usage: q [options:] <prompt>. Reply help for the options.'
  const spec = buildSpec(text, ctx)
  if (typeof spec === 'string') return spec
  const refusal = ctx.guard?.(spec)
  if (refusal) return refusal
  const job = ctx.runner.enqueue(spec)
  ctx.store.kvSet('lastProject', spec.projectDir)
  const config = ctx.config()
  const ahead = ctx.store.queued().findIndex(j => j.id === job.id)
  const active = ctx.store.active()
  const blockedUntil = ctx.runner.limits().blockedUntil
  const when =
    ahead === 0 && !active
      ? ctx.runner.paused
        ? 'queue is paused, reply go to start'
        : blockedUntil && blockedUntil > ctx.now()
          ? `starts after the limit resets at ${formatClock(blockedUntil, ctx.now())}`
          : 'starting now'
      : `${ordinal(ahead + 1)} in line${active ? ` after #${active.id}` : ''}`
  const policy = spec.sessionPolicy === 'continue' ? ' · continues the conversation' : ''
  const take = spec.takeover ? ' · takes it over where it is open' : ''
  return `Queued ${jobLine(job, config.aliases)}${policy}${take} (${when})\n“${oneLine(job.prompt, 120)}”`
}

/** Your recent conversations in a folder, with the ids `q @<id>:` takes. */
function chats(rest: string, ctx: CommandContext): string {
  if (!ctx.chats) return 'Chats are not available here.'
  const config = ctx.config()
  const name = rest.trim()
  const cliDir = ctx.source === 'cli' && ctx.cwd && ctx.cwd !== homedir() ? ctx.cwd : undefined
  const dir = name ? (aliasPath(config, name) ?? resolve(expandHome(name))) : (cliDir ?? config.defaults.project ?? ctx.store.kvGet<string>('lastProject'))
  if (!dir) return 'Which project? Reply chats <project>.'
  if (!isDir(dir)) return `Folder not found: ${dir}`
  const label = projectLabel(dir, config.aliases)
  const list = ctx.chats.list(dir, 10)
  if (list.length === 0) return `No Claude Code chats in ${label} yet.`
  const now = ctx.now()
  const lines = list.map(c => {
    const state = chatState(c)
    return `@${c.sessionId.slice(0, 8)} ${oneLine(c.title, 60)}${state ? ` · ${state}` : ''} · ${duration(now - c.updatedAt)} ago`
  })
  const first = list[0]!.sessionId.slice(0, 8)
  return [`Chats in ${label}, newest first:`, ...lines, `Continue one: q @${first}: <prompt> (add take to close it where it's open first)`].join('\n')
}

function phaseText(phase: string | null, held: boolean, reason: string | null): string {
  if (held) return `paused: ${reason ?? 'needs you'}`
  switch (phase) {
    case 'launching':
      return 'starting'
    case 'planning':
      return 'planning'
    case 'limited':
      return 'waiting for the limit reset'
    case 'finishing':
      return 'wrapping up'
    default:
      return 'working'
  }
}

function list(ctx: CommandContext): string {
  const config = ctx.config()
  const now = ctx.now()
  const lines: string[] = []
  const active = ctx.store.active()
  if (active) {
    const since = active.startedAt ? ` ${duration(now - active.startedAt)}` : ''
    lines.push(`▶ ${jobLine(active, config.aliases)} · ${phaseText(active.phase, active.status === 'held', active.holdReason)}${since}`)
    lines.push(`   “${oneLine(active.prompt, 80)}”`)
  }
  ctx.store.queued().forEach((job, i) => {
    lines.push(`${i + 1}. ${jobLine(job, config.aliases)}`)
    lines.push(`   “${oneLine(job.prompt, 80)}”`)
  })
  if (lines.length === 0) lines.push('Queue empty.')
  if (ctx.runner.paused) lines.push('⏸ Paused: reply go to resume.')
  const recent = ctx.store.recentFinished(3)
  if (recent.length > 0) {
    const icon = { done: '✅', failed: '❌', cancelled: '✖️' } as Record<string, string>
    lines.push(
      'Recent: ' +
        recent
          .map(j => `${icon[j.status] ?? ''} #${j.id}${j.finishedAt ? ` ${duration(now - j.finishedAt)} ago` : ''}`)
          .join(' · '),
    )
  }
  return lines.join('\n')
}

function limitsText(ctx: CommandContext): string[] {
  const now = ctx.now()
  const limits = ctx.runner.limits()
  const out: string[] = []
  const describe = (label: string, w?: { usedPct: number | null; resetsAt: number | null }) => {
    if (!w || w.usedPct === null) return
    const resets = w.resetsAt && w.resetsAt > now ? ` · resets ${formatClock(w.resetsAt, now)}` : ''
    out.push(`${label}: ${Math.round(w.usedPct)}%${resets}`)
  }
  describe('5h limit', limits.fiveHour)
  describe('7d limit', limits.sevenDay)
  if (limits.updatedAt && out.length > 0 && now - limits.updatedAt > 30 * 60_000) {
    out.push(`(as of ${duration(now - limits.updatedAt)} ago)`)
  }
  return out
}

function status(ctx: CommandContext): string {
  const config = ctx.config()
  const now = ctx.now()
  const lines: string[] = []
  const active = ctx.store.active()
  if (active) {
    const since = active.startedAt ? ` ${duration(now - active.startedAt)}` : ''
    lines.push(`▶ ${jobLine(active, config.aliases)} · ${phaseText(active.phase, active.status === 'held', active.holdReason)}${since}`)
    const info = ctx.runner.runtimeInfo(active.id)
    if (info?.lastTool) lines.push(`   last: ${info.lastTool} (${duration(now - info.lastActivity)} ago)`)
    const pending = ctx.store.pendingApprovals(active.id)
    for (const a of pending) lines.push(`   waiting on you: ${a.kind} ${a.code}`)
    if (active.phase === 'limited') {
      const until = ctx.runner.limits().blockedUntil
      if (until) lines.push(`   continues after ${formatClock(until, now)}`)
    }
  } else {
    lines.push(ctx.runner.paused ? '⏸ Paused.' : 'Idle.')
  }
  lines.push(...limitsText(ctx))
  const waiting = ctx.store.queued().length
  lines.push(`Queue: ${waiting} waiting${ctx.runner.paused ? ' (paused)' : ''}`)
  return lines.join('\n')
}

function showPlan(rest: string, ctx: CommandContext): string {
  const id = Number.parseInt(rest.replace('#', ''), 10)
  const job = Number.isFinite(id) ? ctx.store.getJob(id) : (ctx.store.active() ?? ctx.store.lastJob())
  if (!job) return 'No such job.'
  return job.planText ? `#${job.id} plan:\n${excerpt(job.planText, 3000)}` : `#${job.id} has no plan yet.`
}

async function withId(rest: string, fn: (id: number) => string | Promise<string>): Promise<string> {
  const id = Number.parseInt(rest.replace('#', ''), 10)
  return Number.isFinite(id) ? fn(id) : 'Which job? Add its number, e.g. rm 12.'
}

/** "y abcde", or a bare "y" when exactly one request is waiting. */
function pickApproval(rest: string, ctx: CommandContext, kinds: Approval['kind'][]): { approval: Approval; note: string } | string {
  const m = /^([a-km-z]{5})\b\s*([\s\S]*)$/i.exec(rest)
  if (m) {
    const approval = ctx.store.getApproval(m[1]!.toLowerCase())
    if (approval) return { approval, note: m[2]!.trim() }
  }
  const pending = ctx.store.pendingApprovals().filter(a => kinds.includes(a.kind))
  if (pending.length === 1) return { approval: pending[0]!, note: rest.trim() }
  if (pending.length === 0) return 'Nothing is waiting for an answer.'
  return `${pending.length} requests are waiting: ${pending.map(a => `${a.kind} ${a.code}`).join(', ')}. Include the code.`
}

function approve(word: string, rest: string, ctx: CommandContext): string {
  const picked = pickApproval(rest, ctx, ['permission', 'review', 'trust'])
  if (typeof picked === 'string') return picked
  const allow = word === 'y' || word === 'yes'
  return ctx.runner.answer(picked.approval.code, allow ? 'allow' : 'deny', picked.note || null)
}

function answerQuestion(rest: string, ctx: CommandContext): string {
  const picked = pickApproval(rest, ctx, ['question'])
  if (typeof picked === 'string') return picked
  if (!picked.note) return `Add your answer: a ${picked.approval.code} <answer>.`
  return ctx.runner.answer(picked.approval.code, 'answer', picked.note)
}

function trustedLabel(config: Config, dir: string): string {
  const ours = config.trustedDirs.some(d => dir === d || dir.startsWith(d + '/'))
  return ours || isTrusted(dir) ? ' (trusted)' : ''
}

function projects(ctx: CommandContext): string {
  const config = ctx.config()
  const entries = Object.entries(config.aliases)
  if (entries.length === 0) return 'No projects yet. Add one: alias <name> <path>'
  const lines = entries.map(([name, dir]) => `${name} → ${dir}${trustedLabel(config, dir)}`)
  if (config.defaults.project) lines.push(`default: ${projectLabel(config.defaults.project, config.aliases)}`)
  return lines.join('\n')
}

function alias(rest: string, ctx: CommandContext): string {
  const m = /^(\S+)\s+(.+)$/.exec(rest)
  if (!m) return 'Usage: alias <name> <path>'
  const name = m[1]!.toLowerCase()
  const dir = resolve(expandHome(m[2]!.trim()))
  if (!isDir(dir)) return `Folder not found: ${dir}`
  const probe: QueueOptions = {}
  if (applyOption(name, { ...ctx.config(), aliases: {} }, probe)) return `"${name}" is an option word; pick another name.`
  const config = ctx.config()
  config.aliases[name] = dir
  if (!config.trustedDirs.includes(dir)) config.trustedDirs.push(dir)
  ctx.saveConfig(config)
  return `Added ${name} → ${dir}. ${BRAND.name} will accept Claude's "trust this folder" prompt there.`
}

function unalias(rest: string, ctx: CommandContext): string {
  const config = ctx.config()
  const key = Object.keys(config.aliases).find(k => k === rest.trim().toLowerCase())
  if (!key) return `No project named ${rest.trim()}.`
  delete config.aliases[key]
  ctx.saveConfig(config)
  return `Removed ${key}.`
}

function trust(rest: string, ctx: CommandContext): string {
  const config = ctx.config()
  const target = rest.trim()
  if (!target) return 'Usage: trust <project|path>'
  const dir = aliasPath(config, target) ?? resolve(expandHome(target))
  if (!isDir(dir)) return `Folder not found: ${dir}`
  if (!config.trustedDirs.includes(dir)) config.trustedDirs.push(dir)
  ctx.saveConfig(config)
  return `${BRAND.name} will accept Claude's "trust this folder" prompt in ${dir}.`
}

function defaults(rest: string, ctx: CommandContext): string {
  const config = ctx.config()
  if (rest.trim()) {
    const options: QueueOptions = {}
    const bad = rest.trim().split(/\s+/).filter(t => !applyOption(t, config, options))
    if (bad.length > 0) return `Not options: ${bad.join(' ')}. Reply help for the list.`
    const d = config.defaults
    if (options.project) d.project = options.project
    if (options.plan !== undefined) d.plan = options.plan
    if (options.review !== undefined) d.review = options.review
    if (options.execMode) d.execMode = options.execMode
    if (options.model) d.model = options.model
    if (options.effort) d.effort = options.effort
    ctx.saveConfig(config)
  }
  const d = config.defaults
  const project = d.project ? projectLabel(d.project, config.aliases) : '(last used)'
  const mode = d.review ? 'review' : d.plan ? 'plan' : 'no plan'
  return `Defaults: ${project} · ${mode} then ${d.execMode} · ${d.model}/${d.effort}`
}

function notifyLevel(rest: string, ctx: CommandContext): string {
  const level = rest.trim().toLowerCase()
  if (level !== 'all' && level !== 'important' && level !== 'off') return 'Usage: notify all|important|off'
  const config = ctx.config()
  config.notify = level
  ctx.saveConfig(config)
  return `Notifications: ${level}.`
}

function clampInt(text: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(text, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Runs one command. Returns null when the text isn't a command (iMessage ignores those). */
export async function runCommand(text: string, ctx: CommandContext): Promise<string | null> {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const rest = m[2]!.trim()
  switch (word) {
    case 'q':
    case 'add':
    case 'queue':
      return enqueue(rest, ctx)
    case 'ls':
    case 'list':
      return list(ctx)
    case 'st':
    case 'status':
      return status(ctx)
    case 'peek':
      return ctx.runner.peek(clampInt(rest, 25, 5, 150))
    case 'plan':
      return showPlan(rest, ctx)
    case 'pause':
      ctx.runner.setPaused(true)
      return 'Paused. The current job keeps going; nothing new starts until you reply go.'
    case 'go':
    case 'resume':
      return ctx.runner.go()
    case 'stop':
      return ctx.runner.stop()
    case 'skip':
      return ctx.runner.skip()
    case 'kill': {
      // kill: the running task; kill 14: that one (a queued one comes off the queue).
      const id = rest ? Number(rest.replace(/^#/, '')) : ctx.store.active()?.id
      if (id === undefined) return 'Nothing is running.'
      if (!Number.isInteger(id)) return 'Usage: kill [#id]'
      return ctx.runner.kill(id, { by: ctx.source === 'imessage' ? 'iMessage' : ctx.source === 'remote' ? 'an app' : 'this Mac' })
    }
    case 'rm':
    case 'del':
    case 'remove':
      return withId(rest, id => ctx.runner.remove(id))
    case 'top':
      return withId(rest, id => ctx.runner.top(id))
    case 'say':
      return rest ? ctx.runner.say(rest) : 'Usage: say <text>'
    case 'keys':
    case 'key':
      return rest ? ctx.runner.keys(rest.split(/\s+/)) : 'Usage: keys <keys>, e.g. keys 1, keys Enter, keys Escape'
    case 'fork':
      return ctx.runner.fork()
    case 'take':
    case 'takeover':
      return ctx.runner.takeover()
    case 'chats':
    case 'sessions':
      return chats(rest, ctx)
    case 'y':
    case 'yes':
    case 'n':
    case 'no':
      return approve(word, rest, ctx)
    case 'a':
    case 'answer':
      return answerQuestion(rest, ctx)
    case 'projects':
    case 'aliases':
      return projects(ctx)
    case 'alias':
      return alias(rest, ctx)
    case 'unalias':
      return unalias(rest, ctx)
    case 'trust':
      return trust(rest, ctx)
    case 'default':
    case 'defaults':
      return defaults(rest, ctx)
    case 'notify':
      return notifyLevel(rest, ctx)
    case 'help':
    case '?':
      return HELP
    default:
      return null
  }
}
