// Carries out what apps ask for, with the same daemon calls the Telegram bot makes, after three
// checks: the device's role, this machine's own rules (which no app can change), and whether the
// request was already carried out (a retry gets the first answer again).

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type {
  QueueOptions,
  DiffSummary,
  FilePatch,
  FilesResult,
  HostSession,
  MachineInfo,
  Notice as WireNotice,
  PolicyInfo,
  Request,
  RequestType,
  Result,
  Role,
  Snapshot,
  TranscriptPage,
} from '@afterhours/protocol'
import { expandHome, type Config } from '../../shared/config'
import type { Effort, Job, JobSpec } from '../../shared/types'
import { continueSpec, type ChatSource } from '../chats'
import { fileContent, isSecretPath, listFolder, readFileInside, searchFiles } from '../files'
import { oneLine } from '../format'
import { permissionDetail } from '../notify'
import type { FolderMap } from '../folders'
import { taskStart, type Runner } from '../runner'
import { findSessions } from '../sessions'
import type { Store } from '../store'
import type { git as gitModule } from '../system'
import { transcriptPage } from '../transcript'
import type { DeviceRow, RemoteDb } from './db'
import type { Feed } from './feed'
import { approvalInfo, chatInfo, jobInfo, limitsInfo } from './wire'

/** What this machine can do beyond protocol 1's first version; apps hide what isn't listed. */
export const FEATURES = [
  'transcript',
  'timeline',
  'diff',
  'files',
  'activity',
  'peek.ansi',
  'rules',
  'plan.mode',
  'queue.edit',
  'schedule',
  'budget',
  'branch',
  'open',
]

type Outcome = Omit<Result, 'type' | 'id'>

/** The least role each request needs. */
const NEEDS: Record<RequestType, Role> = {
  sync: 'viewer',
  snapshot: 'viewer',
  jobs: 'viewer',
  task: 'viewer',
  peek: 'viewer',
  chats: 'viewer',
  folders: 'viewer',
  queue: 'operator',
  answer: 'operator',
  control: 'operator',
  job: 'operator',
  say: 'operator',
  keys: 'operator',
  'chat.write': 'operator',
  devices: 'owner',
  'devices.remove': 'owner',
  'devices.rename': 'owner',
  command: 'owner',
  transcript: 'viewer',
  timeline: 'viewer',
  diff: 'viewer',
  // Any file in the shared folders, not only what a task changed.
  files: 'operator',
  branch: 'operator',
  open: 'operator',
}
const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
/** Requests that change something: audited, and answered from memory when retried. */
const CHANGES = new Set<RequestType>(['queue', 'answer', 'control', 'job', 'say', 'keys', 'chat.write', 'devices.remove', 'devices.rename', 'command', 'branch', 'open'])

export interface RouterDeps {
  runner: Runner
  store: Store
  chats: ChatSource
  folders: FolderMap
  config: () => Config
  /** Runs a text command; `guard` checks any job it would queue. */
  command: (text: string, guard: (spec: JobSpec) => string | null) => Promise<string | null>
  db: RemoteDb
  feed: Feed
  machine: () => MachineInfo
  /** Removes a device everywhere: here, at the relay, and its open sessions. */
  removeDevice: (id: string, by: string) => boolean
  /** Filled in when an app answers an approval, so other apps hear who did. */
  resolvedBy: Map<string, string>
  git: Pick<typeof gitModule, 'snapshot' | 'changes' | 'patch' | 'show' | 'treeOf' | 'top' | 'mergeBranch' | 'discardBranch' | 'pullRequest'>
  /** Opens a conversation in VS Code on this machine's screen; false when it has none. */
  openInVsCode?: (sessionId: string) => boolean
  now: () => number
  log: (line: string) => void
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The folders apps may use (with their subfolders): configured, else your home folder. */
export function allowedRoots(config: Config): string[] {
  const roots = config.remote.allowedRoots.length > 0 ? config.remote.allowedRoots : [homedir()]
  return roots.map(r => realPath(resolve(expandHome(r))))
}

/** Whether `path` is one of `roots` or inside one, after following symlinks. */
export function isAllowed(path: string, roots: string[]): boolean {
  const p = realPath(resolve(expandHome(path)))
  return roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep))
}

export function policyInfo(config: Config): PolicyInfo {
  return {
    allowedRoots: allowedRoots(config),
    allowBypass: config.remote.allowBypass,
    allowScreens: config.remote.allowScreens,
    allowTyping: config.remote.allowTyping,
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A short description of a request for the audit trail: never the prompt or what was typed. */
function auditDetail(r: Request): string | null {
  switch (r.type) {
    case 'queue':
      return `${r.folder} · ${r.prompt.length} characters`
    case 'answer':
      return `${r.code} ${r.decision}`
    case 'control':
      return `${r.action}${r.job ? ` #${r.job}` : ''}`
    case 'job':
      return `${r.action} #${r.job}`
    case 'say':
    case 'chat.write':
      return `${r.text.length} characters`
    case 'keys':
      return r.keys.join(' ')
    case 'devices.remove':
    case 'devices.rename':
      return r.device.slice(0, 12)
    case 'command':
      return r.text.trim().split(/\s+/)[0] ?? null
    case 'branch':
      return `${r.action} #${r.job}`
    case 'open':
      return r.job !== undefined ? `#${r.job}` : (r.session?.slice(0, 8) ?? null)
    default:
      return null
  }
}

export class Router {
  constructor(private readonly d: RouterDeps) {}

  async handle(session: HostSession, request: Request): Promise<void> {
    const changes = CHANGES.has(request.type)
    if (changes) {
      const earlier = this.d.db.handled(session.device, request.id)
      if (earlier) {
        session.send(earlier)
        return
      }
    }
    const device = this.d.db.device(session.device)
    const name = device?.name ?? session.hello.name
    let outcome: Outcome
    // Any device may rename or remove itself (renamed in the app, or forgetting this machine);
    // doing that to other devices takes an owner.
    const itself = (request.type === 'devices.remove' || request.type === 'devices.rename') && request.device === session.device
    const needs = itself ? 'viewer' : NEEDS[request.type]
    if (RANK[session.role] < RANK[needs]) {
      outcome = { ok: false, code: 'forbidden', error: `This device is ${session.role === 'operator' ? 'an' : 'a'} ${session.role} here; that needs ${needs}.` }
    } else {
      try {
        outcome = await this.run(session, request, name)
      } catch (err) {
        this.d.log(`remote ${request.type} from ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
        outcome = { ok: false, code: 'failed', error: `It failed on the machine: ${err instanceof Error ? err.message : err}` }
      }
    }
    const result: Result = { type: 'result', id: request.id, ...outcome }
    if (changes) {
      this.d.db.remember(session.device, request.id, result, this.d.now())
      this.d.db.audit({ at: this.d.now(), device: session.device, deviceName: name, action: request.type, detail: auditDetail(request), ok: outcome.ok })
    }
    session.send(result)
  }

  snapshot(role: Role): Snapshot {
    const config = this.d.config()
    const active = this.d.store.active()
    return {
      type: 'snapshot',
      seq: this.d.db.lastSeq(),
      machine: this.d.machine(),
      role,
      paused: this.d.runner.paused,
      active: active ? jobInfo(active) : null,
      queued: this.d.store.queued().map(j => jobInfo(j, { brief: true })),
      recent: this.d.store.recentFinished(10).map(j => jobInfo(j, { brief: true })),
      approvals: this.d.store.pendingApprovals().map(a => {
        const p = (a.payload ?? {}) as { tool?: string; input?: unknown }
        const allowedBefore = a.kind === 'permission' && p.tool ? this.d.store.countAllowed(p.tool, permissionDetail(p.tool, p.input), permissionDetail) : undefined
        return approvalInfo(a, { job: this.d.store.getJob(a.jobId), timeouts: config.timeouts, allowedBefore })
      }),
      limits: limitsInfo(this.d.runner.limits()),
      policy: policyInfo(config),
      defaults: {
        plan: config.defaults.plan,
        review: config.defaults.review,
        mode: config.defaults.execMode,
        model: config.defaults.model,
        effort: config.defaults.effort,
        isolate: config.isolate,
      },
      models: [...new Set([...config.models, config.defaults.model])],
      features: FEATURES,
    }
  }

  /** This machine's rules for tasks started remotely; a string says why not. */
  guard(spec: JobSpec): string | null {
    const config = this.d.config()
    const roots = allowedRoots(config)
    if (!isAllowed(spec.projectDir, roots)) {
      return `${spec.projectDir} is outside the folders this machine lets apps use (${roots.join(', ')}). On the machine: cq remote allow <folder>.`
    }
    if (spec.execMode === 'bypassPermissions' && !config.remote.allowBypass) {
      return "This machine doesn't let apps start tasks that skip permission prompts. On the machine: cq remote bypass on."
    }
    return null
  }

  private async run(session: HostSession, r: Request, name: string): Promise<Outcome> {
    const { runner, store } = this.d
    const config = this.d.config()
    const policy = config.remote
    const roots = allowedRoots(config)
    const notRunning = (job: number | undefined) => job !== undefined && store.active()?.id !== job
    switch (r.type) {
      case 'sync':
        session.subscribed = true
        this.d.feed.catchUp(session, r.since ?? 0, this.snapshot(session.role))
        return { ok: true }
      case 'snapshot':
        return { ok: true, data: this.snapshot(session.role) }
      case 'jobs': {
        const active = store.active()
        return {
          ok: true,
          data: {
            active: active ? jobInfo(active) : null,
            queued: store.queued().map(j => jobInfo(j)),
            recent: store.recentFinished(r.recent ?? 20).map(j => jobInfo(j)),
          },
        }
      }
      case 'task': {
        const job = store.getJob(r.job)
        if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
        return { ok: true, data: { job: jobInfo(job), plan: job.planText, answer: job.lastMessage } }
      }
      case 'queue':
        return this.queue(r, config)
      case 'answer': {
        const approval = store.getApproval(r.code.toLowerCase())
        if (!approval) return { ok: false, code: 'not-found', error: `No request with code ${r.code}.` }
        if (approval.status !== 'pending') return { ok: false, code: 'gone', error: `${r.code} was already ${approval.status}.` }
        if (r.rule !== undefined) {
          const offered = ((approval.payload ?? {}) as { suggestions?: unknown[] }).suggestions ?? []
          if (approval.kind !== 'permission' || r.decision !== 'allow' || r.rule >= offered.length) return { ok: false, code: 'invalid', error: 'That isn’t one of the rules Claude Code offered for this request.' }
        }
        if (r.mode !== undefined) {
          if (approval.kind !== 'review' || r.decision !== 'allow' || r.mode === 'plan') return { ok: false, code: 'invalid', error: 'A mode goes with approving a plan.' }
          if (r.mode === 'bypassPermissions' && !policy.allowBypass) return { ok: false, code: 'policy', error: "This machine doesn't let apps skip permission prompts (cq remote bypass on)." }
        }
        const text = runner.answer(approval.code, r.decision, r.text ?? null, { rule: r.rule, mode: r.mode })
        const ok = store.getApproval(approval.code)?.status !== 'pending'
        if (ok) this.d.resolvedBy.set(approval.code, name)
        return ok ? { ok, text } : { ok, code: 'invalid', error: text }
      }
      case 'control': {
        if ((r.action === 'stop' || r.action === 'skip' || r.action === 'continue') && notRunning(r.job)) {
          return { ok: false, code: 'gone', error: `#${r.job} isn't the running task any more.` }
        }
        switch (r.action) {
          case 'go':
            return { ok: true, text: await runner.go() }
          case 'pause':
            runner.setPaused(true)
            return { ok: true, text: 'Paused. The running task keeps going; nothing new starts until you resume.' }
          case 'stop':
            return { ok: true, text: await runner.stop() }
          case 'skip':
            return { ok: true, text: await runner.skip() }
          case 'continue':
            return { ok: true, text: await runner.continueNow() }
          case 'fork':
            return { ok: true, text: await runner.fork() }
          case 'takeover':
            return { ok: true, text: await runner.takeover() }
        }
        break
      }
      case 'job':
        if (r.action === 'remove') return { ok: true, text: await runner.remove(r.job) }
        if (r.action === 'top') return { ok: true, text: runner.top(r.job) }
        return this.changeQueued(r)
      case 'peek': {
        if (!policy.allowScreens) return { ok: false, code: 'policy', error: 'This machine keeps its screens to itself (cq remote screens on).' }
        if (notRunning(r.job)) return { ok: false, code: 'gone', error: `#${r.job} isn't running.` }
        const screen = await runner.screen(r.lines ?? 40, r.ansi === true)
        return screen ? { ok: true, data: { job: screen.jobId, text: screen.text } } : { ok: true, data: null, text: 'Nothing is running.' }
      }
      case 'say':
      case 'keys': {
        if (!policy.allowTyping) return { ok: false, code: 'policy', error: "This machine doesn't let apps type into tasks (cq remote typing on)." }
        if (notRunning(r.job)) return { ok: false, code: 'gone', error: `#${r.job} isn't running.` }
        return { ok: true, text: r.type === 'say' ? await runner.say(r.text) : await runner.keys(r.keys) }
      }
      case 'chats': {
        if (r.folder && !isAllowed(r.folder, roots)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        const limit = r.limit ?? 20
        const list = r.folder ? { chats: this.d.chats.list(resolve(expandHome(r.folder)), limit), more: false } : this.d.chats.recent(r.page ?? 0, limit)
        const visible = list.chats.filter(c => c.cwd !== null && isAllowed(c.cwd, roots))
        return { ok: true, data: { chats: visible.map(chatInfo), more: list.more } }
      }
      case 'chat.write':
        return this.writeToChat(r.session, r.text, name, config)
      case 'folders': {
        // Nothing typed yet: the folders tasks ran in lately.
        if (!r.query.trim()) {
          const recent = store.recentFolders(12).filter(p => isDir(p) && isAllowed(p, roots))
          return { ok: true, data: recent.map(path => ({ path, name: path.split('/').pop() || path, isRepo: isDir(`${path}/.git`) })) }
        }
        const hits = await this.d.folders.search(r.query, store.recentFolders(8), 30)
        return { ok: true, data: hits.filter(h => isAllowed(h.path, roots)).slice(0, 20) }
      }
      case 'devices':
        return { ok: true, data: this.d.db.devices().map(publicDevice) }
      case 'devices.remove': {
        if (r.device === session.device) {
          // A device removing itself hears the answer before its session is cut.
          const device = this.d.db.device(r.device)
          if (!device || device.revokedAt !== null) return { ok: false, code: 'not-found', error: 'No such device.' }
          setTimeout(() => this.d.removeDevice(r.device, name), 200)
          return { ok: true, text: 'Removed.' }
        }
        const ok = this.d.removeDevice(r.device, name)
        return ok ? { ok, text: 'Removed.' } : { ok, code: 'not-found', error: 'No such device.' }
      }
      case 'devices.rename': {
        const ok = this.d.db.rename(r.device, r.name)
        return ok ? { ok, text: `Renamed to ${r.name}.` } : { ok, code: 'not-found', error: 'No such device.' }
      }
      case 'command': {
        const word = r.text.trim().split(/\s+/)[0]!.toLowerCase()
        if (word === 'trust') return { ok: false, code: 'policy', error: 'Folder trust is set on the machine itself (cq trust <folder>).' }
        if ((word === 'say' || word === 'keys' || word === 'key') && !policy.allowTyping) {
          return { ok: false, code: 'policy', error: "This machine doesn't let apps type into tasks (cq remote typing on)." }
        }
        if (word === 'peek' && !policy.allowScreens) return { ok: false, code: 'policy', error: 'This machine keeps its screens to itself (cq remote screens on).' }
        if ((word === 'default' || word === 'defaults') && /\b(yolo|bypass)\b/i.test(r.text) && !policy.allowBypass) {
          return { ok: false, code: 'policy', error: "This machine doesn't let apps make skipping permission prompts the default (cq remote bypass on)." }
        }
        const text = await this.d.command(r.text, spec => this.guard(spec))
        return text === null ? { ok: false, code: 'invalid', error: `Unknown command "${word}". Try help.` } : { ok: true, text }
      }
      case 'transcript':
        return this.transcript(r, roots)
      case 'timeline': {
        const job = store.getJob(r.job)
        if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
        const events = this.d.db.eventsForJob(r.job).map(e => ({ type: 'event' as const, seq: e.seq, at: e.at, notice: JSON.parse(e.notice) as WireNotice, text: e.text }))
        return { ok: true, data: { events } }
      }
      case 'diff':
        return this.diff(r, roots)
      case 'files':
        return this.files(r, roots)
      case 'branch':
        return this.branch(r, session.role, roots)
      case 'open': {
        const job = r.job !== undefined ? store.getJob(r.job) : null
        if (r.job !== undefined && !job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
        const sessionId = job ? job.sessionId : (r.session ?? null)
        if (!sessionId) return { ok: false, code: 'invalid', error: 'That task hasn’t started a conversation yet.' }
        const folder = job ? job.projectDir : (findSessions(sessionId).find(s => s.sessionId === sessionId)?.cwd ?? null)
        if (!folder || !isAllowed(folder, roots)) return { ok: false, code: 'policy', error: 'That conversation is outside the folders this machine shares with apps.' }
        const opened = this.d.openInVsCode?.(sessionId) ?? false
        return opened ? { ok: true, text: `Opened in VS Code on ${this.d.machine().name}.` } : { ok: false, code: 'failed', error: `${this.d.machine().name} has no screen to open it on.` }
      }
    }
  }

  /** When a task may start, from what the app asked; a string says why not. */
  private schedule(o: QueueOptions, current: Pick<Job, 'id'> | null): Pick<JobSpec, 'notBefore' | 'afterJob' | 'repeatDaily' | 'maxMinutes'> | string {
    const now = this.d.now()
    let notBefore = o.notBefore ?? null
    if (o.atReset) {
      const resets = this.d.runner.limits().fiveHour?.resetsAt ?? null
      if (!resets || resets <= now) return 'The machine doesn’t know when the 5-hour limit resets right now.'
      notBefore = resets
    }
    if (notBefore !== null && notBefore > now + 14 * 86_400_000) return 'Pick a time in the next two weeks.'
    const repeatDaily = o.repeatDaily ?? null
    if (repeatDaily !== null && notBefore === null) {
      // Every day at a time: the first run is the next time it comes round.
      const next = new Date(now)
      next.setHours(Math.floor(repeatDaily / 60), repeatDaily % 60, 0, 0)
      if (next.getTime() <= now) next.setDate(next.getDate() + 1)
      notBefore = next.getTime()
    }
    const afterJob = o.afterJob ?? null
    if (afterJob !== null) {
      const before = this.d.store.getJob(afterJob)
      if (!before) return `There's no task #${afterJob}.`
      if (current && afterJob === current.id) return 'A task can’t wait for itself.'
      if (before.status === 'failed' || before.status === 'cancelled') return `#${afterJob} didn't finish well; it won't be waited for.`
    }
    return { notBefore, afterJob, repeatDaily, maxMinutes: o.maxMinutes ?? null }
  }

  /** A queued task changed (`edit`) or moved (`move`). */
  private changeQueued(r: Extract<Request, { type: 'job' }>): Outcome {
    const job = this.d.store.getJob(r.job)
    if (!job || job.status !== 'queued') return { ok: false, code: 'gone', error: `#${r.job} isn't waiting in the queue.` }
    if (r.action === 'move') {
      const to = r.to ?? 0
      this.d.store.moveTo(job.id, to)
      return { ok: true, text: to === 0 ? `#${job.id} is next.` : `#${job.id} is number ${to + 1} in the queue.` }
    }
    const o = r.options ?? {}
    const patch: Partial<Job> = {}
    if (r.prompt !== undefined) patch.prompt = r.prompt
    if (o.plan !== undefined) patch.plan = o.plan
    if (o.review !== undefined) patch.review = o.review
    if (o.mode !== undefined) patch.execMode = o.mode
    if (o.model !== undefined) patch.model = o.model
    if (o.effort !== undefined) patch.effort = o.effort
    if (o.isolate !== undefined && !job.sessionId) patch.isolate = o.isolate
    const when = o.notBefore !== undefined || o.atReset !== undefined || o.afterJob !== undefined || o.repeatDaily !== undefined || o.maxMinutes !== undefined
    if (when) {
      const s = this.schedule(o, job)
      if (typeof s === 'string') return { ok: false, code: 'invalid', error: s }
      Object.assign(patch, s)
    }
    const refusal = this.guard({ ...job, ...patch, execMode: patch.execMode ?? job.execMode } as JobSpec)
    if (refusal) return { ok: false, code: 'policy', error: refusal }
    this.d.store.updateJob(job.id, patch)
    return { ok: true, text: `Changed #${job.id}.`, data: { job: jobInfo(this.d.store.getJob(job.id)!) } }
  }

  /** A finished task's own branch: merged, thrown away, or proposed as a pull request. */
  private async branch(r: Extract<Request, { type: 'branch' }>, role: Role, roots: string[]): Promise<Outcome> {
    const job = this.d.store.getJob(r.job)
    if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
    if (!job.branch) return { ok: false, code: 'invalid', error: `#${job.id} didn't run on its own branch.` }
    if (job.status === 'queued' || job.status === 'running' || job.status === 'held') return { ok: false, code: 'gone', error: `#${job.id} hasn't finished.` }
    if (!isAllowed(job.projectDir, roots)) return { ok: false, code: 'policy', error: 'That task ran outside the folders this machine shares with apps.' }
    if (r.action === 'pr' && role !== 'owner') return { ok: false, code: 'forbidden', error: 'A pull request pushes the code out of this machine: that needs an owner.' }
    const title = oneLine(job.prompt, 72)
    if (r.action === 'merge') {
      const done = await this.d.git.mergeBranch(job.projectDir, job.branch, job.workDir, `Merge Afterhours #${job.id}: ${title}`)
      if (!done.ok) return { ok: false, code: 'failed', error: done.text }
      this.d.store.updateJob(job.id, { branchNote: done.text })
      return { ok: true, text: done.text }
    }
    if (r.action === 'discard') {
      const done = await this.d.git.discardBranch(job.projectDir, job.branch, job.workDir)
      if (!done.ok) return { ok: false, code: 'failed', error: done.text }
      this.d.store.updateJob(job.id, { branchNote: 'Discarded' })
      return { ok: true, text: `Threw away ${job.branch}.` }
    }
    const body = `${job.prompt}\n\n${job.summary ? `${job.summary}\n\n` : ''}From Afterhours task #${job.id}.`
    const done = await this.d.git.pullRequest(job.workDir ?? job.projectDir, job.branch, title, body)
    if (!done.ok) return { ok: false, code: 'failed', error: done.text }
    this.d.store.updateJob(job.id, { branchNote: done.url ?? done.text })
    return { ok: true, text: done.text }
  }

  private transcript(r: Extract<Request, { type: 'transcript' }>, roots: string[]): Outcome {
    let path: string | null = null
    let since: number | undefined
    if (r.job !== undefined) {
      const job = this.d.store.getJob(r.job)
      if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
      if (!isAllowed(job.projectDir, roots)) return { ok: false, code: 'policy', error: 'That task ran outside the folders this machine shares with apps.' }
      path = job.transcriptPath && existsSync(job.transcriptPath) ? job.transcriptPath : null
      if (!path && job.sessionId) path = findSessions(job.sessionId).find(s => s.sessionId === job.sessionId)?.path ?? null
      // Not started yet: an empty conversation, not an error.
      if (!path) return { ok: true, data: emptyPage(job.sessionId ?? '') }
      since = taskStart(job)
    } else if (r.session) {
      const found = findSessions(r.session).find(s => s.sessionId === r.session)
      if (!found) return { ok: false, code: 'not-found', error: 'That conversation is gone.' }
      if (!found.cwd || !isAllowed(found.cwd, roots)) return { ok: false, code: 'policy', error: 'That conversation is outside the folders this machine shares with apps.' }
      path = found.path
    } else {
      return { ok: false, code: 'invalid', error: 'Say which task or conversation.' }
    }
    try {
      return { ok: true, data: transcriptPage(path, { before: r.before, after: r.after, limit: r.limit, since }) satisfies TranscriptPage }
    } catch {
      return { ok: false, code: 'not-found', error: 'The conversation’s transcript is gone.' }
    }
  }

  /** Where a task's files are now: its worktree or folder, if it's still there. */
  private jobDir(job: Job): string | null {
    for (const dir of [job.launchSpec?.cwd, job.workDir, job.projectDir]) if (dir && isDir(dir)) return dir
    return null
  }

  private async diff(r: Extract<Request, { type: 'diff' }>, roots: string[]): Promise<Outcome> {
    const { git } = this.d
    const job = this.d.store.getJob(r.job)
    if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
    if (!isAllowed(job.projectDir, roots)) return { ok: false, code: 'policy', error: 'That task ran outside the folders this machine shares with apps.' }
    const dir = this.jobDir(job)
    const none: DiffSummary = { dir: job.workDir ?? job.projectDir, branch: job.branch, basis: 'none', files: [], truncated: false }
    if (!dir) return { ok: true, data: none }
    const active = job.status === 'running' || job.status === 'held'
    // Exact: the folder when the task started, to when it ended (or now, while it runs).
    let from: string | null = job.startTree
    let to: string | null = job.startTree ? (job.endTree ?? (active ? await git.snapshot(dir) : null)) : null
    let basis: DiffSummary['basis'] = from && to ? 'exact' : 'none'
    if (!from || !to) {
      // Older tasks: from the commit it started on to the files as they are now, your edits included.
      from = job.startTree ?? (job.startHead ? await git.treeOf(dir, job.startHead) : null)
      to = from ? await git.snapshot(dir) : null
      basis = from && to ? 'since-start' : 'none'
    }
    if (!from || !to) return { ok: true, data: none }
    const changes = await git.changes(dir, from, to)
    const top = await git.top(dir)
    if (!changes || !top) return { ok: true, data: none }
    // A repo can reach beyond the folders apps may see: only what's inside them, and no secrets.
    const files = changes.files.filter(f => isAllowed(join(top, f.path), roots) && !isSecretPath(f.path))
    if (r.file === undefined) {
      return { ok: true, data: { dir: job.workDir ?? job.projectDir, branch: job.branch, basis, files, truncated: changes.truncated } satisfies DiffSummary }
    }
    const entry = files.find(f => f.path === r.file)
    if (!entry) return { ok: false, code: 'not-found', error: `#${job.id} didn't change ${r.file}, or it isn't shared with apps.` }
    const patch = await git.patch(dir, from, to, entry.path, entry.from)
    if (!patch) return { ok: false, code: 'failed', error: 'Git couldn’t show that diff.' }
    return { ok: true, data: { path: entry.path, ...patch } satisfies FilePatch }
  }

  private async files(r: Extract<Request, { type: 'files' }>, roots: string[]): Promise<Outcome> {
    let root: string
    let job: Job | null = null
    if (r.job !== undefined) {
      job = this.d.store.getJob(r.job)
      if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
      if (!isAllowed(job.projectDir, roots)) return { ok: false, code: 'policy', error: 'That task ran outside the folders this machine shares with apps.' }
      const dir = this.jobDir(job)
      // Paths are relative to the repo's top, as a task's diff names them.
      root = (dir ? await this.d.git.top(dir) : null) ?? dir ?? job.projectDir
    } else if (r.folder) {
      root = resolve(expandHome(r.folder))
      if (!isAllowed(root, roots)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
    } else {
      return { ok: false, code: 'invalid', error: 'Say which task or folder.' }
    }
    const rel = (r.path ?? '').replace(/^\/+/, '')
    // Only inside the folders the machine shares with apps, even when the repo reaches further.
    const allowedHere = (abs: string) => isAllowed(abs, roots)
    if (r.query !== undefined) {
      if (!isDir(root)) return { ok: true, data: { root, path: '', entries: [] } satisfies FilesResult }
      const entries = (await searchFiles(root, r.query)).filter(e => allowedHere(join(root, e.path)))
      return { ok: true, data: { root, path: '', entries } satisfies FilesResult }
    }
    if (r.read) {
      if (isSecretPath(rel)) return { ok: false, code: 'policy', error: 'That file holds secrets; it stays on the machine.' }
      if (!allowedHere(join(root, rel))) return { ok: false, code: 'policy', error: 'That file is outside the folders this machine shares with apps.' }
      // A finished task's files as it left them, even after its worktree is gone.
      if (job?.endTree && job.status !== 'running' && job.status !== 'held') {
        const bytes = await this.d.git.show(this.jobDir(job) ?? job.projectDir, job.endTree, rel)
        if (bytes) return { ok: true, data: { root, path: rel, file: fileContent(rel, bytes, bytes.length) } satisfies FilesResult }
      }
      if (!isDir(root)) return { ok: false, code: 'not-found', error: 'The task’s folder is gone.' }
      const file = readFileInside(root, rel)
      return file ? { ok: true, data: { root, path: rel, file } satisfies FilesResult } : { ok: false, code: 'not-found', error: `No file ${rel}.` }
    }
    if (!isDir(root)) return { ok: false, code: 'not-found', error: 'The folder is gone.' }
    const listed = listFolder(root, rel)
    if (!listed || !allowedHere(join(root, listed.path))) return { ok: false, code: 'not-found', error: `No folder ${rel || root}.` }
    const entries = listed.entries.filter(e => allowedHere(join(root, e.path)))
    return { ok: true, data: { root, path: listed.path, entries } satisfies FilesResult }
  }

  private queue(r: Extract<Request, { type: 'queue' }>, config: Config): Outcome {
    const o = r.options ?? {}
    let projectDir = resolve(expandHome(r.folder))
    let sessionId: string | undefined
    if (o.session) {
      const chat = this.d.chats.get(o.session)
      if (!chat?.cwd) return { ok: false, code: 'not-found', error: 'That conversation is gone.' }
      sessionId = chat.sessionId
      projectDir = chat.cwd
    }
    if (!isDir(projectDir)) return { ok: false, code: 'not-found', error: `Folder not found: ${r.folder}` }
    const d = config.defaults
    const plan = o.plan ?? d.plan
    const when = this.schedule(o, null)
    if (typeof when === 'string') return { ok: false, code: 'invalid', error: when }
    const spec: JobSpec = {
      projectDir,
      prompt: r.prompt,
      plan,
      review: o.review ?? (plan ? d.review : false),
      execMode: o.mode ?? d.execMode,
      model: o.model ?? d.model,
      effort: o.effort ?? d.effort,
      sessionPolicy: o.policy ?? (sessionId ? 'session' : 'continue'),
      sessionId,
      isolate: o.isolate ?? config.isolate,
      takeover: o.takeover,
      front: o.front,
      source: 'remote',
      ...when,
    }
    const refusal = this.guard(spec)
    if (refusal) return { ok: false, code: 'policy', error: refusal }
    const job = this.d.runner.enqueue(spec)
    this.d.store.kvSet('lastProject', projectDir)
    return { ok: true, text: `Queued #${job.id}.`, data: { job: jobInfo(job) } }
  }

  /** Typed into the chat if the queue is running it and it's free, else a task that continues it. */
  private async writeToChat(sessionId: string, text: string, name: string, config: Config): Promise<Outcome> {
    const chat = this.d.chats.get(sessionId)
    if (!chat?.cwd || !existsSync(chat.cwd)) return { ok: false, code: 'not-found', error: 'That conversation is gone.' }
    if (!isAllowed(chat.cwd, allowedRoots(config))) return { ok: false, code: 'policy', error: 'That conversation is outside the folders this machine shares with apps.' }
    const title = `“${chat.title.slice(0, 60)}”`
    if (config.remote.allowTyping) {
      const typed = await this.d.runner.typeIfFree(chat.sessionId, text)
      if (typed !== null) return { ok: true, text: `Typed into ${title} (#${typed}). Claude reads it when its current step ends.` }
    }
    const last = this.d.store.kvGet<{ model?: string; effort?: Effort }>('telegram.last') ?? {}
    const spec = continueSpec({ ...chat, cwd: chat.cwd }, {
      model: last.model ?? config.defaults.model,
      effort: last.effort ?? config.defaults.effort,
      takeover: chat.where !== null,
      source: 'remote',
      prompt: text,
    })
    // A chat continues in its own mode, which may be one that skips permission prompts.
    const refusal = this.guard(spec)
    if (refusal) return { ok: false, code: 'policy', error: refusal }
    const job = this.d.runner.enqueue(spec)
    this.d.log(`${name} sent a message to chat ${chat.sessionId.slice(0, 8)} as #${job.id}`)
    return { ok: true, text: `Sent to ${title} as #${job.id}.`, data: { job: jobInfo(job) } }
  }
}

function emptyPage(session: string): TranscriptPage {
  return { session, items: [], before: null, total: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: null, updatedAt: 0 }
}

export function publicDevice(d: DeviceRow) {
  return { id: d.id, name: d.name, platform: d.platform, role: d.role, addedAt: d.addedAt, lastSeen: d.lastSeen }
}
