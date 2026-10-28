import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { BRAND } from '../shared/brand'
import { expandHome, type Config } from '../shared/config'
import type { Approval, Effort, ExecMode, JobSpec, SessionPolicy } from '../shared/types'
import { chatState, type ChatSource } from './chats'
import { duration, excerpt, jobLine, oneLine, projectLabel } from './format'
import { formatClock } from './limits'
import type { PowerControl } from './power'
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
  /** Quitting apps and sleeping the Mac; null or missing on other systems. */
  mac?: PowerControl | null
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
  /** `opus>sonnet`: plan with opus, work with sonnet. */
  workModel?: string
  /** `link`: end with a live link (a claude.ai artifact). */
  wantLink?: boolean
  effort?: Effort
  /** `max>medium`: plan with max, work with medium. */
  workEffort?: Effort
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
  // Plan at one effort, work at another: max>medium.
  const efforts = /^([^>]+)>([^>]+)$/.exec(t)
  if (efforts && efforts[1]! in EFFORTS && efforts[2]! in EFFORTS) {
    out.effort = EFFORTS[efforts[1]!]
    out.workEffort = EFFORTS[efforts[2]!]
    if (out.plan === undefined) out.plan = true
    return true
  }
  const isModel = (m: string) => MODELS.has(m) || /^claude-[a-z0-9.-]+(\[1m\])?$/.test(m)
  if (isModel(t)) {
    out.model = t
    return true
  }
  // Plan with one model, work with another: opus>sonnet.
  const pair = /^([^>]+)>([^>]+)$/.exec(t)
  if (pair && isModel(pair[1]!) && isModel(pair[2]!)) {
    out.model = pair[1]
    out.workModel = pair[2]
    if (out.plan === undefined) out.plan = true
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
  if (t === 'link') {
    out.wantLink = true
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
    workModel: options.workModel ?? (options.model === undefined ? d.workModel : undefined) ?? null,
    workEffort: options.workEffort ?? (options.effort === undefined ? (d.workEffort ?? null) : null),
    wantLink: options.wantLink,
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
  models: opus sonnet haiku fable · opus>sonnet = plan with opus, work with sonnet · effort: low med high xhigh max · max>medium = plan with max, work with medium
  new = fresh conversation · now = run next · @<id> = that conversation
  take = close that conversation where it's open (VS Code, a terminal) and continue it here
  branch = on its own git branch · here = in your checkout
ls · st · peek [#] [lines] · plan [#] · chats [project]
pause · go · stop · skip · kill [#] (ends it now, and what it started) · rm <#> · top <#>
  with several running, name the task: stop #14 · say #14 <text> · peek #14
parallel [1-3] (how many tasks may run at once: another starts beside the running ones only in another folder, on its own branch, or when it only answers)
hold <#> (keeps its place, doesn't start) · release <#> · clear (empties the queue)
link [#] (a live link: a claude.ai page showing the result) · q … link: <prompt> (ends with one)
say <text> · keys <keys> (e.g. keys 1, keys Enter) · fork · take
sleep (this computer, now) · sleep done (once the queue is) · sleep cancel
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
  const running = ctx.store.running()
  const active = running.at(-1) ?? null
  const blockedUntil = ctx.runner.limits().blockedUntil
  // Beside what's running, when it's allowed to and they can't get in each other's way.
  const beside = running.length > 0 && running.length < ctx.runner.parallel && ahead === 0 && !ctx.runner.collision(job, running)
  const when =
    beside && !ctx.runner.paused && !(blockedUntil && blockedUntil > ctx.now())
      ? `starting beside ${running.map(j => `#${j.id}`).join(' and ')}`
      : ahead === 0 && !active
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
  for (const active of ctx.store.running()) {
    const since = active.startedAt ? ` ${duration(now - active.startedAt)}` : ''
    lines.push(`▶ ${jobLine(active, config.aliases)} · ${phaseText(active.phase, active.status === 'held', active.holdReason)}${since}`)
    lines.push(`   “${oneLine(active.prompt, 80)}”`)
  }
  ctx.store.queued().forEach((job, i) => {
    lines.push(`${i + 1}. ${jobLine(job, config.aliases)}${job.onHold ? ' · on hold' : ''}`)
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
  const running = ctx.store.running()
  for (const active of running) {
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
  }
  if (running.length === 0) lines.push(ctx.runner.paused ? '⏸ Paused.' : 'Idle.')
  else if (ctx.runner.parallel > 1) lines.push(`Up to ${ctx.runner.parallel} tasks at once.`)
  lines.push(...limitsText(ctx))
  const waiting = ctx.store.queued().length
  lines.push(`Queue: ${waiting} waiting${ctx.runner.paused ? ' (paused)' : ''}`)
  return lines.join('\n')
}

/** A task number at the start of the arguments ("#14", "14 40"): the task, and what's left. */
function taskArg(rest: string): { id?: number; rest: string } {
  const m = /^#(\d+)\b\s*(.*)$/s.exec(rest.trim())
  return m ? { id: Number(m[1]), rest: m[2]!.trim() } : { rest: rest.trim() }
}

/** The task a stop, go or skip means: the one named, or the only one running; asks which when several run. */
function which(ctx: CommandContext, rest: string, verb: string): { id?: number } | string {
  const m = /^#?(\d+)$/.exec(rest.trim())
  if (m) return { id: Number(m[1]) }
  const running = ctx.store.running()
  if (running.length > 1) return `Several are running (${running.map(j => `#${j.id}`).join(', ')}): ${verb} #<number>.`
  return {}
}

function showPlan(rest: string, ctx: CommandContext): string {
  const id = Number.parseInt(rest.replace('#', ''), 10)
  const job = Number.isFinite(id) ? ctx.store.getJob(id) : (ctx.store.running().at(-1) ?? ctx.store.lastJob())
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
    // A model on its own does both; opus>sonnet sets both.
    if (options.model) d.workModel = options.workModel ?? null
    if (options.effort) {
      d.effort = options.effort
      d.workEffort = options.workEffort ?? null
    }
    ctx.saveConfig(config)
  }
  const d = config.defaults
  const project = d.project ? projectLabel(d.project, config.aliases) : '(last used)'
  const mode = d.review ? 'review' : d.plan ? 'plan' : 'no plan'
  return `Defaults: ${project} · ${mode} then ${d.execMode} · ${d.model}${d.workModel ? `>${d.workModel}` : ''}/${d.effort}${d.workEffort ? `>${d.workEffort}` : ''}`
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
    case 'peek': {
      // peek: the latest task's screen; peek #14, or peek #14 40: that one.
      const w = taskArg(rest)
      return ctx.runner.peek(clampInt(w.rest, 25, 5, 150), w.id)
    }
    case 'plan':
      return showPlan(rest, ctx)
    case 'parallel': {
      const config = ctx.config()
      if (!rest) return `Up to ${ctx.runner.parallel} task${ctx.runner.parallel === 1 ? '' : 's'} at once. parallel 1, 2 or 3 changes it.`
      const n = Number(rest)
      if (!Number.isInteger(n) || n < 1 || n > 3) return 'Usage: parallel 1, 2 or 3.'
      ctx.saveConfig({ ...config, parallel: n })
      return n === 1
        ? 'One task at a time. Whatever is running keeps going.'
        : `Up to ${n} tasks at once. The next starts beside the running ones when it's in another folder, on its own branch, or only answers; otherwise it waits.`
    }
    case 'pause':
      ctx.runner.setPaused(true)
      return 'Paused. The current job keeps going; nothing new starts until you reply go.'
    case 'go':
    case 'resume': {
      const w = which(ctx, rest, 'go')
      return typeof w === 'string' ? w : ctx.runner.go(w.id)
    }
    case 'stop': {
      const w = which(ctx, rest, 'stop')
      return typeof w === 'string' ? w : ctx.runner.stop(w.id)
    }
    case 'skip': {
      const w = which(ctx, rest, 'skip')
      return typeof w === 'string' ? w : ctx.runner.skip(undefined, w.id)
    }
    case 'link': {
      // link: a live link for the running task (at its end); link 14: for that one.
      const id = rest ? Number(rest.replace(/^#/, '')) : (ctx.store.running().at(-1)?.id ?? ctx.store.recentFinished(1)[0]?.id)
      if (id === undefined || !Number.isInteger(id)) return 'Usage: link [#id]'
      return ctx.runner.requestLink(id, ctx.source).text
    }
    case 'kill': {
      // kill: the running task; kill 14: that one (a queued one comes off the queue).
      const running = ctx.store.running()
      if (!rest && running.length > 1) return `Several are running (${running.map(j => `#${j.id}`).join(', ')}): kill <number>.`
      const id = rest ? Number(rest.replace(/^#/, '')) : running[0]?.id
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
    case 'hold':
      return withId(rest, id => ctx.runner.holdQueued(id, true))
    case 'release':
    case 'unhold':
      return withId(rest, id => ctx.runner.holdQueued(id, false))
    case 'clear': {
      const removed = ctx.runner.clear()
      return removed.length === 0 ? 'The queue is already empty.' : `Took ${removed.map(id => `#${id}`).join(', ')} off the queue.`
    }
    case 'say': {
      // say <text>; say #14 <text> when several run.
      const w = taskArg(rest)
      if (!w.rest) return 'Usage: say [#job] <text>'
      const running = ctx.store.running()
      if (w.id === undefined && running.length > 1) return `Several are running (${running.map(j => `#${j.id}`).join(', ')}): say #<number> <text>.`
      return ctx.runner.say(w.rest, w.id)
    }
    case 'keys':
    case 'key': {
      const w = taskArg(rest)
      if (!w.rest) return 'Usage: keys [#job] <keys>, e.g. keys 1, keys Enter, keys Escape'
      const running = ctx.store.running()
      if (w.id === undefined && running.length > 1) return `Several are running (${running.map(j => `#${j.id}`).join(', ')}): keys #<number> <keys>.`
      return ctx.runner.keys(w.rest.split(/\s+/), w.id)
    }
    case 'fork': {
      const w = taskArg(rest)
      return ctx.runner.fork(w.id)
    }
    case 'take':
    case 'takeover': {
      const w = taskArg(rest)
      return ctx.runner.takeover(w.id)
    }
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
    case 'sleep':
      return sleep(rest, ctx)
    case 'help':
    case '?':
      return HELP
    default:
      return null
  }
}

const NO_POWER = 'There is nothing here to sleep (a container).'

function whoAsked(ctx: CommandContext): string {
  return ctx.source === 'imessage' ? 'iMessage' : ctx.source === 'remote' ? 'an app' : 'this computer'
}

/** sleep: now; sleep done: once the queue is done; sleep cancel. */
async function sleep(rest: string, ctx: CommandContext): Promise<string> {
  if (!ctx.mac) return NO_POWER
  const by = whoAsked(ctx)
  const word = rest.toLowerCase()
  if (word === 'done' || word === 'later' || word === 'after') return (await ctx.mac.sleepWhenDone({ on: true, by })).text
  if (word === 'cancel' || word === 'off' || word === 'no') return (await ctx.mac.sleepWhenDone({ on: false, by })).text
  if (word) return 'Usage: sleep · sleep done · sleep cancel'
  return (await ctx.mac.sleepNow({ by })).text
}
