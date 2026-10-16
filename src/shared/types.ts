/** How Claude works once it may act. `plan` = ask: it stays read-only and just answers (no plan to approve). */
export type ExecMode = 'auto' | 'acceptEdits' | 'bypassPermissions' | 'plan'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type JobStatus = 'queued' | 'running' | 'held' | 'done' | 'failed' | 'cancelled'
export type Phase = 'launching' | 'planning' | 'working' | 'limited' | 'finishing'
export type SessionPolicy = 'continue' | 'new' | 'session'

export interface LaunchSpec {
  cwd: string
  argv: string[]
}

export interface Job {
  id: number
  position: number
  status: JobStatus
  phase: Phase | null
  holdReason: string | null
  projectDir: string
  prompt: string
  /** Start in plan mode; the plan is approved automatically unless `review` is set. */
  plan: boolean
  review: boolean
  execMode: ExecMode
  model: string
  effort: Effort
  sessionPolicy: SessionPolicy
  sessionId: string | null
  fork: boolean
  /**
   * When you asked to take the conversation over from another Claude window (VS Code, a terminal):
   * idle windows that opened it before then are closed so this job can continue it.
   */
  takeoverAt: number | null
  /** The kind of window it took the conversation from (claude-vscode, cli…), to give it back afterwards. */
  tookFrom: string | null
  /** Run on its own git branch in a worktree instead of in your checkout. */
  isolate: boolean
  /** Where Claude actually runs: the worktree (or its matching subfolder), else projectDir. */
  workDir: string | null
  branch: string | null
  launches: number
  launchSpec: LaunchSpec | null
  planText: string | null
  planApproved: boolean
  nudges: number
  startHead: string | null
  lastMessage: string | null
  summary: string | null
  error: string | null
  source: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  lastEventAt: number | null
  transcriptPath: string | null
  /**
   * The folder's files when the task first started and when it ended, as git trees (written to the
   * repo's object store, no ref or index touched), so its diff is exactly its own changes.
   */
  startTree: string | null
  endTree: string | null
  /** From Claude Code's status line: how full the context is (0-100), and the session's cost. */
  contextPct: number | null
  costUsd: number | null
  /** Tokens the conversation used, counted from its transcript when the task ended. */
  usage: Usage | null
  /** Waits in the queue until this time (ms). */
  notBefore: number | null
  /** Waits until that job is done; cancelled if it fails. */
  afterJob: number | null
  /** Queued again every day at this time: minutes after midnight, this machine's time. */
  repeatDaily: number | null
  /** Held when it has worked this long (minutes). */
  maxMinutes: number | null
  /** How long it has worked so far, usage-limit waits aside (ms). */
  activeMs: number
  /** Earlier versions of the plan, oldest first, when Claude revised it. */
  planVersions: { at: number; text: string }[] | null
  /** What became of its own branch: "Merged into main", "Discarded", a pull request's link. */
  branchNote: string | null
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface JobSpec {
  projectDir: string
  prompt: string
  plan: boolean
  review: boolean
  execMode: ExecMode
  model: string
  effort: Effort
  sessionPolicy: SessionPolicy
  sessionId?: string
  isolate?: boolean
  /** Take the conversation over from another Claude window that has it open. */
  takeover?: boolean
  front?: boolean
  source: string
  notBefore?: number | null
  afterJob?: number | null
  repeatDaily?: number | null
  maxMinutes?: number | null
}

export type ApprovalKind = 'permission' | 'question' | 'review' | 'trust'
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'answered' | 'expired'

export interface Approval {
  code: string
  jobId: number
  kind: ApprovalKind
  payload: unknown
  status: ApprovalStatus
  answer: string | null
  createdAt: number
  resolvedAt: number | null
}

/** Plan-limit windows reported by Claude Code's status line (times in ms). */
export interface LimitWindow {
  usedPct: number | null
  resetsAt: number | null
}

export interface LimitState {
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  updatedAt?: number
  /** Set while a job is stopped by a usage limit: no new job starts before this time. */
  blockedUntil?: number | null
}
