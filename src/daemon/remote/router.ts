// Carries out what apps ask for, with the same daemon calls the Telegram bot makes, after three
// checks: the device's role, this machine's own rules (which no app can change), and whether the
// request was already carried out (a retry gets the first answer again).

import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type {
  AuditEntryInfo,
  ClaudeInfo,
  HealthInfo,
  QueueOptions,
  DiffSummary,
  FilePatch,
  FilesResult,
  FolderHit,
  FolderRoots,
  HostSession,
  MacInfo,
  MachineInfo,
  Notice as WireNotice,
  PolicyInfo,
  ProjectInfo,
  ProjectList,
  Request,
  RequestType,
  Result,
  Role,
  Snapshot,
  TranscriptPage,
} from '@afterhours/protocol'
import { codeRoots, COMMON_CODE_FOLDERS, expandHome, type Config } from '../../shared/config'
import type { Effort, Job, JobSpec } from '../../shared/types'
import { continueSpec, type Chat, type ChatSource } from '../chats'
import { claudeInfo } from '../claude-info'
import { claudeVersion, health } from '../health'
import { fileContent, isSecretPath, listFolder, readFileInside, searchFiles } from '../files'
import { oneLine } from '../format'
import { slashCommands } from '../slash'
import { isUpload, saveUpload } from '../uploads'
import { permissionDetail } from '../notify'
import { listChildren, relativeToRoots, suggestRoots, within as withinFolders, type FolderMap } from '../folders'
import { settleBranch } from '../branches'
import type { PowerControl } from '../power'
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
  'attachments',
  'commands',
  'group',
  'history',
  'health',
  'claude',
  'limits.history',
  'audit',
  'invite',
  'push',
  'report',
  'kill',
  'queue.hold',
  'queue.restore',
  'models.split',
  'link',
  'projects',
  'chat.rename',
  'effort.split',
  'folders.browse',
  'folders.roots',
  'parallel',
  'settings.remote',
  'queue.edit.when',
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
  'folders.roots': 'viewer',
  'folders.roots.set': 'owner',
  'settings.parallel': 'owner',
  'settings.remote': 'owner',
  queue: 'operator',
  answer: 'operator',
  control: 'operator',
  job: 'operator',
  link: 'operator',
  say: 'operator',
  keys: 'operator',
  'chat.write': 'operator',
  'chat.rename': 'operator',
  projects: 'viewer',
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
  upload: 'operator',
  commands: 'viewer',
  health: 'viewer',
  restart: 'owner',
  claude: 'viewer',
  'claude.md': 'operator',
  'limits.history': 'viewer',
  audit: 'owner',
  'pair.offer': 'owner',
  'push.register': 'viewer',
  report: 'viewer',
  mac: 'owner',
}
/** How long a queued task counts as the one a repeat of its request meant. */
const TWIN_MS = 10 * 60_000

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
const MAC_OFF = "This machine doesn't let apps quit its apps or put it to sleep (cq remote mac on)."
/** Requests that change something: audited, and answered from memory when retried. */
const CHANGES = new Set<RequestType>([
  'queue',
  'answer',
  'control',
  'job',
  'say',
  'keys',
  'chat.write',
  'chat.rename',
  'folders.roots.set',
  'settings.parallel',
  'settings.remote',
  'devices.remove',
  'devices.rename',
  'command',
  'branch',
  'open',
  'upload',
  'restart',
  'claude.md',
  'pair.offer',
  'push.register',
  'report',
  'mac',
])

export interface RouterDeps {
  runner: Runner
  store: Store
  chats: ChatSource
  folders: FolderMap
  config: () => Config
  /** The home folder project folders live in (the user's own, unless a test says otherwise). */
  home?: () => string | undefined
  /** Saves the settings (the project folders an owner changes from an app). */
  saveConfig: (config: Config) => void
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
  /** Where apps' attachments are kept. */
  uploadsDir: string
  /** Claude Code's folder (~/.claude): your own slash commands and skills. */
  claudeDir: string
  /** Claude Code's settings file (~/.claude.json): the account and MCP servers. */
  claudeJson: string
  claudePath: string
  /** The engine's log, whose tail owners may read (it never holds prompts). */
  logPath: string
  /** Where problem reports from apps are appended. */
  reportsPath: string
  /** A pairing link for another device. */
  openOffer: (role: Role) => { link: string; expires: number } | string
  /** Restarts the engine: its service starts it again. */
  restart: () => void
  /** Quitting apps and sleeping the Mac; null on other systems. */
  mac?: PowerControl | null
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

/**
 * What a device of this role may do. The switches (`cq remote bypass on`, screens, typing, mac) limit
 * the other devices; an owner's own device can do all of it, as the owner's chat can. The folders
 * still apply to everyone.
 */
export function policyFor(config: Config, role: Role): Config['remote'] {
  const r = config.remote
  return role === 'owner' ? { ...r, allowBypass: true, allowScreens: true, allowTyping: true, allowMac: true } : r
}

export function policyInfo(config: Config, role: Role = 'viewer'): PolicyInfo {
  const r = policyFor(config, role)
  return {
    allowedRoots: allowedRoots(config),
    allowBypass: r.allowBypass,
    allowScreens: r.allowScreens,
    allowTyping: r.allowTyping,
    allowMac: r.allowMac,
    ...(role === 'owner' ? { other: { allowBypass: config.remote.allowBypass, allowScreens: config.remote.allowScreens, allowTyping: config.remote.allowTyping, allowMac: config.remote.allowMac } } : {}),
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
    case 'chat.rename':
      return r.session.slice(0, 8)
    case 'folders.roots.set':
      return `${r.action} ${r.path}`
    case 'settings.parallel':
      return `${r.n} at once`
    case 'settings.remote':
      return (['bypass', 'screens', 'typing', 'mac'] as const)
        .filter(k => r[k] !== undefined)
        .map(k => `${k} ${r[k] ? 'on' : 'off'}`)
        .join(', ')
    case 'keys':
      return r.keys.join(' ')
    case 'devices.remove':
    case 'devices.rename':
      return r.device.slice(0, 12)
    case 'command':
      return r.text.trim().split(/\s+/)[0] ?? null
    case 'mac':
      return r.pid !== undefined ? `${r.action} ${r.pid}${r.force ? ', forced' : ''}` : r.on !== undefined ? `${r.action} ${r.on ? 'on' : 'off'}` : r.action
    case 'branch':
      return `${r.action} #${r.job}`
    case 'upload':
      return `${Math.round((r.data.length * 3) / 4 / 1024)} KB`
    case 'claude.md':
      return `${r.folder} · ${r.text.length} characters`
    case 'pair.offer':
      return r.role
    case 'push.register':
      return r.token ? `on${r.prefs.details ? ', with details' : ''}` : 'off'
    case 'report':
      return `${r.text.length} characters`
    case 'open':
      return r.job !== undefined ? `#${r.job}` : (r.session?.slice(0, 8) ?? null)
    default:
      return null
  }
}

export class Router {
  constructor(private readonly d: RouterDeps) {}

  private home(): string {
    return this.d.home?.() ?? homedir()
  }

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
    // Looking at the Mac changes nothing.
    if (changes && !(request.type === 'mac' && request.action === 'status')) {
      this.d.db.remember(session.device, request.id, result, this.d.now())
      this.d.db.audit({ at: this.d.now(), device: session.device, deviceName: name, action: request.type, detail: auditDetail(request), ok: outcome.ok })
    }
    session.send(result)
  }

  snapshot(role: Role): Snapshot {
    const config = this.d.config()
    const running = this.d.store.running()
    const active = running[0] ?? null
    return {
      type: 'snapshot',
      seq: this.d.db.lastSeq(),
      machine: this.d.machine(),
      role,
      paused: this.d.runner.paused,
      active: active ? jobInfo(active) : null,
      running: running.map(j => jobInfo(j)),
      parallel: this.d.runner.parallel,
      queued: this.d.store.queued().map(j => jobInfo(j, { brief: true })),
      recent: this.d.store.recentFinished(10).map(j => jobInfo(j, { brief: true })),
      approvals: this.d.store.pendingApprovals().map(a => {
        const p = (a.payload ?? {}) as { tool?: string; input?: unknown }
        const allowedBefore = a.kind === 'permission' && p.tool ? this.d.store.countAllowed(p.tool, permissionDetail(p.tool, p.input), permissionDetail) : undefined
        return approvalInfo(a, { job: this.d.store.getJob(a.jobId), timeouts: config.timeouts, allowedBefore })
      }),
      limits: limitsInfo(this.d.runner.limits()),
      policy: policyInfo(config, role),
      defaults: {
        plan: config.defaults.plan,
        review: config.defaults.review,
        mode: config.defaults.execMode,
        model: config.defaults.model,
        workModel: config.defaults.workModel ?? null,
        effort: config.defaults.effort,
        workEffort: config.defaults.workEffort ?? null,
        isolate: config.isolate,
      },
      models: [...new Set([...config.models, config.defaults.model])],
      features: this.d.mac ? [...FEATURES, 'mac'] : FEATURES,
      ...(config.remote.relay ? { relay: config.remote.relay } : {}),
    }
  }

  /** This machine's rules for tasks started remotely; a string says why not. */
  guard(spec: JobSpec, role: Role): string | null {
    const config = this.d.config()
    const roots = allowedRoots(config)
    if (!isAllowed(spec.projectDir, roots)) {
      return `${spec.projectDir} is outside the folders this machine lets apps use (${roots.join(', ')}). On the machine: cq remote allow <folder>.`
    }
    if (spec.execMode === 'bypassPermissions' && !policyFor(config, role).allowBypass) {
      return "This machine doesn't let apps start tasks that skip permission prompts. On the machine: cq remote bypass on."
    }
    return null
  }

  private async run(session: HostSession, r: Request, name: string): Promise<Outcome> {
    const { runner, store } = this.d
    const config = this.d.config()
    const policy = policyFor(config, session.role)
    const roots = allowedRoots(config)
    const notRunning = (job: number | undefined) => job !== undefined && !store.running().some(j => j.id === job)
    switch (r.type) {
      case 'sync':
        session.subscribed = true
        this.d.feed.catchUp(session, r.since ?? 0, this.snapshot(session.role))
        return { ok: true }
      case 'snapshot':
        return { ok: true, data: this.snapshot(session.role) }
      case 'jobs': {
        const running = store.running()
        const active = running[0] ?? null
        const limit = r.recent ?? 20
        // Newest first by number, so `before` pages back with no gaps.
        const folder = r.folder ? resolve(expandHome(r.folder)) : undefined
        if (folder && !isAllowed(folder, roots)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        const found = store.searchFinished({ before: r.before, status: r.status, query: r.query, folder, limit: limit + 1 })
        return {
          ok: true,
          data: {
            active: active ? jobInfo(active) : null,
            running: running.map(j => jobInfo(j)),
            queued: store.queued().map(j => jobInfo(j)),
            recent: found.slice(0, limit).map(j => jobInfo(j)),
            more: found.length > limit,
          },
        }
      }
      case 'task': {
        const job = store.getJob(r.job)
        if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
        return { ok: true, data: { job: jobInfo(job), plan: job.planText, answer: job.lastMessage } }
      }
      case 'queue':
        return this.queue(r, config, session.role)
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
            return { ok: true, text: await runner.go(r.job) }
          case 'pause':
            runner.setPaused(true)
            return { ok: true, text: 'Paused. The running task keeps going; nothing new starts until you resume.' }
          case 'stop':
            return { ok: true, text: await runner.stop(r.job) }
          case 'skip':
            return { ok: true, text: await runner.skip(name, r.job) }
          case 'clear': {
            const removed = runner.clear()
            return { ok: true, text: removed.length === 0 ? 'The queue is already empty.' : `Took ${removed.length} task${removed.length === 1 ? '' : 's'} off the queue.`, data: { removed } }
          }
          case 'kill': {
            if (r.job === undefined) return { ok: false, code: 'invalid', error: 'Say which task to kill.' }
            const job = store.getJob(r.job)
            if (!job) return { ok: false, code: 'not-found', error: `No task #${r.job}.` }
            if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'held') return { ok: false, code: 'gone', error: `#${r.job} has already ended.` }
            return { ok: true, text: await runner.kill(r.job, { by: name, pause: r.pause === true }) }
          }
          case 'continue':
            return { ok: true, text: await runner.continueNow() }
          case 'fork':
            return { ok: true, text: await runner.fork(r.job) }
          case 'takeover':
            return { ok: true, text: await runner.takeover(r.job) }
        }
        break
      }
      case 'job':
        if (r.action === 'remove') return { ok: true, text: await runner.remove(r.job, name) }
        if (r.action === 'top') return { ok: true, text: runner.top(r.job) }
        if (r.action === 'restore') {
          const text = runner.restore(r.job)
          return store.getJob(r.job)?.status === 'queued' ? { ok: true, text } : { ok: false, code: 'gone', error: text }
        }
        if (r.action === 'hold' || r.action === 'release') {
          if (store.getJob(r.job)?.status !== 'queued') return { ok: false, code: 'gone', error: `#${r.job} isn't waiting in the queue.` }
          return { ok: true, text: runner.holdQueued(r.job, r.action === 'hold') }
        }
        return this.changeQueued(r, session.role)
      case 'link': {
        const job = store.getJob(r.job)
        if (job && !isAllowed(job.projectDir, roots)) return { ok: false, code: 'policy', error: 'That task ran outside the folders this machine shares with apps.' }
        const asked = runner.requestLink(r.job)
        return asked.ok ? { ok: true, text: asked.text, data: asked.job ? { job: jobInfo(asked.job) } : undefined } : { ok: false, code: job ? 'invalid' : 'not-found', error: asked.text }
      }
      case 'peek': {
        if (!policy.allowScreens) return { ok: false, code: 'policy', error: 'This machine keeps its screens to itself (cq remote screens on).' }
        if (notRunning(r.job)) return { ok: false, code: 'gone', error: `#${r.job} isn't running.` }
        const screen = await runner.screen(r.lines ?? 40, r.ansi === true, r.job)
        return screen ? { ok: true, data: { job: screen.jobId, text: screen.text } } : { ok: true, data: null, text: 'Nothing is running.' }
      }
      case 'say':
      case 'keys': {
        if (!policy.allowTyping) return { ok: false, code: 'policy', error: "This machine doesn't let apps type into tasks (cq remote typing on)." }
        if (notRunning(r.job)) return { ok: false, code: 'gone', error: `#${r.job} isn't running.` }
        return { ok: true, text: r.type === 'say' ? await runner.say(r.text, r.job) : await runner.keys(r.keys, r.job) }
      }
      case 'chats': {
        if (r.folder && !isAllowed(r.folder, roots)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        const limit = r.limit ?? 20
        const words = (r.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        if (words.length > 0) {
          // A search looks through your last 500 conversations.
          const matches = (c: Chat) => {
            const text = `${c.title} ${c.lastPrompt ?? ''} ${c.lastReply ?? ''}`.toLowerCase()
            return words.every(w => text.includes(w))
          }
          const found: Chat[] = []
          for (let page = 0; page < 10 && found.length < limit; page++) {
            const batch = this.d.chats.recent(page, 50)
            found.push(...batch.chats.filter(c => c.cwd !== null && isAllowed(c.cwd, roots) && matches(c)))
            if (!batch.more) break
          }
          return { ok: true, data: { chats: found.slice(0, limit).map(chatInfo), more: false } }
        }
        const list = r.folder ? { chats: this.d.chats.list(resolve(expandHome(r.folder)), limit), more: false } : this.d.chats.recent(r.page ?? 0, limit)
        const visible = list.chats.filter(c => c.cwd !== null && isAllowed(c.cwd, roots))
        return { ok: true, data: { chats: visible.map(chatInfo), more: list.more } }
      }
      case 'chat.write':
        return this.writeToChat(r.session, r.text, name, config, session.role)
      case 'chat.rename': {
        const chat = this.d.chats.get(r.session)
        if (!chat?.cwd) return { ok: false, code: 'not-found', error: 'That conversation is gone.' }
        if (!isAllowed(chat.cwd, roots)) return { ok: false, code: 'policy', error: 'That conversation is outside the folders this machine shares with apps.' }
        if (!this.d.chats.rename(chat.sessionId, r.title)) return { ok: false, code: 'not-found', error: 'That conversation is gone.' }
        return { ok: true, text: `Renamed to “${r.title}”.` }
      }
      case 'projects':
        return { ok: true, data: { projects: this.projects(r.limit ?? 30, roots) } satisfies ProjectList }
      case 'folders':
        return this.folders(r, roots, config, session.role)
      case 'folders.roots':
        return this.folderRoots(config, session.role, r.browse)
      case 'folders.roots.set':
        return this.setFolderRoot(r.action, r.path, name, config)
      case 'settings.parallel': {
        this.d.saveConfig({ ...config, parallel: r.n })
        this.d.log(`${name} set ${r.n} task${r.n === 1 ? '' : 's'} at once`)
        return { ok: true, text: r.n === 1 ? 'One task at a time.' : `Up to ${r.n} tasks at once, when they can’t get in each other’s way.`, data: { parallel: r.n } }
      }
      case 'settings.remote': {
        const remote = { ...config.remote }
        if (r.bypass !== undefined) remote.allowBypass = r.bypass
        if (r.screens !== undefined) remote.allowScreens = r.screens
        if (r.typing !== undefined) remote.allowTyping = r.typing
        if (r.mac !== undefined) remote.allowMac = r.mac
        const next = { ...config, remote }
        this.d.saveConfig(next)
        this.d.log(`${name} changed what other devices may do: ${auditDetail(r)}`)
        return { ok: true, text: 'Saved.', data: policyInfo(next, session.role) }
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
        if ((word === 'apps' || word === 'quit' || word === 'quit!' || word === 'sleep') && !policy.allowMac) return { ok: false, code: 'policy', error: MAC_OFF }
        if ((word === 'default' || word === 'defaults') && /\b(yolo|bypass)\b/i.test(r.text) && !policy.allowBypass) {
          return { ok: false, code: 'policy', error: "This machine doesn't let apps make skipping permission prompts the default (cq remote bypass on)." }
        }
        const text = await this.d.command(r.text, spec => this.guard(spec, session.role))
        return text === null ? { ok: false, code: 'invalid', error: `Unknown command "${word}". Try help.` } : { ok: true, text }
      }
      case 'mac': {
        const mac = this.d.mac
        if (!mac) return { ok: false, code: 'unsupported', error: 'This machine has nothing to keep awake or sleep (a container).' }
        if (!policy.allowMac) return { ok: false, code: 'policy', error: MAC_OFF }
        switch (r.action) {
          case 'status':
            return { ok: true, data: (await mac.status()) satisfies MacInfo }
          case 'quit':
            return { ok: false, code: 'unsupported', error: 'Quitting apps is no longer part of Afterhours; it keeps the computer awake and sleeps it by itself.' }
          case 'keepAwake': {
            const s = mac.keepAwake(r.on ?? true)
            return { ok: true, text: s.text }
          }
          case 'sleep': {
            const s = await mac.sleepNow({ by: name })
            return s.ok ? { ok: true, text: s.text } : { ok: false, code: 'failed', error: s.text }
          }
          case 'sleepWhenDone': {
            const s = await mac.sleepWhenDone({ on: r.on ?? true, by: name })
            return { ok: true, text: s.text }
          }
          case 'lidClosed': {
            const s = await mac.lidClosed(r.on ?? true)
            if (s.ok) this.d.log(`${name} turned ${r.on ?? true ? 'on' : 'off'} staying awake with the lid closed`)
            return s.ok ? { ok: true, text: s.text } : { ok: false, code: 'failed', error: s.text }
          }
        }
        return { ok: false, code: 'invalid', error: 'Unknown action.' }
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
      case 'health': {
        const info = this.d.machine()
        return { ok: true, data: health({ version: info.version, os: `${info.os} ${info.arch}`, claudePath: this.d.claudePath, logPath: this.d.logPath, owner: session.role === 'owner', now: this.d.now() }) satisfies HealthInfo }
      }
      case 'restart':
        // After the answer is on its way. A non-zero exit, so launchd and systemd start it again.
        setTimeout(() => this.d.restart(), 500)
        return { ok: true, text: `Restarting Afterhours on ${this.d.machine().name}.` }
      case 'claude': {
        let folder: string | null = null
        if (r.folder) {
          folder = resolve(expandHome(r.folder))
          if (!isAllowed(folder, roots) || !isDir(folder)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        }
        return { ok: true, data: claudeInfo({ claudeJson: this.d.claudeJson, folder, owner: session.role === 'owner', version: claudeVersion(this.d.claudePath, this.d.now()) }) satisfies ClaudeInfo }
      }
      case 'claude.md': {
        const folder = resolve(expandHome(r.folder))
        if (!isAllowed(folder, roots) || !isDir(folder)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        writeFileSync(join(folder, 'CLAUDE.md'), r.text)
        return { ok: true, text: 'Saved CLAUDE.md.' }
      }
      case 'limits.history':
        return { ok: true, data: { samples: store.limitSamples(this.d.now() - 7 * 86_400_000) } }
      case 'audit':
        return {
          ok: true,
          data: { entries: this.d.db.auditLog(r.limit ?? 200).map(e => ({ at: e.at, device: e.deviceName, action: e.action, detail: e.detail, ok: e.ok }) satisfies AuditEntryInfo) },
        }
      case 'push.register': {
        this.d.db.setPush(session.device, r.token ? { token: r.token, prefs: r.prefs } : null, this.d.now())
        return { ok: true, text: r.token ? 'Pushes on.' : 'Pushes off.' }
      }
      case 'report': {
        const saved = appendReport(this.d.reportsPath, { at: this.d.now(), device: this.d.db.device(session.device)?.name ?? session.hello.name, app: r.app, platform: r.platform, text: r.text })
        return saved ? { ok: true, text: `Thanks. It’s in ${this.d.machine().name}’s app-reports log.` } : { ok: false, code: 'failed', error: 'The machine couldn’t write it down.' }
      }
      case 'pair.offer': {
        const offer = this.d.openOffer(r.role)
        return typeof offer === 'string' ? { ok: false, code: 'failed', error: offer } : { ok: true, data: offer }
      }
      case 'upload': {
        const saved = saveUpload(this.d.uploadsDir, r.name, r.data, this.d.now())
        return 'error' in saved ? { ok: false, code: 'invalid', error: saved.error } : { ok: true, text: 'Uploaded.', data: { path: saved.path } }
      }
      case 'commands': {
        const folder = resolve(expandHome(r.folder))
        if (!isAllowed(folder, roots) || !isDir(folder)) return { ok: false, code: 'policy', error: 'That folder is outside the ones this machine shares with apps.' }
        return { ok: true, data: { commands: slashCommands(folder, await this.d.git.top(folder), this.d.claudeDir) } }
      }
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
  private changeQueued(r: Extract<Request, { type: 'job' }>, role: Role): Outcome {
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
    if (o.workModel !== undefined) {
      const model = o.model ?? job.model
      patch.workModel = o.workModel && o.workModel !== model ? o.workModel : null
    }
    if (o.effort !== undefined) patch.effort = o.effort
    if (o.workEffort !== undefined || o.effort !== undefined || o.plan !== undefined) {
      const effort = o.effort ?? job.effort
      const work = o.workEffort !== undefined ? o.workEffort : job.workEffort
      patch.workEffort = (o.plan ?? job.plan) && work && work !== effort ? work : null
    }
    if (o.isolate !== undefined && !job.sessionId) patch.isolate = o.isolate
    if (o.link !== undefined) patch.wantLink = o.link
    const when = o.schedule === true || o.notBefore !== undefined || o.atReset !== undefined || o.afterJob !== undefined || o.repeatDaily !== undefined || o.maxMinutes !== undefined
    if (when) {
      const s = this.schedule(o, job)
      if (typeof s === 'string') return { ok: false, code: 'invalid', error: s }
      Object.assign(patch, s)
    }
    const refusal = this.guard({ ...job, ...patch, execMode: patch.execMode ?? job.execMode } as JobSpec, role)
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
    const done = await settleBranch(this.d.store, this.d.git, job.id, r.action)
    return done.ok ? { ok: true, text: done.text } : { ok: false, code: done.code, error: done.text }
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

  /** The project folders: what the folder search and browser cover, inside what apps may use. */
  private searchRoots(config: Config, roots: string[]): string[] {
    return codeRoots(config).filter(r => isAllowed(r, roots))
  }

  /** Folders for a task: a search, a folder's subfolders, or (nothing typed) where you've worked and the project folders. */
  private async folders(r: Extract<Request, { type: 'folders' }>, roots: string[], config: Config, role: Role): Promise<Outcome> {
    const search = this.searchRoots(config, roots)
    const used = (): string[] => {
      const seen = new Set<string>()
      for (const p of [...this.d.store.recentFolders(12), ...this.d.chats.recent(0, 30).chats.flatMap(c => (c.cwd ? [c.cwd] : []))]) seen.add(p)
      return [...seen].filter(p => isDir(p) && isAllowed(p, roots))
    }
    if (r.rescan && RANK[role] >= RANK.operator) await this.d.folders.rebuild()
    if (r.parent) {
      const dir = realPath(resolve(expandHome(r.parent)))
      if (!isDir(dir)) return { ok: false, code: 'not-found', error: 'That folder is gone.' }
      if (!isAllowed(dir, roots) || !withinFolders(dir, search.map(realPath))) return { ok: false, code: 'policy', error: 'That folder is outside the project folders this machine shares with apps.' }
      this.d.folders.touch(dir)
      const children = listChildren(dir).filter(c => isAllowed(c.path, roots))
      return { ok: true, data: children.map(c => ({ path: c.path, name: c.name, isRepo: c.isRepo, kind: c.kind, hasChildren: c.hasChildren })) satisfies FolderHit[] }
    }
    if (!r.query.trim()) {
      const recent = used().slice(0, 12)
      const data: FolderHit[] = [
        ...recent.map(path => ({ path, name: basename(path) || path, isRepo: isDir(`${path}/.git`), group: 'recent' as const })),
        ...search.map(path => ({ path, name: basename(path) || path, isRepo: isDir(`${path}/.git`), hasChildren: true, group: 'root' as const })),
      ]
      return { ok: true, data }
    }
    const hits = await this.d.folders.search(r.query, used(), 30)
    const data: FolderHit[] = hits
      .filter(h => isAllowed(h.path, roots))
      .slice(0, 20)
      .map(h => ({ ...h, rel: relativeToRoots(h.path, search) }))
    return { ok: true, data }
  }

  private async rootsInfo(config: Config, roots: string[], browse?: FolderHit[]): Promise<FolderRoots> {
    const search = codeRoots(config)
    return {
      roots: search.map(path => ({ path, name: basename(path) || path, folders: this.d.folders.countUnder(path) })),
      scannedAt: this.d.folders.builtAt,
      suggestions: suggestRoots(search, this.home(), COMMON_CODE_FOLDERS.map(expandHome)).filter(x => isAllowed(x.path, roots)),
      home: this.home(),
      ...(browse ? { browse } : {}),
    }
  }

  /** The project folders, and for owners one of your folders' subfolders, to pick a new one from. */
  private async folderRoots(config: Config, role: Role, browse?: string): Promise<Outcome> {
    let list: FolderHit[] | undefined
    if (browse !== undefined) {
      if (role !== 'owner') return { ok: false, code: 'forbidden', error: 'Only an owner can pick project folders.' }
      const home = realPath(this.home())
      const dir = realPath(resolve(expandHome(browse || '~')))
      if (!isDir(dir) || !withinFolders(dir, [home])) return { ok: false, code: 'policy', error: 'Browse inside your home folder.' }
      list = listChildren(dir).map(c => ({ path: c.path, name: c.name, isRepo: c.isRepo, kind: c.kind, hasChildren: c.hasChildren }))
    }
    return { ok: true, data: await this.rootsInfo(config, allowedRoots(config), list) }
  }

  /** An owner adds or removes a project folder: it's searched and browsed from then on, and a change is audited. */
  private async setFolderRoot(action: 'add' | 'remove', input: string, by: string, config: Config): Promise<Outcome> {
    const home = realPath(this.home())
    const path = realPath(resolve(expandHome(input)))
    const configured = codeRoots(config).map(raw => ({ raw, real: realPath(raw) }))
    const have = configured.map(c => c.real)
    let next: string[]
    let text: string
    if (action === 'add') {
      if (!isDir(path)) return { ok: false, code: 'not-found', error: 'That isn’t a folder.' }
      if (path === home || !withinFolders(path, [home])) return { ok: false, code: 'policy', error: 'A project folder has to be inside your home folder, and not the home folder itself.' }
      const covering = have.find(h => withinFolders(path, [h]))
      if (covering) return { ok: true, text: `${basename(path)} is already covered by ${basename(covering)}.`, data: await this.rootsInfo(config, allowedRoots(config)) }
      // Folders inside the new one are part of it now.
      next = [...configured.filter(c => !withinFolders(c.real, [path])).map(c => c.raw), path]
      text = `${basename(path)} is a project folder.`
    } else {
      if (!have.includes(path)) return { ok: false, code: 'not-found', error: 'That isn’t one of the project folders.' }
      if (have.length === 1) return { ok: false, code: 'invalid', error: 'Keep at least one project folder.' }
      next = configured.filter(c => c.real !== path).map(c => c.raw)
      text = `${basename(path)} is no longer a project folder.`
    }
    let updated: Config = { ...config, folders: { ...config.folders, roots: next } }
    // Apps may run tasks in it, when they're limited to certain folders.
    if (action === 'add' && config.remote.allowedRoots.length > 0 && !isAllowed(path, allowedRoots(config))) {
      updated = { ...updated, remote: { ...config.remote, allowedRoots: [...config.remote.allowedRoots, path] } }
    }
    if (action === 'remove' && config.remote.allowedRoots.length > 1 && config.remote.allowedRoots.some(r => realPath(resolve(expandHome(r))) === path)) {
      updated = { ...updated, remote: { ...config.remote, allowedRoots: config.remote.allowedRoots.filter(r => realPath(resolve(expandHome(r))) !== path) } }
    }
    this.d.saveConfig(updated)
    this.d.log(`${by} ${action === 'add' ? 'added' : 'removed'} the project folder ${path}`)
    this.d.folders.refreshIfStale()
    await this.d.folders.refresh()
    return { ok: true, text, data: await this.rootsInfo(updated, allowedRoots(updated)) }
  }

  /**
   * The folders tasks ran in over the last 30 days and your recent conversations were in, most
   * recent first. A task's own-branch worktree counts as its folder.
   */
  private projects(limit: number, roots: string[]): ProjectInfo[] {
    const since = this.d.now() - 30 * 86_400_000
    const byPath = new Map<string, ProjectInfo>()
    const at = (path: string) => {
      let p = byPath.get(path)
      if (!p) byPath.set(path, (p = { path, name: basename(path) || path, lastAt: 0, tasks: 0, chats: 0 }))
      return p
    }
    for (const a of this.d.store.folderActivity(since)) {
      const p = at(a.folder)
      p.tasks += a.tasks
      p.lastAt = Math.max(p.lastAt, a.lastAt)
    }
    const worktrees = this.d.store.worktrees()
    for (let page = 0; page < 4; page++) {
      const batch = this.d.chats.recent(page, 50)
      for (const c of batch.chats) {
        if (!c.cwd || c.updatedAt < since) continue
        const p = at(worktrees.get(c.cwd) ?? c.cwd)
        p.chats++
        p.lastAt = Math.max(p.lastAt, c.updatedAt)
      }
      if (!batch.more) break
    }
    return [...byPath.values()]
      .filter(p => isAllowed(p.path, roots) && isDir(p.path))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
  }

  private queue(r: Extract<Request, { type: 'queue' }>, config: Config, role: Role): Outcome {
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
    // Attachments: only files apps uploaded, and still there.
    const attachments = o.attachments ?? []
    if (attachments.some(p => !isUpload(this.d.uploadsDir, p))) return { ok: false, code: 'invalid', error: 'An attachment is gone; add it again.' }
    const spec: JobSpec = {
      projectDir,
      prompt: r.prompt,
      plan,
      review: o.review ?? (plan ? d.review : false),
      execMode: o.mode ?? d.execMode,
      model: o.model ?? d.model,
      workModel: o.workModel ?? (o.model === undefined ? d.workModel : undefined) ?? null,
      workEffort: o.workEffort ?? (o.effort === undefined ? d.workEffort : undefined) ?? null,
      wantLink: o.link === true,
      effort: o.effort ?? d.effort,
      sessionPolicy: o.policy ?? (sessionId ? 'session' : 'continue'),
      sessionId,
      isolate: o.isolate ?? config.isolate,
      takeover: o.takeover,
      front: o.front,
      source: 'remote',
      ...when,
      attachments: attachments.length ? attachments : null,
      group: o.group ?? null,
    }
    const refusal = this.guard(spec, role)
    if (refusal) return { ok: false, code: 'policy', error: refusal }
    const twin = spec.group ? null : this.waitingTwin(spec)
    if (twin) return { ok: true, text: `Already queued as #${twin.id}.`, data: { job: jobInfo(twin) } }
    const job = this.d.runner.enqueue(spec)
    this.d.store.kvSet('lastProject', projectDir)
    return { ok: true, text: `Queued #${job.id}.`, data: { job: jobInfo(job) } }
  }

  /**
   * The same prompt for the same folder and conversation, still waiting, sent in the last few
   * minutes: sending again (an answer that came late, a second tap) gets that one, not a copy.
   */
  private waitingTwin(spec: JobSpec): Job | null {
    const since = this.d.now() - TWIN_MS
    return this.d.store.queued().find(j => j.createdAt >= since && j.projectDir === spec.projectDir && j.prompt.trim() === spec.prompt.trim() && (j.sessionId ?? null) === (spec.sessionId ?? null)) ?? null
  }

  /** Typed into the chat if the queue is running it and it's free, else a task that continues it. */
  private async writeToChat(sessionId: string, text: string, name: string, config: Config, role: Role): Promise<Outcome> {
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
    const refusal = this.guard(spec, role)
    if (refusal) return { ok: false, code: 'policy', error: refusal }
    const twin = this.waitingTwin(spec)
    if (twin) return { ok: true, text: `Already sent to ${title} as #${twin.id}.`, data: { job: jobInfo(twin) } }
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

/** Biggest the app-reports log grows before the old one is set aside (one older file is kept). */
const REPORTS_MAX = 1024 * 1024

/** Appends a problem report from an app; false when the disk said no. */
export function appendReport(path: string, r: { at: number; device: string; app: string; platform: string; text: string }): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > REPORTS_MAX) renameSync(path, `${path}.1`)
    appendFileSync(path, `--- ${new Date(r.at).toISOString()} · ${r.device} · ${r.app} · ${r.platform}\n${r.text.trim()}\n\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
