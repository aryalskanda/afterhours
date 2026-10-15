// Carries out what apps ask for, with the same daemon calls the Telegram bot makes, after three
// checks: the device's role, this machine's own rules (which no app can change), and whether the
// request was already carried out (a retry gets the first answer again).

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { HostSession, MachineInfo, PolicyInfo, Request, RequestType, Result, Role, Snapshot } from '@afterhours/protocol'
import { expandHome, type Config } from '../../shared/config'
import type { Effort, JobSpec } from '../../shared/types'
import { continueSpec, type ChatSource } from '../chats'
import type { FolderMap } from '../folders'
import type { Runner } from '../runner'
import type { Store } from '../store'
import type { DeviceRow, RemoteDb } from './db'
import type { Feed } from './feed'
import { approvalInfo, chatInfo, jobInfo, limitsInfo } from './wire'

type Outcome = Omit<Result, 'type' | 'id'>

/** The least role each request needs. */
const NEEDS: Record<RequestType, Role> = {
  sync: 'viewer',
  snapshot: 'viewer',
  jobs: 'viewer',
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
}
const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
/** Requests that change something: audited, and answered from memory when retried. */
const CHANGES = new Set<RequestType>(['queue', 'answer', 'control', 'job', 'say', 'keys', 'chat.write', 'devices.remove', 'devices.rename', 'command'])

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
    if (RANK[session.role] < RANK[NEEDS[request.type]]) {
      outcome = { ok: false, code: 'forbidden', error: `This device is ${session.role === 'operator' ? 'an' : 'a'} ${session.role} here; that needs ${NEEDS[request.type]}.` }
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
      approvals: this.d.store.pendingApprovals().map(approvalInfo),
      limits: limitsInfo(this.d.runner.limits()),
      policy: policyInfo(this.d.config()),
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
      case 'queue':
        return this.queue(r, config)
      case 'answer': {
        const approval = store.getApproval(r.code.toLowerCase())
        if (!approval) return { ok: false, code: 'not-found', error: `No request with code ${r.code}.` }
        if (approval.status !== 'pending') return { ok: false, code: 'gone', error: `${r.code} was already ${approval.status}.` }
        const text = runner.answer(approval.code, r.decision, r.text ?? null)
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
        return { ok: true, text: r.action === 'remove' ? await runner.remove(r.job) : runner.top(r.job) }
      case 'peek': {
        if (!policy.allowScreens) return { ok: false, code: 'policy', error: 'This machine keeps its screens to itself (cq remote screens on).' }
        if (notRunning(r.job)) return { ok: false, code: 'gone', error: `#${r.job} isn't running.` }
        const screen = await runner.screen(r.lines ?? 40)
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
        const hits = await this.d.folders.search(r.query, store.recentFolders(8), 30)
        return { ok: true, data: hits.filter(h => isAllowed(h.path, roots)).slice(0, 20) }
      }
      case 'devices':
        return { ok: true, data: this.d.db.devices().map(publicDevice) }
      case 'devices.remove': {
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
    }
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

export function publicDevice(d: DeviceRow) {
  return { id: d.id, name: d.name, platform: d.platform, role: d.role, addedAt: d.addedAt, lastSeen: d.lastSeen }
}
