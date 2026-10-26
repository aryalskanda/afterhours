import { randomInt, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import type { Config } from '../shared/config'
import type { ExecMode, Job, JobSpec, LaunchSpec, LimitState } from '../shared/types'
import { duration, excerpt, modeLabel, oneLine } from './format'
import type { Worktree } from './system'
import { claudeArgv, sessionName, sessionSettings, type ScriptPaths } from './launch'
import { currentLimits, pickResetTime, windowsFromStatusline } from './limits'
import { describeAnswers, permissionDetail, type Notice, type Question } from './notify'
import { choosePlanOption, feedbackOption, planDialog, trustDialog, type MenuOption } from './screens'
import { whereLabel, type LiveSession } from './sessions'
import type { Store } from './store'
import { tail, type TmuxDriver } from './tmux'
import { suggestionLabel, usableSuggestions } from './rules'
import { toolName, toolSummary } from './tools'
import { withAttachments } from './uploads'
import { endProcesses, systemProcs, type Procs } from './procs'
import { artifactLinks, LINK_REQUEST, LINK_TASK, linksInTranscript } from './links'
import { costOf, mentionedSince, readTranscript, usageOf } from './transcript'

/** A tool call starting or ending in the running task, for apps watching it live. */
export interface ToolActivity {
  job: number
  at: number
  phase: 'start' | 'end'
  tool: string
  detail: string
}

export interface RunnerDeps {
  store: Store
  tmux: TmuxDriver
  notify: (notice: Notice) => void
  config: () => Config
  saveConfig: (config: Config) => void
  now: () => number
  claudePath: string
  /** argv prefix that runs this program (`cq`), used for `cq launch <id>` inside tmux. */
  selfCommand: string[]
  port: number
  home: string
  jobsDir: string
  scripts: ScriptPaths
  writeFile: (path: string, text: string) => void
  sessionHolders: (sessionId: string) => LiveSession[]
  git: {
    head(dir: string): Promise<string | null>
    diffStat(dir: string, since: string | null): Promise<string | null>
    worktree(projectDir: string, jobId: number, prompt: string): Promise<Worktree | null>
    commitAll(dir: string, message: string): Promise<boolean>
    /** The folder's files as a git tree, without touching the index or refs; null outside git. */
    snapshot(dir: string): Promise<string | null>
  }
  killPid: (pid: number) => void
  log: (line: string) => void
  /** Defaults to Bun.sleep; tests make waiting instant. */
  sleep?: (ms: number) => Promise<void>
  /** Opens a conversation in VS Code again, after a task took it from there. */
  reopenInVsCode?: (sessionId: string) => void
  /** Tool calls as they happen, for apps watching the task. */
  activity?: (a: ToolActivity) => void
  /** Whether a folder is one the machine shares with apps (extra folders a rule may allow). */
  allowedDir?: (dir: string) => boolean
  /** Where apps' attachments are kept; a task with some may read there. */
  uploadsDir?: string
  /** Finding and ending a task's processes (tests use a fake). */
  procs?: Procs
}

/** What a hook sends: the documented common fields plus per-event ones. */
export interface HookPayload {
  session_id?: string
  transcript_path?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  notification_type?: string
  message?: string
  error?: string
  error_details?: string
  last_assistant_message?: string
  background_tasks?: { id?: string; type?: string; status?: string; description?: string }[]
  stop_hook_active?: boolean
  [key: string]: unknown
}

type HookResponse = Record<string, unknown>

interface Resolution {
  status: 'allowed' | 'denied' | 'answered' | 'expired'
  answer: string | null
  /** Allowed with one of the request's suggestions applied (its index). */
  rule?: number
}

/** In-memory state for the job being supervised. Rebuilt from the database after a restart. */
interface Runtime {
  window: string
  launchedAt: number
  sessionStarted: boolean
  lastActivity: number
  lastTool?: string
  plan?: {
    since: number
    attempts: number
    sentAt?: number
    choice?: string
    switchAfter?: ExecMode
    reviewCode?: string
    feedbackStage?: 'selected' | 'typed'
  }
  /** Plan approved with "manually approve edits"; switch to the job's mode on the next permission prompt. */
  switchAfter?: ExecMode
  trust?: { since: number; code?: string; approved?: boolean }
  limit?: { at: number | null; window?: string; since: number; stage: 0 | 1 | 2; sentAt?: number; force?: boolean }
  retry?: { at: number; count: number }
  /** The turn ended with background commands still running; Claude wakes again when they finish. */
  background?: { since: number; bounded: boolean }
  finishing?: { since: number; exitSentAt?: number }
  promptSeenAt?: number
  /** When you last typed or pressed keys into the session (say, keys), to tell who ended a limit wait. */
  saidAt?: number
  /** Work time not yet written to the job, and when it was last counted. */
  unsaved?: number
  countedAt?: number
  /** Asked for a live link at the end: when, and Claude's answer before that (the task's answer). */
  linkAsked?: { at: number; answer: string | null }
  /** The live link was looked for (once, as the task ends). */
  linksRead?: boolean
}

const NUDGE =
  "You're running unattended from a prompt queue and the user can't reply right now. " +
  'Make reasonable assumptions, finish your plan, and call ExitPlanMode to present it.'

/** What the work model is told when it takes over an approved plan (plan with one model, work with another). */
const HANDOFF_PROMPT = 'Your plan is approved. Carry it out now, step by step, and finish the task.'

/** What an ask task tells Claude when it presents a plan anyway. */
const ASK_FEEDBACK = "This task is a question: answer it directly in your reply. Don't present a plan or change anything."

/** Tools that only read: while a task is still planning, a mode that doesn't ask allows them at once. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch'])

/** Whether a tool changes something: the edit tools, and anything from an MCP server. */
function isChange(tool: string): boolean {
  return ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) || tool.startsWith('mcp__')
}

/**
 * What a task that plans first is told when it asks to change something while still in plan mode:
 * nothing can change yet, so the ask never goes to the phone; presenting the plan is the way on.
 */
function planFirstReason(review: boolean): string {
  return (
    "This task plans first and you're still in plan mode, so nothing can change yet. " +
    `Present your plan now with ExitPlanMode. ${review ? 'The user reviews it' : "It's approved automatically"}, ` +
    'and then you can make this change.'
  )
}

const CODE_LETTERS = 'abcdefghijkmnopqrstuvwxyz' // no "l": it reads like 1 and I on a phone

/** A key typed right after Esc arrives as one Alt+key sequence; wait this long in between. */
const ESC_SETTLE_MS = 600

/** Events that prove a turn ran again after a usage-limit stop. */
const ACTIVITY_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'])

/** Background work that always finishes and wakes the session; shells and monitors may run forever. */
const FINITE_TASKS = new Set(['subagent', 'workflow'])

/** From when a task's own runs of its conversation count (a little before it started, for clocks). */
export function taskStart(job: Pick<Job, 'startedAt'>): number {
  return job.startedAt ? job.startedAt - 1000 : 0
}

export function windowName(jobId: number): string {
  return `job-${jobId}`
}

/**
 * Whether the job may close the other windows holding its conversation: you asked it to take the
 * conversation over, and every one of them is an idle interactive session opened before you asked.
 * A window you (re)opened afterwards is never closed; you're asked again instead.
 */
export function canTakeOver(job: Pick<Job, 'takeoverAt'>, holders: LiveSession[]): boolean {
  const since = job.takeoverAt
  if (since === null || holders.length === 0) return false
  return holders.every(h => (h.kind ?? 'interactive') === 'interactive' && h.status !== 'busy' && (h.startedAt ?? 0) <= since)
}

/** How long a task taken off the queue can be put back. */
const RESTORE_MS = 10 * 60_000

/** After asking the other windows to close, how long to wait for them to let go of the conversation. */
const RELEASE_WAIT_MS = 10_000
/** And how long to watch for one opening it again (an editor that restarts its Claude process). */
const RELEASE_SETTLE_MS = 1500

export class Runner {
  private runtimes = new Map<number, Runtime>()
  private waiters = new Map<string, (r: Resolution) => void>()
  private limitNotified = new Set<number>()
  private ticking = false
  private tickStartedAt = 0
  private stallLoggedAt = 0
  /** When each job was last started again after its window vanished (one try per 10 minutes). */
  private recoveredAt = new Map<number, number>()

  constructor(private d: RunnerDeps) {}

  // --- queue ------------------------------------------------------------------

  enqueue(spec: JobSpec): Job {
    return this.d.store.addJob(spec, this.d.now())
  }

  get paused(): boolean {
    return this.d.store.kvGet<boolean>('paused') ?? false
  }

  setPaused(paused: boolean): void {
    this.d.store.kvSet('paused', paused)
  }

  hasWork(): boolean {
    return this.d.store.active() !== null || (!this.paused && this.d.store.queued().length > 0)
  }

  /** The usage limits as they stand now: a window that has reset since the last reading is unknown. */
  limits(): LimitState {
    return currentLimits(this.d.store.kvGet<LimitState>('limits') ?? {}, this.d.now())
  }

  private saveLimits(state: LimitState): void {
    this.d.store.kvSet('limits', state)
  }

  launchSpec(id: number): LaunchSpec | null {
    return this.d.store.getJob(id)?.launchSpec ?? null
  }

  runtimeInfo(jobId: number): { lastActivity: number; lastTool?: string } | null {
    const rt = this.runtimes.get(jobId)
    return rt ? { lastActivity: rt.lastActivity, lastTool: rt.lastTool } : null
  }

  // --- main loop ----------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) {
      // One supervision pass at a time; one that hangs would stop limit restarts, so say so.
      const now = this.d.now()
      if (now - this.tickStartedAt > 60_000 && now - this.stallLoggedAt > 60_000) {
        this.stallLoggedAt = now
        this.d.log(`supervision has been stuck for ${duration(now - this.tickStartedAt)}`)
      }
      return
    }
    this.ticking = true
    this.tickStartedAt = this.d.now()
    try {
      const job = this.d.store.active()
      if (job) await this.supervise(job)
      else await this.startNext()
    } catch (err) {
      this.d.log(`tick failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
    } finally {
      this.ticking = false
    }
  }

  private async startNext(): Promise<void> {
    if (this.paused) return
    const now = this.d.now()
    const blockedUntil = this.limits().blockedUntil
    if (blockedUntil && now < blockedUntil) return
    for (const job of this.d.store.queued()) {
      // On hold, or scheduled for later: it keeps its place, and the next one may go first.
      if (job.onHold) continue
      if (job.notBefore && now < job.notBefore) continue
      if (job.afterJob !== null) {
        const before = this.d.store.getJob(job.afterJob)
        if (before && (before.status === 'queued' || before.status === 'running' || before.status === 'held')) continue
        if (!before || before.status !== 'done') {
          const reason = `#${job.afterJob} ${before ? (before.status === 'failed' ? 'failed' : 'was cancelled') : 'is gone'}, so #${job.id}, which waited for it, didn't start`
          const dropped = this.d.store.updateJob(job.id, { status: 'cancelled', finishedAt: now, error: reason })
          this.d.notify({ type: 'failed', job: dropped, reason })
          this.scheduleRepeat(dropped)
          continue
        }
      }
      await this.launch(job)
      return
    }
  }

  /** A daily task queues its next run when this one ends, however it ended. */
  private scheduleRepeat(job: Job): void {
    if (job.repeatDaily === null) return
    const next = new Date(this.d.now())
    next.setHours(Math.floor(job.repeatDaily / 60), job.repeatDaily % 60, 0, 0)
    if (next.getTime() <= this.d.now()) next.setDate(next.getDate() + 1)
    const again = this.enqueue({
      projectDir: job.projectDir,
      prompt: job.prompt,
      plan: job.plan,
      review: job.review,
      execMode: job.execMode,
      model: job.model,
      effort: job.effort,
      sessionPolicy: job.sessionPolicy === 'session' ? 'continue' : job.sessionPolicy,
      isolate: job.isolate,
      source: job.source,
      notBefore: next.getTime(),
      repeatDaily: job.repeatDaily,
      maxMinutes: job.maxMinutes,
      workModel: job.workModel,
    })
    this.d.log(`#${job.id} repeats daily: #${again.id} is queued for ${next.toISOString()}`)
  }

  /**
   * Whether a task has ended (killed, skipped, finished) since the code holding it last looked:
   * then that code must leave it alone, so a task killed mid-launch never starts again.
   */
  private ended(id: number): boolean {
    const status = this.d.store.getJob(id)?.status
    return status === undefined || status === 'cancelled' || status === 'done' || status === 'failed'
  }

  private runtime(job: Job): Runtime {
    let rt = this.runtimes.get(job.id)
    if (!rt) {
      const now = this.d.now()
      rt = {
        window: windowName(job.id),
        launchedAt: job.lastEventAt ?? job.startedAt ?? now,
        sessionStarted: job.transcriptPath !== null,
        lastActivity: job.lastEventAt ?? now,
      }
      if (job.phase === 'finishing') rt.finishing = { since: now }
      if (job.phase === 'limited') rt.limit = { at: this.limits().blockedUntil ?? null, since: now, stage: 0 }
      this.runtimes.set(job.id, rt)
    }
    return rt
  }

  private async launch(job: Job, promptOverride?: string, opts: { skipConflictCheck?: boolean } = {}): Promise<void> {
    if (this.ended(job.id)) return
    const now = this.d.now()
    const config = this.d.config()
    if (!existsSync(job.projectDir)) {
      this.d.store.updateJob(job.id, { status: 'failed', finishedAt: now, error: `folder not found: ${job.projectDir}` })
      this.d.notify({ type: 'failed', job: this.d.store.getJob(job.id)!, reason: `folder not found: ${job.projectDir}` })
      return
    }

    // A thread whose worktree you've since removed can't be continued: start a new conversation.
    let thread = job.sessionPolicy === 'continue' && !job.sessionId ? this.d.store.getThread(job.projectDir) : null
    if (thread?.workDir && !existsSync(thread.workDir)) thread = null
    let sessionId = job.sessionId ?? thread?.sessionId ?? null
    // A follow-up runs where its conversation lives: on that conversation's branch, if it has one.
    const home = !job.workDir && sessionId ? this.d.store.sessionWorktree(sessionId) : null
    const lives = home && existsSync(home.workDir) ? home : null
    let workDir = job.workDir ?? lives?.workDir ?? thread?.workDir ?? null
    let branch = job.branch ?? lives?.branch ?? null
    let sessionArgs: string[]
    let isNew = false
    let tookEntry: string | null = null
    if (sessionId && job.fork) {
      const copy = randomUUID()
      sessionArgs = ['--resume', sessionId, '--fork-session', '--session-id', copy]
      sessionId = copy
    } else if (sessionId) {
      let holders = opts.skipConflictCheck ? [] : this.d.sessionHolders(sessionId)
      let tookFrom: string | null = null
      let stuck = false
      if (canTakeOver(job, holders)) {
        tookFrom = whereLabel(holders[0]!)
        tookEntry = holders[0]!.entrypoint ?? 'claude'
        const left = await this.release(sessionId, holders)
        if (this.ended(job.id)) return
        stuck = left.length > 0
        holders = left
      }
      if (holders.length > 0) {
        const h = holders[0]!
        const busy = h.status === 'busy'
        // Asked once and it didn't let go: don't ask again by itself, wait for you.
        const held = this.d.store.updateJob(job.id, {
          status: 'held',
          holdReason: 'conflict',
          sessionId,
          workDir,
          ...(stuck ? { takeoverAt: null } : {}),
        })
        const state = stuck ? 'stuck' : held.takeoverAt !== null && busy ? 'waiting' : 'open'
        this.d.notify({ type: 'conflict', job: held, holder: `${h.entrypoint ?? 'claude'} pid ${h.pid}`, where: whereLabel(h), busy, state })
        return
      }
      if (tookFrom) {
        this.d.log(`#${job.id}: took conversation ${sessionId} over from ${tookFrom}`)
        this.d.notify({ type: 'took_over', job, where: tookFrom })
      }
      sessionArgs = ['--resume', sessionId]
    } else {
      sessionId = randomUUID()
      sessionArgs = ['--session-id', sessionId]
      isNew = true
      if (job.isolate && !workDir) {
        const wt = await this.d.git.worktree(job.projectDir, job.id, job.prompt)
        if (wt) {
          workDir = wt.dir
          branch = wt.branch
        } else {
          this.d.log(`#${job.id}: ${job.projectDir} isn't a git repo with a commit; running in place`)
        }
      }
    }
    const cwd = workDir ?? job.projectDir
    if (!existsSync(cwd)) {
      this.d.store.updateJob(job.id, { status: 'failed', finishedAt: now, error: `folder not found: ${cwd}` })
      this.d.notify({ type: 'failed', job: this.d.store.getJob(job.id)!, reason: `folder not found: ${cwd}` })
      return
    }

    const settingsPath = join(this.d.jobsDir, `${job.id}.settings.json`)
    this.d.writeFile(settingsPath, JSON.stringify(sessionSettings(job, config, this.d.scripts), null, 2))
    // Plan with one model, work with another: after the plan, every run is the work model's.
    const model = job.planApproved && job.workModel ? job.workModel : job.model
    const argv = claudeArgv({ ...job, model }, {
      claudePath: this.d.claudePath,
      settingsPath,
      sessionArgs,
      // Attachments are named in the first prompt only; a restart says "continue".
      prompt: promptOverride ?? (job.launches === 0 ? withAttachments(job.prompt, job.attachments) : job.prompt),
      name: isNew ? sessionName(job.prompt) : undefined,
      remoteControl: config.remoteControl,
      addDirs: job.attachments?.length && this.d.uploadsDir ? [this.d.uploadsDir] : undefined,
    })
    const startHead = job.launches === 0 ? await this.d.git.head(cwd) : job.startHead
    const startTree = job.launches === 0 ? await this.d.git.snapshot(cwd) : job.startTree
    if (this.ended(job.id)) return
    const updated = this.d.store.updateJob(job.id, {
      status: 'running',
      phase: 'launching',
      holdReason: null,
      sessionId,
      fork: false,
      workDir,
      branch,
      launches: job.launches + 1,
      launchSpec: { cwd, argv },
      ...(tookEntry ? { tookFrom: tookEntry } : {}),
      startedAt: job.startedAt ?? now,
      startHead,
      startTree,
      lastEventAt: now,
    })
    this.d.store.setThread(job.projectDir, sessionId, now, workDir)

    const window = windowName(job.id)
    this.runtimes.set(job.id, { window, launchedAt: now, sessionStarted: false, lastActivity: now })
    await this.d.tmux.killWindow(window)
    try {
      await this.d.tmux.spawnWindow(
        window,
        cwd,
        { CQ_JOB_ID: String(job.id), CQ_PORT: String(this.d.port), CQ_HOME: this.d.home },
        [...this.d.selfCommand, 'launch', String(job.id)],
      )
    } catch (err) {
      if (this.ended(job.id)) return
      const reason = `couldn't start tmux: ${err instanceof Error ? err.message : err}`
      this.d.store.updateJob(job.id, { status: 'failed', phase: null, finishedAt: now, error: reason })
      this.d.notify({ type: 'failed', job: updated, reason })
      return
    }
    // Killed while its window was opening: close it again.
    if (this.ended(job.id)) {
      await this.d.tmux.killWindow(window)
      return
    }
    // Without the prompt or the session name (which quotes it), so the log stays free of prompts.
    const shown = argv.slice(1, -1).filter((arg, i, all) => arg !== '--name' && all[i - 1] !== '--name')
    this.d.log(`launched #${job.id}: ${shown.join(' ')}`)
    if (job.launches === 0) this.d.notify({ type: 'started', job: updated })
  }

  /** Kills the job's window, waits for its Claude process to let go of the session, and starts it again. */
  private async relaunch(job: Job, prompt?: string): Promise<void> {
    await this.d.tmux.killWindow(windowName(job.id))
    if (job.sessionId) {
      for (let i = 0; i < 20 && this.d.sessionHolders(job.sessionId).length > 0; i++) await Bun.sleep(250)
      for (const h of this.d.sessionHolders(job.sessionId)) {
        if (h.entrypoint === 'cli') this.d.killPid(h.pid)
      }
    }
    await this.launch(this.d.store.getJob(job.id)!, prompt, { skipConflictCheck: true })
  }

  /**
   * Asks the Claude processes holding a conversation to exit (SIGTERM, never SIGKILL) and waits for
   * them to let go. Returns whoever still holds it, including a window that opened it again.
   */
  private async release(sessionId: string, holders: LiveSession[]): Promise<LiveSession[]> {
    const sleep = this.d.sleep ?? Bun.sleep
    for (const h of holders) this.d.killPid(h.pid)
    for (let waited = 0; waited < RELEASE_WAIT_MS && this.d.sessionHolders(sessionId).length > 0; waited += 250) await sleep(250)
    if (this.d.sessionHolders(sessionId).length === 0) await sleep(RELEASE_SETTLE_MS)
    return this.d.sessionHolders(sessionId)
  }

  private hold(job: Job, reason: string, screen?: string, kind: 'held' | 'failed' = 'held'): void {
    if (this.ended(job.id)) return
    const updated = this.d.store.updateJob(job.id, { status: 'held', holdReason: reason, error: kind === 'failed' ? reason : job.error })
    this.d.notify({ type: kind, job: updated, reason, screen })
  }

  private async typeLine(window: string, text: string): Promise<void> {
    await this.d.tmux.sendText(window, text.replace(/\s*\n\s*/g, ' '))
    await this.d.tmux.sendKeys(window, 'Enter')
  }

  // --- supervision (every tick, for the active job) ------------------------------

  private async supervise(job: Job): Promise<void> {
    if (job.holdReason === 'conflict') {
      // Waiting for another Claude window to let go of the conversation: start as soon as it does,
      // or, once you've asked to take it over, as soon as that window is idle.
      if (job.sessionId) {
        const holders = this.d.sessionHolders(job.sessionId)
        if (holders.length === 0 || canTakeOver(job, holders)) await this.launch(job)
      }
      return
    }
    const now = this.d.now()
    const config = this.d.config()
    const rt = this.runtime(job)
    const pane = await this.d.tmux.pane(rt.window)

    if (!pane || pane.dead) {
      if (rt.finishing) return this.finish(job)
      if (job.status === 'held') return
      // The window is gone entirely (the Mac restarted, or tmux was stopped), not Claude exiting
      // in it: start the conversation again once, rather than failing the task.
      if (!pane && job.sessionId && rt.sessionStarted && now - (this.recoveredAt.get(job.id) ?? 0) > 10 * 60_000) {
        this.recoveredAt.set(job.id, now)
        this.d.log(`#${job.id}: its window is gone; starting the conversation again`)
        await this.relaunch(job, 'continue')
        this.d.notify({ type: 'recovered', job: this.d.store.getJob(job.id)! })
        return
      }
      const screen = pane ? tail(await this.d.tmux.capture(rt.window, 80), 12) : undefined
      const reason = pane ? `Claude exited (code ${pane.deadStatus ?? '?'})` : 'its tmux window is gone'
      return this.hold(job, reason, screen, 'failed')
    }
    if (job.status === 'held') return
    if (rt.finishing) return this.continueFinishing(job, rt)

    if (!rt.sessionStarted) {
      const screen = await this.d.tmux.capture(rt.window, 40)
      if (trustDialog(screen).present) return this.handleTrust(job, rt, screen)
      if (now - rt.launchedAt > config.timeouts.launchSec * 1000) {
        this.hold(job, `Claude didn't start within ${config.timeouts.launchSec}s`, tail(screen, 15))
      }
      return
    }

    if (rt.retry && now >= rt.retry.at) {
      await this.typeLine(rt.window, 'continue')
      rt.retry = undefined
      rt.lastActivity = now
    }

    // Work time, usage-limit waits aside; a task with a time limit stops when it's used up.
    if (job.phase !== 'limited') {
      rt.unsaved = (rt.unsaved ?? 0) + Math.max(0, Math.min(now - (rt.countedAt ?? now), 60_000))
      const worked = job.activeMs + rt.unsaved
      const over = job.maxMinutes !== null && worked >= job.maxMinutes * 60_000
      if (rt.unsaved >= 15_000 || over) {
        job = this.d.store.updateJob(job.id, { activeMs: worked })
        rt.unsaved = 0
      }
      if (over) {
        rt.countedAt = now
        await this.d.tmux.sendKeys(rt.window, 'Escape')
        return this.hold(job, `it worked ${job.maxMinutes} minute${job.maxMinutes === 1 ? '' : 's'}, its time limit`)
      }
    }
    rt.countedAt = now

    if (job.phase === 'limited') return this.handleLimit(job, rt)
    // rt.plan alone: Claude entered plan mode by itself in a non-plan job.
    if ((job.plan && !job.planApproved) || rt.plan) await this.handlePlan(job, rt)

    if (rt.background?.bounded && now - rt.background.since > config.timeouts.backgroundSec * 1000) {
      const since = rt.background.since
      rt.background = undefined
      // The work is done but wants a live link it hasn't been asked for: ask now, as a message.
      if (job.wantLink && !rt.linkAsked) {
        this.d.log(`#${job.id}: background commands still running after the work; asking Claude for a live link`)
        rt.linkAsked = { at: now, answer: job.lastMessage }
        rt.lastActivity = now
        await this.typeLine(rt.window, LINK_REQUEST)
        return
      }
      this.d.log(`#${job.id}: background commands still running after ${duration(now - since)}; calling the job done`)
      this.beginFinish(job, rt)
      return
    }

    if (rt.promptSeenAt && now - rt.promptSeenAt > 20_000) {
      rt.promptSeenAt = undefined
      const screen = await this.d.tmux.capture(rt.window, 40)
      const waitingOnUs = this.d.store.pendingApprovals(job.id).length > 0 || planDialog(screen).present
      if (!waitingOnUs && /Do you want|❯\s*1\./.test(screen)) {
        return this.hold(job, `Claude is waiting at a prompt ${BRAND.name} can't answer`, tail(screen, 15))
      }
    }

    const quietFor = now - rt.lastActivity
    if (quietFor > config.timeouts.stuckSec * 1000 && this.d.store.pendingApprovals(job.id).length === 0) {
      const busy = job.sessionId ? this.d.sessionHolders(job.sessionId).some(h => h.status === 'busy') : false
      if (busy) {
        rt.lastActivity = now // a long tool call; check again later
        return
      }
      const screen = tail(await this.d.tmux.capture(rt.window, 60), 15)
      this.hold(job, `no activity for ${duration(quietFor)}`, screen)
    }
  }

  private async handleTrust(job: Job, rt: Runtime, screen: string): Promise<void> {
    const now = this.d.now()
    const config = this.d.config()
    rt.trust ??= { since: now }
    const trusted = config.trustedDirs.some(d => job.projectDir === d || job.projectDir.startsWith(d.endsWith('/') ? d : d + '/'))
    if (!trusted && !rt.trust.approved) {
      if (!rt.trust.code) {
        rt.trust.code = this.newCode()
        this.d.store.addApproval(rt.trust.code, job.id, 'trust', { dir: job.projectDir }, now)
        this.d.notify({ type: 'trust', job, code: rt.trust.code })
        return
      }
      const approval = this.d.store.getApproval(rt.trust.code)
      if (approval?.status === 'allowed') {
        rt.trust.approved = true
        if (!config.trustedDirs.includes(job.projectDir)) {
          config.trustedDirs.push(job.projectDir)
          this.d.saveConfig(config)
        }
      } else if (approval?.status === 'denied') {
        await this.d.tmux.killWindow(rt.window)
        this.d.store.updateJob(job.id, { status: 'cancelled', phase: null, finishedAt: now, holdReason: null })
        this.runtimes.delete(job.id)
        return
      } else {
        if (now - rt.trust.since > config.timeouts.approvalSec * 1000) {
          this.d.store.resolveApproval(rt.trust.code, 'expired', null, now)
          this.hold(job, 'waiting for you to trust the folder')
        }
        return
      }
    }
    // "No, exit" has focus: move to "Yes, I trust this folder", confirm it's selected, then Enter.
    if (!trustDialog(screen).yesFocused) {
      await this.d.tmux.sendKeys(rt.window, 'Down')
      return
    }
    await this.d.tmux.sendKeys(rt.window, 'Enter')
    rt.launchedAt = now
    this.d.log(`#${job.id}: accepted Claude's folder trust prompt for ${job.projectDir}`)
  }

  private async handlePlan(job: Job, rt: Runtime): Promise<void> {
    const now = this.d.now()
    const config = this.d.config()
    const screen = await this.d.tmux.capture(rt.window, 80)
    const dialog = planDialog(screen)

    if (!dialog.present) {
      const p = rt.plan
      if (p?.sentAt && !p.feedbackStage) this.markPlanApproved(job, rt) // we pressed approve and it closed
      else if (p?.feedbackStage === 'typed') rt.plan = undefined // Claude is revising; a new dialog follows
      return
    }

    rt.plan ??= { since: now, attempts: 0 }
    const p = rt.plan
    if (!job.planText) {
      const text = planFromScreen(screen)
      if (text) job = this.d.store.updateJob(job.id, { planText: text })
    }

    // An ask task wants an answer, not a plan: send it back to answering.
    if (job.execMode === 'plan' && !job.plan) return this.sendPlanFeedback(job, rt, dialog.options, ASK_FEEDBACK)

    if (job.review) {
      if (!p.reviewCode) {
        p.reviewCode = this.newCode()
        this.d.store.addApproval(p.reviewCode, job.id, 'review', {}, now)
        this.d.notify({ type: 'plan_review', job, code: p.reviewCode })
        return
      }
      const approval = this.d.store.getApproval(p.reviewCode)
      if (approval?.status === 'pending') {
        if (now - approval.createdAt > config.timeouts.reviewSec * 1000) {
          this.d.store.resolveApproval(p.reviewCode, 'expired', null, now)
          this.hold(job, 'the plan is still waiting for your review (reply go to approve it)')
        }
        return
      }
      if (approval?.status === 'denied') return this.sendPlanFeedback(job, rt, dialog.options, approval.answer)
    }

    if (p.sentAt && now - p.sentAt < 4000) return
    if (p.attempts >= 3) return this.hold(job, "couldn't approve the plan dialog", tail(screen, 20))
    const choice = choosePlanOption(dialog.options, job.execMode)
    if (!choice) return this.hold(job, "didn't recognize the plan dialog's options", tail(screen, 20))
    if (job.workModel && job.workModel !== job.model) return this.handOver(job, rt, choice.option.label)
    await this.d.tmux.sendKeys(rt.window, String(choice.option.n))
    p.sentAt = now
    p.attempts++
    p.choice = choice.option.label
    p.switchAfter = choice.switchAfter
    this.d.log(`#${job.id}: answered plan dialog with "${choice.option.label}"`)
  }

  /**
   * Plan with one model, work with another: the plan is approved, so rather than answering the
   * dialog, the planner's window closes and the same conversation resumes on the work model, in
   * the task's own mode, told to carry the plan out.
   */
  private async handOver(job: Job, rt: Runtime, choice: string): Promise<void> {
    job = this.d.store.updateJob(job.id, { planApproved: true, phase: 'working', nudges: 0 })
    rt.plan = undefined
    this.d.log(`#${job.id}: plan approved; ${job.workModel} carries it out`)
    await this.relaunch(job, HANDOFF_PROMPT)
    if (this.ended(job.id)) return
    this.d.notify({ type: 'plan_approved', job: this.d.store.getJob(job.id)!, choice: `${choice.replace(/\.$/, '')}; ${job.workModel} carries it out` })
  }

  private markPlanApproved(job: Job, rt: Runtime): Job {
    const p = rt.plan
    const approved = this.d.store.updateJob(job.id, { planApproved: true, phase: 'working', nudges: 0 })
    if (p?.switchAfter) rt.switchAfter = p.switchAfter
    rt.plan = undefined
    this.d.notify({ type: 'plan_approved', job: approved, choice: p?.choice ?? 'approved' })
    return approved
  }

  private async sendPlanFeedback(job: Job, rt: Runtime, options: MenuOption[], feedback: string | null): Promise<void> {
    const p = rt.plan!
    if (!p.feedbackStage) {
      const option = feedbackOption(options)
      if (!option) return this.hold(job, "the plan dialog has no option for sending changes")
      await this.d.tmux.sendKeys(rt.window, String(option.n))
      p.feedbackStage = 'selected'
      return
    }
    if (p.feedbackStage === 'selected') {
      await this.typeLine(rt.window, feedback || 'Please revise the plan.')
      p.feedbackStage = 'typed'
      p.reviewCode = undefined
    }
  }

  private async handleLimit(job: Job, rt: Runtime): Promise<void> {
    const now = this.d.now()
    const config = this.d.config()
    const limit = (rt.limit ??= { at: this.limits().blockedUntil ?? null, since: now, stage: 0 })
    const due = (limit.at ?? limit.since + 15 * 60_000) + config.timeouts.limitGraceSec * 1000
    if (!limit.force && now < due) return
    if (limit.stage === 0) {
      // Claude Code's own auto-continue should have fired at the reset. It didn't, so type it.
      // Esc first closes any limit menu; the pause stops the terminal reading Esc+"c" as Alt-c.
      this.d.log(`#${job.id}: ${limit.force ? 'continuing now as you asked' : "the limit has reset and Claude Code hasn't continued"}; typing continue`)
      await this.d.tmux.sendKeys(rt.window, 'Escape')
      await Bun.sleep(ESC_SETTLE_MS)
      await this.typeLine(rt.window, 'continue')
      limit.stage = 1
      limit.sentAt = now
      limit.force = false
      this.d.log(`#${job.id}: typed continue after the limit reset`)
      return
    }
    if (limit.stage === 1 && now - (limit.sentAt ?? now) > 60_000) {
      this.d.log(`#${job.id}: typing continue didn't take; restarting the session`)
      await this.relaunch(job, 'continue')
      const fresh = this.runtimes.get(job.id)
      if (fresh) fresh.limit = { ...limit, stage: 2, sentAt: this.d.now() }
      this.d.store.updateJob(job.id, { phase: 'limited' })
      return
    }
    if (limit.stage === 2 && now - (limit.sentAt ?? now) > 120_000) {
      this.d.log(`#${job.id}: the restarted session didn't continue either; holding it for you`)
      this.hold(job, "couldn't continue after the limit reset", tail(await this.d.tmux.capture(rt.window, 60), 15))
    }
  }

  /** The task runs again after a usage limit. `how` = who restarted it, for the notice and the log. */
  private limitCleared(job: Job, rt: Runtime, by?: 'claude'): void {
    const now = this.d.now()
    const how: 'claude' | 'afterhours' | 'you' =
      by ?? (rt.limit && rt.limit.stage > 0 ? 'afterhours' : rt.saidAt && now - rt.saidAt < 60_000 ? 'you' : 'claude')
    this.d.log(`#${job.id}: running again after the usage limit (restarted by ${how === 'claude' ? 'Claude Code' : how === 'afterhours' ? BRAND.name : 'you'})`)
    rt.limit = undefined
    this.limitNotified.delete(job.id)
    this.d.store.updateJob(job.id, { phase: job.plan && !job.planApproved ? 'planning' : 'working' })
    this.saveLimits({ ...this.limits(), blockedUntil: null })
    this.d.notify({ type: 'resumed', job, how })
  }

  private beginFinish(job: Job, rt: Runtime): void {
    // A live link is read whichever way the task gets here (a Stop, or background work timing out).
    const now = this.d.store.getJob(job.id) ?? job
    if ((now.wantLink || now.linkFor !== null) && !rt.linksRead) {
      rt.linksRead = true
      this.collectLinks(now, rt, now.lastMessage ?? '')
    }
    rt.finishing = { since: this.d.now() }
    this.d.store.updateJob(job.id, { phase: 'finishing' })
  }

  private async continueFinishing(job: Job, rt: Runtime): Promise<void> {
    const now = this.d.now()
    const f = rt.finishing!
    if (!f.exitSentAt) {
      // Let the user's own Stop hooks finish first (up to 20s).
      const busy = job.sessionId ? this.d.sessionHolders(job.sessionId).some(h => h.status === 'busy') : false
      if (busy && now - f.since < 20_000) return
      if (now - f.since < 1500) return
      await this.typeLine(rt.window, '/exit')
      f.exitSentAt = now
      return
    }
    if (now - f.exitSentAt > 15_000) {
      await this.d.tmux.killWindow(rt.window)
      await this.finish(job)
    }
  }

  private async finish(job: Job): Promise<void> {
    const now = this.d.now()
    // On its own branch, the work is committed there so the branch can be reviewed and merged.
    if (job.branch && job.workDir) await this.d.git.commitAll(job.workDir, `${BRAND.name} #${job.id}: ${oneLine(job.prompt, 72)}`)
    const diff = await this.d.git.diffStat(job.workDir ?? job.projectDir, job.startHead)
    await this.d.tmux.killWindow(windowName(job.id))
    const ending = await this.endState(job)
    if (this.ended(job.id)) return
    const done = this.d.store.updateJob(job.id, { status: 'done', phase: null, finishedAt: now, summary: diff, ...ending })
    this.runtimes.delete(job.id)
    // Taken from VS Code: open it there again (unless more is queued for it), so VS Code is up to date.
    if (job.tookFrom === 'claude-vscode' && job.sessionId && this.d.config().reopenInVsCode && !this.d.store.pendingForSession(job.sessionId)) {
      this.d.reopenInVsCode?.(job.sessionId)
    }
    const next = this.paused ? null : (this.d.store.queued()[0] ?? null)
    this.d.notify({ type: 'done', job: done, diff, next })
    this.scheduleRepeat(done)
  }

  // --- hooks ------------------------------------------------------------------------

  async onHook(event: string, jobId: number, payload: HookPayload): Promise<HookResponse> {
    let job = this.d.store.getJob(jobId)
    if (!job || (job.status !== 'running' && job.status !== 'held')) return {}
    const now = this.d.now()
    const rt = this.runtime(job)
    this.d.store.logEvent(job.id, event, summarizePayload(payload), now)
    job = this.d.store.updateJob(job.id, { lastEventAt: now })
    if (event !== 'Notification' && event !== 'StopFailure' && event !== 'SessionEnd') rt.lastActivity = now

    if (ACTIVITY_EVENTS.has(event) && job.phase === 'limited') {
      this.limitCleared(job, rt)
      job = this.d.store.getJob(job.id)!
    }
    // Out of plan mode: either our keypress landed before the next tick noticed, or it was approved by hand.
    if (job.plan && !job.planApproved && rt.sessionStarted && payload.permission_mode && payload.permission_mode !== 'plan' && ACTIVITY_EVENTS.has(event)) {
      if (rt.plan?.sentAt) job = this.markPlanApproved(job, rt)
      else {
        job = this.d.store.updateJob(job.id, { planApproved: true })
        rt.plan = undefined
      }
    }

    switch (event) {
      case 'SessionStart': {
        rt.sessionStarted = true
        const patch: Partial<Job> = {}
        if (payload.transcript_path) patch.transcriptPath = payload.transcript_path
        if (payload.session_id && payload.session_id !== job.sessionId) {
          patch.sessionId = payload.session_id
          this.d.store.setThread(job.projectDir, payload.session_id, now, job.workDir)
        }
        this.d.store.updateJob(job.id, patch)
        return {}
      }
      case 'UserPromptSubmit': {
        rt.sessionStarted = true
        // An ask task runs in plan mode too, but it's answering, not planning.
        const patch: Partial<Job> = { phase: payload.permission_mode === 'plan' && job.plan ? 'planning' : 'working' }
        if (payload.transcript_path) patch.transcriptPath = payload.transcript_path
        if (job.status === 'held' && job.holdReason !== 'conflict') Object.assign(patch, { status: 'running', holdReason: null })
        if (!rt.finishing) this.d.store.updateJob(job.id, patch)
        return {}
      }
      case 'ToolStart':
        this.toolActivity(job, 'start', payload)
        return {}
      case 'PostToolUse':
        rt.lastTool = `${payload.tool_name ?? 'tool'} ${excerpt(permissionDetail(String(payload.tool_name), payload.tool_input), 80)}`
        if (job.status === 'held' && job.holdReason !== 'conflict') this.d.store.updateJob(job.id, { status: 'running', holdReason: null })
        this.toolActivity(job, 'end', payload)
        return {}
      case 'PermissionRequest':
        return this.onPermissionRequest(job, rt, payload)
      case 'PreToolUse':
        return payload.tool_name === 'AskUserQuestion' ? this.onQuestion(job, rt, payload) : {}
      case 'Stop':
        return this.onStop(job, rt, payload)
      case 'StopFailure':
        return this.onStopFailure(job, rt, payload)
      case 'Notification':
        return this.onNotification(job, rt, payload)
      default:
        return {}
    }
  }

  private toolActivity(job: Job, phase: 'start' | 'end', payload: HookPayload): void {
    if (!this.d.activity || typeof payload.tool_name !== 'string') return
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : (job.launchSpec?.cwd ?? job.projectDir)
    this.d.activity({ job: job.id, at: this.d.now(), phase, tool: toolName(payload.tool_name), detail: toolSummary(payload.tool_name, payload.tool_input, cwd) })
  }

  private async onPermissionRequest(job: Job, rt: Runtime, payload: HookPayload): Promise<HookResponse> {
    const tool = String(payload.tool_name ?? 'a tool')
    if (tool === 'ExitPlanMode') {
      // Claude Code doesn't let hooks approve a plan; handlePlan answers the dialog with keystrokes.
      const plan = payload.tool_input?.plan
      if (typeof plan === 'string') {
        // A revised plan: the one before stays, for comparing (the last five).
        const versions = job.planText && job.planText !== plan ? [...(job.planVersions ?? []), { at: this.d.now(), text: job.planText }].slice(-5) : job.planVersions
        this.d.store.updateJob(job.id, { planText: plan, planVersions: versions })
      }
      rt.plan ??= { since: this.d.now(), attempts: 0 }
      return {}
    }
    // Still planning: a change can't happen yet, and asking about each one (over a bad connection,
    // from a phone) only delays the plan. Claude is told to present it; reading is fine in a mode
    // that wouldn't have asked.
    if (job.plan && !job.planApproved && payload.permission_mode === 'plan') {
      if (isChange(tool)) {
        this.d.log(`#${job.id}: ${tool} while planning; told Claude to present the plan`)
        return permissionDecision({ behavior: 'deny', message: planFirstReason(job.review) })
      }
      if (READ_ONLY.has(tool) && (job.execMode === 'auto' || job.execMode === 'bypassPermissions')) return permissionDecision({ behavior: 'allow' })
    }
    if (rt.switchAfter) {
      const mode = rt.switchAfter
      rt.switchAfter = undefined
      return permissionDecision({
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      })
    }
    const config = this.d.config()
    const code = this.newCode()
    const suggestions = usableSuggestions(payload.permission_suggestions, dir => this.d.allowedDir?.(dir) ?? false)
    this.d.store.addApproval(code, job.id, 'permission', { tool, input: payload.tool_input, ...(suggestions.length > 0 ? { suggestions } : {}) }, this.d.now())
    const detail = permissionDetail(tool, payload.tool_input)
    this.d.notify({
      type: 'permission',
      job,
      code,
      tool,
      detail,
      minutes: Math.round(config.timeouts.approvalSec / 60),
      ...(suggestions.length > 0 ? { suggestions: suggestions.map(s => suggestionLabel(s, job.launchSpec?.cwd ?? job.projectDir)) } : {}),
      allowedBefore: this.d.store.countAllowed(tool, detail, permissionDetail),
    })
    const r = await this.wait(code, config.timeouts.approvalSec)
    rt.lastActivity = this.d.now()
    const rule = r.rule !== undefined ? suggestions[r.rule] : undefined
    if (r.status === 'allowed' && rule) {
      this.d.log(`#${job.id}: ${code} allowed with a rule: ${suggestionLabel(rule)}`)
      return permissionDecision({ behavior: 'allow', updatedPermissions: [rule] })
    }
    if (r.status === 'allowed') return permissionDecision({ behavior: 'allow' })
    const message =
      r.status === 'denied'
        ? `The user denied this from their phone.${r.answer ? ` Their note: ${r.answer}` : ''} Don't retry it; take another approach.`
        : "The user is away and didn't approve this in time. Don't retry it; find another way, or skip this step and say so in your final summary."
    return permissionDecision({ behavior: 'deny', message })
  }

  private async onQuestion(job: Job, rt: Runtime, payload: HookPayload): Promise<HookResponse> {
    const config = this.d.config()
    const questions = (Array.isArray(payload.tool_input?.questions) ? payload.tool_input.questions : []) as Question[]
    const code = this.newCode()
    this.d.store.addApproval(code, job.id, 'question', { questions }, this.d.now())
    this.d.notify({ type: 'question', job, code, questions, minutes: Math.round(config.timeouts.questionSec / 60) })
    const r = await this.wait(code, config.timeouts.questionSec)
    rt.lastActivity = this.d.now()
    const reason =
      r.status === 'answered' && r.answer
        ? `The user is away from the keyboard and answered from their phone: ${expandAnswer(r.answer, questions)}`
        : "The user is away and didn't answer. Proceed with your best judgment, pick sensible defaults, and list your assumptions in your final summary."
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }

  private onStop(job: Job, rt: Runtime, payload: HookPayload): HookResponse {
    if (payload.last_assistant_message) this.d.store.updateJob(job.id, { lastMessage: payload.last_assistant_message })
    if (rt.finishing) return {}
    if (job.status === 'held') {
      // Stopped by you: leave it alone. Held for looking stuck: it evidently wasn't.
      if (job.holdReason === 'stopped by you' || job.holdReason === 'conflict') return {}
      job = this.d.store.updateJob(job.id, { status: 'running', holdReason: null })
    }
    rt.retry = undefined

    if (job.plan && !job.planApproved && payload.permission_mode === 'plan') {
      if (rt.plan) return {}
      if (job.nudges < 2) {
        this.d.store.updateJob(job.id, { nudges: job.nudges + 1 })
        return { decision: 'block', reason: NUDGE }
      }
      this.hold(job, 'Claude stopped in plan mode without presenting a plan')
      return {}
    }
    const tasks = this.ownBackground(job, payload.background_tasks ?? [])
    if (tasks.length > 0) {
      // Claude is told when they finish and takes another turn; the next Stop decides.
      rt.background = {
        since: rt.background?.since ?? this.d.now(),
        bounded: !tasks.some(t => FINITE_TASKS.has(String(t.type))),
      }
      return {}
    }
    rt.background = undefined
    // A live link: once the work is done, Claude is asked for one before the task ends.
    if (job.wantLink && !rt.linkAsked && !payload.stop_hook_active) {
      rt.linkAsked = { at: this.d.now(), answer: payload.last_assistant_message ?? job.lastMessage }
      this.d.log(`#${job.id}: asking Claude for a live link`)
      return { decision: 'block', reason: LINK_REQUEST }
    }
    this.beginFinish(job, rt)
    return {}
  }

  /**
   * The background work this task is waiting on. A conversation it continues can carry commands and
   * monitors started before it (a dev server, a watch left running): they'd hold it open until the
   * background timeout, so only the ones it started count. Subagents and workflows always finish.
   */
  private ownBackground(job: Job, tasks: NonNullable<HookPayload['background_tasks']>): NonNullable<HookPayload['background_tasks']> {
    const unsure = tasks.filter(t => !FINITE_TASKS.has(String(t.type)) && t.id)
    if (unsure.length === 0 || !job.transcriptPath) return tasks
    const ours = mentionedSince(job.transcriptPath, taskStart(job), unsure.map(t => t.id!))
    const older = unsure.filter(t => !ours.has(t.id!))
    if (older.length === 0) return tasks
    this.d.log(`#${job.id}: not waiting on ${older.length} background command${older.length === 1 ? '' : 's'} started before it`)
    return tasks.filter(t => !older.includes(t))
  }

  /** The live link Claude made: kept on the task (and on the one it was for), and said. */
  private collectLinks(job: Job, rt: Runtime, said: string): void {
    let links = artifactLinks(said)
    if (links.length === 0 && job.transcriptPath) links = linksInTranscript(job.transcriptPath, rt.linkAsked?.at ?? taskStart(job))
    const note = links.length > 0 ? null : excerpt(said || 'Claude didn’t say why.', 300)
    // The task's answer stays Claude's answer, not its reply about the link.
    const answer = rt.linkAsked?.answer
    let target = this.d.store.updateJob(job.id, { links: links.length ? links : null, linkNote: note, ...(answer ? { lastMessage: answer } : {}) })
    if (job.linkFor !== null) {
      const original = this.d.store.getJob(job.linkFor)
      if (original) target = this.d.store.updateJob(original.id, { links: links.length ? [...(original.links ?? []), ...links] : original.links, linkNote: note })
    }
    this.d.log(`#${target.id}: ${links.length ? `live link ${links[0]!.url}` : 'no live link'}`)
    this.d.notify({ type: 'link', job: target, url: links[0]?.url ?? null, title: links[0]?.title ?? null, note })
  }

  /**
   * A live link for a task, when you ask: at the end of a queued or running one; for one that has
   * ended, now, in a task of its own that continues its conversation (and runs next).
   */
  requestLink(id: number, source = 'remote'): { ok: boolean; text: string; job?: Job } {
    const job = this.d.store.getJob(id)
    if (!job) return { ok: false, text: `No task #${id}.` }
    if (job.status === 'queued' || job.status === 'running' || job.status === 'held') {
      if (job.wantLink) return { ok: true, text: `#${id} already ends with a live link.` }
      this.d.store.updateJob(id, { wantLink: true })
      return { ok: true, text: `#${id} ends with a live link.` }
    }
    if (!job.sessionId) return { ok: false, text: `#${id} has no conversation to make a live link from.` }
    const asked = this.d.store.queued().find(j => j.linkFor === id)
    if (asked) return { ok: true, text: `A live link for #${id} is already queued as #${asked.id}.`, job: asked }
    const linkJob = this.enqueue({
      projectDir: job.projectDir,
      prompt: LINK_TASK,
      plan: false,
      review: false,
      execMode: job.execMode === 'plan' ? 'auto' : job.execMode,
      model: job.workModel ?? job.model,
      effort: job.effort,
      sessionPolicy: 'session',
      sessionId: job.sessionId,
      takeover: true,
      front: true,
      source,
      linkFor: id,
    })
    return { ok: true, text: `A live link for #${id} is next, as #${linkJob.id}.`, job: linkJob }
  }

  private onStopFailure(job: Job, rt: Runtime, payload: HookPayload): HookResponse {
    const now = this.d.now()
    const error = String(payload.error ?? 'unknown')
    const text = [payload.error_details, payload.last_assistant_message].filter(Boolean).join(' · ')
    if (error === 'rate_limit') {
      const pick = pickResetTime(this.limits(), text, now)
      rt.limit = { at: pick.at, window: pick.window, since: now, stage: 0 }
      const due = (pick.at ?? now + 15 * 60_000) + this.d.config().timeouts.limitGraceSec * 1000
      this.d.log(
        `#${job.id}: usage limit (${pick.window ?? 'window unknown'}), resets ${pick.at ? new Date(pick.at).toISOString() : 'at an unknown time'} ` +
          `(from the ${pick.source}); ${BRAND.name} types continue at ${new Date(due).toISOString()} unless Claude Code continues first`,
      )
      this.d.store.updateJob(job.id, { phase: 'limited' })
      this.saveLimits({ ...this.limits(), blockedUntil: pick.at ?? now + 15 * 60_000 })
      if (!this.limitNotified.has(job.id)) {
        this.limitNotified.add(job.id)
        this.d.notify({ type: 'limit', job, at: pick.at, window: pick.window })
      }
      return {}
    }
    if (['overloaded', 'server_error', 'unknown', 'max_output_tokens'].includes(error)) {
      const count = (rt.retry?.count ?? 0) + 1
      if (count > 3) {
        this.hold(job, `Claude keeps stopping with "${error}" errors${text ? `: ${excerpt(text, 200)}` : ''}`)
      } else {
        rt.retry = { at: now + 60_000 * 2 ** (count - 1), count }
      }
      return {}
    }
    this.hold(job, `Claude stopped with "${error}"${text ? `: ${excerpt(text, 200)}` : ''}`)
    return {}
  }

  private onNotification(job: Job, rt: Runtime, payload: HookPayload): HookResponse {
    const now = this.d.now()
    switch (payload.notification_type) {
      case 'quota_auto_resume_fired':
        if (job.phase === 'limited') this.limitCleared(job, rt, 'claude')
        break
      case 'quota_auto_resume_stale':
      case 'quota_auto_resume_disabled':
        // Claude Code won't continue by itself. Act at the reset (or now, if it already passed).
        if (rt.limit && (rt.limit.at === null || now >= rt.limit.at)) rt.limit.force = true
        break
      case 'permission_prompt':
        rt.promptSeenAt = now
        break
      case 'elicitation_dialog':
      case 'elicitation_url_dialog':
        this.hold(job, `an MCP server is asking for input: ${excerpt(payload.message, 200)}`)
        break
    }
    return {}
  }

  onStatusline(jobId: number, payload: { rate_limits?: unknown; context_window?: unknown; cost?: unknown }): string {
    const now = this.d.now()
    if (payload?.rate_limits) {
      this.saveLimits({ ...this.limits(), ...windowsFromStatusline(payload.rate_limits), updatedAt: now })
      this.sampleLimits(now)
    }
    let job = this.d.store.getJob(jobId)
    if (job && (job.status === 'running' || job.status === 'held')) {
      const pct = (payload?.context_window as { used_percentage?: unknown } | undefined)?.used_percentage
      const cost = (payload?.cost as { total_cost_usd?: unknown } | undefined)?.total_cost_usd
      const patch: Partial<Job> = {}
      if (typeof pct === 'number' && Number.isFinite(pct) && Math.round(pct) !== (job.contextPct === null ? null : Math.round(job.contextPct))) patch.contextPct = pct
      if (typeof cost === 'number' && Number.isFinite(cost) && cost !== job.costUsd) patch.costUsd = cost
      if (Object.keys(patch).length > 0) job = this.d.store.updateJob(job.id, patch)
    }
    const five = this.limits().fiveHour?.usedPct
    return [`cq #${jobId}`, job ? modeLabel(job) : null, five !== null && five !== undefined ? `5h ${Math.round(five)}%` : null]
      .filter(Boolean)
      .join(' · ')
  }

  /** Keeps the limits over time (a point when they move a percent, or every 10 minutes), for forecasts. */
  private sampleLimits(now: number): void {
    const l = this.limits()
    const five = l.fiveHour?.usedPct ?? null
    const week = l.sevenDay?.usedPct ?? null
    const last = this.d.store.lastLimitSample()
    const moved = !last || Math.abs((five ?? 0) - (last.fiveHour ?? 0)) >= 1 || Math.abs((week ?? 0) - (last.sevenDay ?? 0)) >= 1
    if (moved || now - last.at >= 600_000) this.d.store.addLimitSample(now, five, week)
  }

  // --- approvals ------------------------------------------------------------------

  private newCode(): string {
    for (;;) {
      let code = ''
      for (let i = 0; i < 5; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)]
      if (!this.d.store.getApproval(code)) return code
    }
  }

  private wait(code: string, timeoutSec: number): Promise<Resolution> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(code)
        this.d.store.resolveApproval(code, 'expired', null, this.d.now())
        resolve({ status: 'expired', answer: null })
      }, timeoutSec * 1000)
      this.waiters.set(code, r => {
        clearTimeout(timer)
        this.waiters.delete(code)
        resolve(r)
      })
    })
  }

  /**
   * Your reply to a 🔐/❓/📝 message. Returns the text to send back. `rule`: allow with that suggestion
   * applied. `mode`: approve a plan and work on in that mode.
   */
  answer(code: string, decision: 'allow' | 'deny' | 'answer', text: string | null, o: { rule?: number; mode?: ExecMode } = {}): string {
    const approval = this.d.store.getApproval(code.toLowerCase())
    if (!approval) return `No request with code ${code}.`
    if (approval.status !== 'pending') return `${code} was already ${approval.status}.`
    if (decision === 'answer' && approval.kind !== 'question') return `${code} needs y or n, not an answer.`
    if (decision !== 'answer' && approval.kind === 'question') return `${code} is a question: reply a ${code} <answer>.`
    const status = decision === 'answer' ? 'answered' : decision === 'allow' ? 'allowed' : 'denied'
    if (status === 'allowed' && o.mode && approval.kind === 'review') this.d.store.updateJob(approval.jobId, { execMode: o.mode })
    this.d.store.resolveApproval(approval.code, status, text, this.d.now())
    this.waiters.get(approval.code)?.({ status, answer: text, ...(status === 'allowed' && o.rule !== undefined ? { rule: o.rule } : {}) })
    const verb = { permission: 'request', question: 'question', review: 'plan', trust: 'folder' }[approval.kind]
    if (status === 'answered') return `Sent your answer to #${approval.jobId}.`
    return `${status === 'allowed' ? '✅ Approved' : '❌ Declined'} #${approval.jobId}'s ${verb}.`
  }

  // --- your controls --------------------------------------------------------------

  async go(): Promise<string> {
    const job = this.d.store.active()
    if (job?.status === 'held') return this.resumeHeld(job)
    if (job?.phase === 'limited') return this.continueNow()
    if (this.paused) {
      this.setPaused(false)
      return job ? 'Queue resumed.' : 'Queue resumed; starting the next job.'
    }
    if (job) return `#${job.id} is already running.`
    return this.d.store.queued().length > 0 ? 'Starting the next job.' : 'Nothing queued.'
  }

  private async resumeHeld(job: Job): Promise<string> {
    // You chose to let it go on past its time limit: the limit is lifted.
    if (job.maxMinutes !== null && job.holdReason?.endsWith('its time limit')) job = this.d.store.updateJob(job.id, { maxMinutes: null })
    const rt = this.runtime(job)
    const pane = await this.d.tmux.pane(rt.window)
    const alive = pane !== null && !pane.dead
    if (job.holdReason === 'conflict') {
      await this.launch({ ...job, status: 'queued' })
      return `Retrying #${job.id}.`
    }
    // A pending plan review: treat "go" as approval.
    const review = this.d.store.pendingApprovals(job.id).find(a => a.kind === 'review')
    if (review) this.d.store.resolveApproval(review.code, 'allowed', null, this.d.now())
    if (alive && rt.sessionStarted) {
      this.d.store.updateJob(job.id, { status: 'running', holdReason: null })
      rt.lastActivity = this.d.now()
      if (rt.plan) {
        rt.plan.attempts = 0
        rt.plan.sentAt = undefined
        if (review) return `Approving #${job.id}'s plan.`
      }
      const busy = job.sessionId ? this.d.sessionHolders(job.sessionId).some(h => h.status === 'busy') : false
      if (!busy && !planDialog(await this.d.tmux.capture(rt.window, 60)).present) {
        await this.typeLine(rt.window, 'continue')
        return `Told #${job.id} to continue.`
      }
      return `Watching #${job.id} again.`
    }
    await this.relaunch(job, job.transcriptPath ? 'continue' : undefined)
    return `Restarted #${job.id}.`
  }

  /**
   * ▶️ Continue now on a usage-limit stop: try right away instead of waiting for the reset
   * (extra usage bought, or a reset time that was wrong). If it's still limited, the wait starts again.
   */
  async continueNow(): Promise<string> {
    const job = this.d.store.active()
    if (job?.phase === 'limited' && job.status === 'running') {
      const rt = this.runtime(job)
      rt.limit ??= { at: this.limits().blockedUntil ?? null, since: this.d.now(), stage: 0 }
      rt.limit.force = true
      if (rt.limit.stage > 0) rt.limit.stage = 0
      this.d.log(`#${job.id}: asked to continue now`)
      return `Trying #${job.id} again now.`
    }
    const until = this.limits().blockedUntil
    if (until && until > this.d.now()) {
      this.saveLimits({ ...this.limits(), blockedUntil: null })
      return "The queue won't wait for the reset any more; the next task starts now."
    }
    return 'Nothing is waiting for a usage limit.'
  }

  async stop(): Promise<string> {
    const job = this.d.store.active()
    if (!job) return 'Nothing is running.'
    if (job.status === 'running') {
      await this.d.tmux.sendKeys(windowName(job.id), 'Escape')
      this.d.store.updateJob(job.id, { status: 'held', holdReason: 'stopped by you' })
    }
    return `Stopped #${job.id}. Reply go to continue it or skip to drop it.`
  }

  /** Skip: the running task ends now (a kill), and the queue moves on. */
  async skip(by?: string): Promise<string> {
    const job = this.d.store.active()
    if (!job) return 'Nothing is running.'
    return this.kill(job.id, { by })
  }

  /**
   * Ends a task now, whatever it's doing: running, paused, waiting for a chat that's open
   * elsewhere, at a usage limit, starting or finishing. Claude and everything it started stop,
   * whatever it waited on from you is settled, and the queue moves on unless `pause`. A queued task
   * just comes off the queue.
   */
  async kill(id: number, o: { by?: string; pause?: boolean } = {}): Promise<string> {
    const job = this.d.store.getJob(id)
    if (!job) return `No task #${id}.`
    if (o.pause) this.setPaused(true)
    const paused = o.pause ? ' The queue is paused.' : ''
    if (job.status === 'queued') {
      this.d.store.updateJob(id, { status: 'cancelled', finishedAt: this.d.now(), error: o.by ? `Removed by ${o.by}` : null })
      return `Removed #${id} from the queue.${paused}`
    }
    if (job.status !== 'running' && job.status !== 'held') return `#${id} has already ${job.status === 'done' ? 'finished' : job.status === 'failed' ? 'failed' : 'ended'}.`
    // The record first: anything still working on this task (a launch, a supervision pass) sees
    // it ended and leaves it alone.
    this.d.store.updateJob(id, { status: 'cancelled', phase: null, holdReason: null, finishedAt: this.d.now(), error: o.by ? `Killed by ${o.by}` : 'Killed' })
    for (const a of this.d.store.pendingApprovals(id)) {
      this.d.store.resolveApproval(a.code, 'expired', null, this.d.now())
      this.waiters.get(a.code)?.({ status: 'expired', answer: null })
    }
    const window = windowName(id)
    const procs = this.d.procs ?? systemProcs
    const pane = await this.d.tmux.pane(window).catch(() => null)
    // Never this engine itself, or init.
    const pids = (pane?.pid ? await procs.tree(pane.pid).catch(() => [pane.pid!]) : []).filter(pid => pid > 1 && pid !== process.pid)
    await this.d.tmux.killWindow(window)
    const forced = await endProcesses(pids, { procs, sleep: this.d.sleep })
    this.d.log(`#${id}: killed${o.by ? ` by ${o.by}` : ''} (${pids.length} process${pids.length === 1 ? '' : 'es'}${forced.length ? `, ${forced.length} needed SIGKILL` : ''})`)
    // Where it left the files and what it used, if that comes quickly.
    const ending = job.launches > 0 ? await Promise.race([this.endState(job), (this.d.sleep ?? Bun.sleep)(3000).then(() => ({}))]) : {}
    const killed = this.d.store.updateJob(id, ending)
    this.runtimes.delete(id)
    this.limitNotified.delete(id)
    // Taken from VS Code: it gets its conversation back.
    if (job.tookFrom === 'claude-vscode' && job.sessionId && this.d.config().reopenInVsCode) this.d.reopenInVsCode?.(job.sessionId)
    this.d.notify({ type: 'killed', job: killed, by: o.by ?? null })
    this.scheduleRepeat(killed)
    const next = this.paused ? null : this.d.store.queued()[0]
    return `Killed #${id}.${paused || (next ? ` Next up: #${next.id}.` : ' Queue empty.')}`
  }

  /** Where the task left the files, and the tokens its conversation used: kept when it ends. */
  private async endState(job: Job): Promise<Partial<Pick<Job, 'endTree' | 'usage' | 'costUsd'>>> {
    const dir = job.launchSpec?.cwd ?? job.workDir ?? job.projectDir
    const ending: Partial<Pick<Job, 'endTree' | 'usage' | 'costUsd'>> = { endTree: job.startTree ? await this.d.git.snapshot(dir) : null }
    if (job.transcriptPath) {
      try {
        const t = readTranscript(job.transcriptPath)
        const since = taskStart(job)
        ending.usage = usageOf(t, since)
        const cost = costOf(t, since)
        if (cost) ending.costUsd = cost.usd
      } catch {
        // The transcript is gone; the task just has no count.
      }
    }
    return ending
  }

  async remove(id: number, by?: string): Promise<string> {
    const job = this.d.store.getJob(id)
    if (!job) return `No job #${id}.`
    if (job.status === 'queued') {
      this.d.store.updateJob(id, { status: 'cancelled', finishedAt: this.d.now() })
      return `Removed #${id}.`
    }
    if (job.status === 'running' || job.status === 'held') return this.kill(id, { by })
    return `#${id} is already ${job.status}.`
  }

  /** Keeps a queued task in its place without starting it (`on`), or lets it start again. */
  holdQueued(id: number, on: boolean): string {
    const job = this.d.store.getJob(id)
    if (!job || job.status !== 'queued') return `#${id} isn't waiting in the queue.`
    this.d.store.updateJob(id, { onHold: on })
    return on ? `#${id} is on hold: it keeps its place and doesn't start.` : `#${id} can start again.`
  }

  /** Puts a task removed in the last ten minutes (that never started) back in its place in the queue. */
  restore(id: number): string {
    const job = this.d.store.getJob(id)
    if (!job) return `No task #${id}.`
    if (job.status === 'queued') return `#${id} is already in the queue.`
    const recent = job.finishedAt !== null && this.d.now() - job.finishedAt <= RESTORE_MS
    if (job.status !== 'cancelled' || job.launches > 0 || !recent) return `#${id} can't go back in the queue: put it in again as a new task.`
    this.d.store.updateJob(id, { status: 'queued', finishedAt: null, error: null })
    return `#${id} is back in the queue.`
  }

  /** Takes every task off the queue (the running one goes on); returns them, so they can be put back. */
  clear(): number[] {
    const now = this.d.now()
    const removed = this.d.store.queued().map(j => j.id)
    for (const id of removed) this.d.store.updateJob(id, { status: 'cancelled', finishedAt: now })
    return removed
  }

  top(id: number): string {
    const job = this.d.store.getJob(id)
    if (!job || job.status !== 'queued') return `#${id} isn't waiting in the queue.`
    this.d.store.moveToFront(id)
    return `#${id} is next.`
  }

  async fork(): Promise<string> {
    const job = this.d.store.active()
    if (!job || job.holdReason !== 'conflict') return 'Nothing is waiting on a busy conversation.'
    this.d.store.updateJob(job.id, { fork: true })
    await this.launch({ ...this.d.store.getJob(job.id)!, status: 'queued' })
    return `#${job.id} continues in a copy of the conversation.`
  }

  /** Takes the conversation the current job waits on over from the window that has it open. */
  async takeover(): Promise<string> {
    const job = this.d.store.active()
    if (!job || job.holdReason !== 'conflict' || !job.sessionId) return 'Nothing is waiting on a conversation that is open somewhere else.'
    const asked = this.d.store.updateJob(job.id, { takeoverAt: this.d.now() })
    const holders = this.d.sessionHolders(job.sessionId)
    const h = holders[0]
    if (h && !canTakeOver(asked, holders)) {
      if (h.status === 'busy') return `#${job.id} takes the conversation over as soon as ${whereLabel(h)} finishes its turn.`
      return `#${job.id} can't close the conversation in ${whereLabel(h)}; close it there, or reply fork to continue in a copy.`
    }
    await this.launch({ ...asked, status: 'queued' })
    const after = this.d.store.getJob(job.id)!
    if (after.status === 'running') return `#${job.id} took the conversation over${h ? ` from ${whereLabel(h)}` : ''}.`
    return `#${job.id} couldn't take the conversation over: it's still open${h ? ` in ${whereLabel(h)}` : ''}.`
  }

  async say(text: string): Promise<string> {
    const job = this.d.store.active()
    if (!job) return 'Nothing is running.'
    const pane = await this.d.tmux.pane(windowName(job.id))
    if (!pane || pane.dead) return `#${job.id} has no live session; reply go to restart it.`
    await this.typeLine(windowName(job.id), text)
    if (job.status === 'held' && job.holdReason !== 'conflict') this.d.store.updateJob(job.id, { status: 'running', holdReason: null })
    const rt = this.runtime(job)
    rt.lastActivity = rt.saidAt = this.d.now()
    return `Typed into #${job.id}.`
  }

  /**
   * Types a message into the running task's chat if it's in the middle of ordinary work: Claude
   * Code queues it until its current step ends. Not while a dialog is up (Enter would pick an
   * option) or while a plan, a limit or the end of the task is being handled. Returns the job id.
   */
  async typeIfFree(sessionId: string, text: string): Promise<number | null> {
    const job = this.d.store.active()
    if (!job || job.sessionId !== sessionId || job.status !== 'running' || job.phase !== 'working') return null
    if (this.d.store.pendingApprovals(job.id).length > 0) return null
    const rt = this.runtimes.get(job.id)
    if (!rt?.sessionStarted || rt.plan || rt.finishing || rt.limit) return null
    const screen = await this.d.tmux.capture(rt.window, 40)
    if (planDialog(screen).present || trustDialog(screen).present || /Do you want|❯\s*1\./.test(screen)) return null
    await this.typeLine(rt.window, text)
    rt.lastActivity = rt.saidAt = this.d.now()
    return job.id
  }

  async keys(keys: string[]): Promise<string> {
    const job = this.d.store.active()
    if (!job) return 'Nothing is running.'
    const pane = await this.d.tmux.pane(windowName(job.id))
    if (!pane || pane.dead) return `#${job.id} has no live session.`
    const names = keys.map(tmuxKeyName)
    for (const key of names) {
      await this.d.tmux.sendKeys(windowName(job.id), key)
      if (key === 'Escape') await Bun.sleep(ESC_SETTLE_MS)
    }
    this.runtime(job).saidAt = this.d.now()
    return `Pressed ${names.join(' ')} in #${job.id}.`
  }

  /** The last `lines` of the running job's screen; `escapes` keeps its colours. */
  async screen(lines: number, escapes = false): Promise<{ jobId: number; text: string } | null> {
    const job = this.d.store.active()
    if (!job) return null
    return { jobId: job.id, text: tail(await this.d.tmux.capture(windowName(job.id), Math.max(lines, 40) + 20, escapes), lines) }
  }

  async peek(lines: number): Promise<string> {
    const s = await this.screen(lines)
    if (!s) return 'Nothing is running.'
    return s.text ? `#${s.jobId}:\n${s.text}` : `#${s.jobId} has nothing on screen.`
  }
}

const KEY_NAMES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  tab: 'Tab',
  'shift-tab': 'BTab',
  btab: 'BTab',
  space: 'Space',
  backspace: 'BSpace',
  'ctrl-c': 'C-c',
  '^c': 'C-c',
}

/** Phone-friendly key words ("esc", "down", "ctrl-c") to tmux key names; anything else is typed as is. */
export function tmuxKeyName(key: string): string {
  return KEY_NAMES[key.toLowerCase()] ?? key
}

function permissionDecision(decision: Record<string, unknown>): HookResponse {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

/** Plan text between "Here is Claude's plan:" and the question, for when the hook didn't carry it. */
export function planFromScreen(screen: string): string | null {
  const m = /Here is Claude's plan:\s*\n([\s\S]*?)\n[^\n]*Would you like to proceed\?/.exec(screen)
  if (!m?.[1]) return null
  const text = m[1]
    .split('\n')
    .filter(l => !/^[\s╌─]+$/.test(l))
    .map(l => l.trim())
    .join('\n')
    .trim()
  return text || null
}

/** Turns "1a 2b" style picks into the option labels Claude offered. Free text passes through. */
/**
 * "b" or "1a 1c 2b" (option letters, with question numbers when there are several; a
 * multi-select question takes several) → what you picked, in words. Anything else is your own answer.
 */
export function expandAnswer(answer: string, questions: Question[]): string {
  const picks = answer.trim().split(/[\s,]+/)
  if (!picks.every(p => /^\d*[a-z]$/i.test(p))) return answer.trim()
  const answers: { picks: number[] }[] = []
  for (const pick of picks) {
    const m = /^(\d*)([a-z])$/i.exec(pick)!
    const qi = m[1] ? Number(m[1]) - 1 : 0
    const oi = m[2]!.toLowerCase().charCodeAt(0) - 97
    if (!questions[qi]?.options?.[oi]) return answer.trim()
    answers[qi] ??= { picks: [] }
    if (!answers[qi]!.picks.includes(oi)) answers[qi]!.picks.push(oi)
  }
  return describeAnswers(questions, answers)
}

function summarizePayload(p: HookPayload): Record<string, unknown> {
  return {
    mode: p.permission_mode,
    tool: p.tool_name,
    type: p.notification_type,
    error: p.error,
    tasks: p.background_tasks?.length,
  }
}
