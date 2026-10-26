import { Database } from 'bun:sqlite'
import type { Approval, ApprovalKind, ApprovalStatus, Job, JobSpec, JobStatus } from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position REAL NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  hold_reason TEXT,
  project_dir TEXT NOT NULL,
  prompt TEXT NOT NULL,
  plan INTEGER NOT NULL,
  review INTEGER NOT NULL,
  exec_mode TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  session_policy TEXT NOT NULL,
  session_id TEXT,
  fork INTEGER NOT NULL DEFAULT 0,
  takeover_at INTEGER,
  took_from TEXT,
  isolate INTEGER NOT NULL DEFAULT 0,
  work_dir TEXT,
  branch TEXT,
  launches INTEGER NOT NULL DEFAULT 0,
  launch_spec TEXT,
  plan_text TEXT,
  plan_approved INTEGER NOT NULL DEFAULT 0,
  nudges INTEGER NOT NULL DEFAULT 0,
  start_head TEXT,
  last_message TEXT,
  summary TEXT,
  error TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  last_event_at INTEGER,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, position);
CREATE TABLE IF NOT EXISTS threads (
  project_dir TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  work_dir TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  code TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS limit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  five_hour REAL,
  seven_day REAL
);
CREATE INDEX IF NOT EXISTS limit_samples_at ON limit_samples (at);
CREATE TABLE IF NOT EXISTS watches (
  session_id TEXT PRIMARY KEY,
  cwd TEXT,
  title TEXT NOT NULL,
  where_label TEXT NOT NULL,
  stop_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  sent_at INTEGER,
  job_id INTEGER,
  updated_at INTEGER NOT NULL
);
`

/**
 * One of your other chats (VS Code, a terminal) that stopped on a usage limit and is to be continued
 * at the reset. waiting → sent (continue posted to its inbox) → done; or handed (a job continues it);
 * or cancelled (you said don't, or it went away).
 */
export interface Watch {
  sessionId: string
  cwd: string | null
  title: string
  where: string
  stopAt: number
  dueAt: number
  state: 'waiting' | 'sent' | 'done' | 'handed' | 'cancelled'
  sentAt: number | null
  jobId: number | null
  updatedAt: number
}

const COLUMNS = {
  id: 'id',
  position: 'position',
  status: 'status',
  phase: 'phase',
  holdReason: 'hold_reason',
  projectDir: 'project_dir',
  prompt: 'prompt',
  plan: 'plan',
  review: 'review',
  execMode: 'exec_mode',
  model: 'model',
  effort: 'effort',
  sessionPolicy: 'session_policy',
  sessionId: 'session_id',
  fork: 'fork',
  takeoverAt: 'takeover_at',
  tookFrom: 'took_from',
  isolate: 'isolate',
  workDir: 'work_dir',
  branch: 'branch',
  launches: 'launches',
  launchSpec: 'launch_spec',
  planText: 'plan_text',
  planApproved: 'plan_approved',
  nudges: 'nudges',
  startHead: 'start_head',
  lastMessage: 'last_message',
  summary: 'summary',
  error: 'error',
  source: 'source',
  createdAt: 'created_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  lastEventAt: 'last_event_at',
  transcriptPath: 'transcript_path',
  startTree: 'start_tree',
  endTree: 'end_tree',
  contextPct: 'context_pct',
  costUsd: 'cost_usd',
  usage: 'usage',
  notBefore: 'not_before',
  afterJob: 'after_job',
  repeatDaily: 'repeat_daily',
  maxMinutes: 'max_minutes',
  activeMs: 'active_ms',
  planVersions: 'plan_versions',
  branchNote: 'branch_note',
  attachments: 'attachments',
  group: 'job_group',
  onHold: 'on_hold',
  workModel: 'work_model',
  workEffort: 'work_effort',
  wantLink: 'want_link',
  links: 'links',
  linkNote: 'link_note',
  linkFor: 'link_for',
} as const satisfies Record<keyof Job, string>

const BOOLEAN_FIELDS = new Set<keyof Job>(['plan', 'review', 'fork', 'isolate', 'planApproved', 'onHold', 'wantLink'])

/** Columns added after the first release, for databases created before them. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ['jobs', 'isolate', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'work_dir', 'TEXT'],
  ['jobs', 'branch', 'TEXT'],
  ['threads', 'work_dir', 'TEXT'],
  ['jobs', 'takeover_at', 'INTEGER'],
  ['jobs', 'took_from', 'TEXT'],
  ['jobs', 'start_tree', 'TEXT'],
  ['jobs', 'end_tree', 'TEXT'],
  ['jobs', 'context_pct', 'REAL'],
  ['jobs', 'cost_usd', 'REAL'],
  ['jobs', 'usage', 'TEXT'],
  ['jobs', 'not_before', 'INTEGER'],
  ['jobs', 'after_job', 'INTEGER'],
  ['jobs', 'repeat_daily', 'INTEGER'],
  ['jobs', 'max_minutes', 'INTEGER'],
  ['jobs', 'active_ms', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'plan_versions', 'TEXT'],
  ['jobs', 'branch_note', 'TEXT'],
  ['jobs', 'attachments', 'TEXT'],
  ['jobs', 'job_group', 'TEXT'],
  ['jobs', 'on_hold', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'work_model', 'TEXT'],
  ['jobs', 'work_effort', 'TEXT'],
  ['jobs', 'want_link', 'INTEGER NOT NULL DEFAULT 0'],
  ['jobs', 'links', 'TEXT'],
  ['jobs', 'link_note', 'TEXT'],
  ['jobs', 'link_for', 'INTEGER'],
]
const JSON_FIELDS = new Set<keyof Job>(['launchSpec', 'usage', 'planVersions', 'attachments', 'links'])

type Row = Record<string, string | number | null>
type SqlValue = string | number | null

function encode(key: keyof Job, value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (BOOLEAN_FIELDS.has(key)) return value ? 1 : 0
  if (JSON_FIELDS.has(key)) return JSON.stringify(value)
  return value as SqlValue
}

function toJob(row: Row): Job {
  const job = {} as Record<string, unknown>
  for (const [key, column] of Object.entries(COLUMNS) as [keyof Job, string][]) {
    const value = row[column] ?? null
    if (BOOLEAN_FIELDS.has(key)) job[key] = value === 1
    else if (JSON_FIELDS.has(key)) job[key] = typeof value === 'string' ? JSON.parse(value) : null
    else job[key] = value
  }
  return job as unknown as Job
}

/** Live work: at most one job is running or held at a time. */
export const ACTIVE_STATUSES: JobStatus[] = ['running', 'held']

export class Store {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 3000;')
    this.db.exec(SCHEMA)
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const has = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  close(): void {
    this.db.close()
  }

  // --- jobs -----------------------------------------------------------------

  addJob(spec: JobSpec, now: number): Job {
    const edge = this.db
      .query<{ lo: number | null; hi: number | null }, []>(
        `SELECT MIN(position) AS lo, MAX(position) AS hi FROM jobs WHERE status = 'queued'`,
      )
      .get()
    let position = spec.front ? (edge?.lo ?? 1) - 1 : (edge?.hi ?? 0) + 1
    // At the front, but after what's already queued for the same conversation, so messages you
    // type into one chat run in the order you sent them.
    const same = spec.front && spec.sessionId ? this.lastQueuedPosition(spec.sessionId) : null
    if (same !== null) {
      const next = this.db
        .query<{ p: number | null }, [number]>(`SELECT MIN(position) AS p FROM jobs WHERE status = 'queued' AND position > ?`)
        .get(same)?.p
      position = next === null || next === undefined ? same + 1 : (same + next) / 2
    }
    const row = this.db
      .query<Row, SqlValue[]>(
        `INSERT INTO jobs (position, status, project_dir, prompt, plan, review, exec_mode, model, effort,
                           session_policy, session_id, takeover_at, isolate, source, created_at,
                           not_before, after_job, repeat_daily, max_minutes, attachments, job_group, work_model,
                           work_effort, want_link, link_for)
         VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        position,
        spec.projectDir,
        spec.prompt,
        spec.plan ? 1 : 0,
        spec.review ? 1 : 0,
        spec.execMode,
        spec.model,
        spec.effort,
        spec.sessionPolicy,
        spec.sessionId ?? null,
        spec.takeover ? now : null,
        spec.isolate ? 1 : 0,
        spec.source,
        now,
        spec.notBefore ?? null,
        spec.afterJob ?? null,
        spec.repeatDaily ?? null,
        spec.maxMinutes ?? null,
        spec.attachments?.length ? JSON.stringify(spec.attachments) : null,
        spec.group ?? null,
        // Only with a plan, and only when it's another model.
        spec.plan && spec.workModel && spec.workModel !== spec.model ? spec.workModel : null,
        // Only with a plan, and only when it's another effort.
        spec.plan && spec.workEffort && spec.workEffort !== spec.effort ? spec.workEffort : null,
        spec.wantLink ? 1 : 0,
        spec.linkFor ?? null,
      )
    if (!row) throw new Error('failed to insert job')
    return toJob(row)
  }

  private lastQueuedPosition(sessionId: string): number | null {
    return (
      this.db
        .query<{ p: number | null }, [string]>(`SELECT MAX(position) AS p FROM jobs WHERE status = 'queued' AND session_id = ?`)
        .get(sessionId)?.p ?? null
    )
  }

  getJob(id: number): Job | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? toJob(row) : null
  }

  updateJob(id: number, patch: Partial<Job>): Job {
    const keys = (Object.keys(patch) as (keyof Job)[]).filter(k => k !== 'id')
    if (keys.length > 0) {
      const sets = keys.map(k => `${COLUMNS[k]} = ?`).join(', ')
      const values = keys.map(k => encode(k, patch[k]))
      this.db.query<Row, SqlValue[]>(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...values, id)
    }
    const job = this.getJob(id)
    if (!job) throw new Error(`job #${id} not found`)
    return job
  }

  queued(): Job[] {
    return this.db
      .query<Row, []>(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY position, id`)
      .all()
      .map(toJob)
  }

  active(): Job | null {
    const row = this.db
      .query<Row, []>(`SELECT * FROM jobs WHERE status IN ('running', 'held') ORDER BY id LIMIT 1`)
      .get()
    return row ? toJob(row) : null
  }

  recentFinished(limit: number): Job[] {
    return this.db
      .query<Row, [number]>(
        `SELECT * FROM jobs WHERE status IN ('done', 'failed', 'cancelled') ORDER BY finished_at DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map(toJob)
  }

  /**
   * Finished jobs, newest first: before job `before`, with `status`, whose prompt or final answer
   * has every word of `query`. One more than `limit` tells there are more.
   */
  searchFinished(o: { before?: number; status?: 'done' | 'failed' | 'cancelled'; query?: string; folder?: string; limit: number }): Job[] {
    const where = [o.status ? 'status = ?' : "status IN ('done', 'failed', 'cancelled')"]
    const args: SqlValue[] = o.status ? [o.status] : []
    if (o.folder !== undefined) {
      where.push('project_dir = ?')
      args.push(o.folder)
    }
    if (o.before !== undefined) {
      where.push('id < ?')
      args.push(o.before)
    }
    for (const word of (o.query ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("(prompt LIKE ? ESCAPE '\\' OR last_message LIKE ? ESCAPE '\\')")
      const like = `%${word.replace(/[\\%_]/g, c => `\\${c}`)}%`
      args.push(like, like)
    }
    return this.db
      .query<Row, SqlValue[]>(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args, o.limit)
      .map(toJob)
  }

  // --- usage limits over time ------------------------------------------------

  addLimitSample(at: number, fiveHour: number | null, sevenDay: number | null): void {
    this.db.query('INSERT INTO limit_samples (at, five_hour, seven_day) VALUES (?, ?, ?)').run(at, fiveHour, sevenDay)
  }

  lastLimitSample(): { at: number; fiveHour: number | null; sevenDay: number | null } | null {
    const r = this.db.query<{ at: number; five_hour: number | null; seven_day: number | null }, []>('SELECT at, five_hour, seven_day FROM limit_samples ORDER BY id DESC LIMIT 1').get()
    return r ? { at: r.at, fiveHour: r.five_hour, sevenDay: r.seven_day } : null
  }

  limitSamples(since: number): { at: number; fiveHour: number | null; sevenDay: number | null }[] {
    return this.db
      .query<{ at: number; five_hour: number | null; seven_day: number | null }, [number]>('SELECT at, five_hour, seven_day FROM limit_samples WHERE at >= ? ORDER BY id')
      .all(since)
      .map(r => ({ at: r.at, fiveHour: r.five_hour, sevenDay: r.seven_day }))
  }

  pruneLimitSamples(olderThan: number): void {
    this.db.query('DELETE FROM limit_samples WHERE at < ?').run(olderThan)
  }

  /** A waiting or running job that continues this conversation. */
  pendingForSession(sessionId: string): Job | null {
    const row = this.db
      .query<Row, [string]>(`SELECT * FROM jobs WHERE session_id = ? AND status IN ('queued', 'running', 'held') ORDER BY id LIMIT 1`)
      .get(sessionId)
    return row ? toJob(row) : null
  }

  /** Folders jobs ran in, most recent first. */
  recentFolders(limit: number): string[] {
    return this.db
      .query<{ project_dir: string }, [number]>(
        'SELECT project_dir FROM jobs GROUP BY project_dir ORDER BY MAX(created_at) DESC LIMIT ?',
      )
      .all(limit)
      .map(r => r.project_dir)
  }

  lastJob(): Job | null {
    const row = this.db.query<Row, []>('SELECT * FROM jobs ORDER BY id DESC LIMIT 1').get()
    return row ? toJob(row) : null
  }

  /** Puts a queued job at place `index` (0 = next), renumbering the queue. */
  moveTo(id: number, index: number): void {
    const queue = this.queued().filter(j => j.id !== id)
    const job = this.getJob(id)
    if (!job || job.status !== 'queued') return
    queue.splice(Math.max(0, Math.min(index, queue.length)), 0, job)
    const set = this.db.query<Row, [number, number]>('UPDATE jobs SET position = ? WHERE id = ?')
    this.db.transaction(() => queue.forEach((j, i) => set.run(i + 1, j.id)))()
  }

  moveToFront(id: number): void {
    const lo = this.db
      .query<{ lo: number | null }, []>(`SELECT MIN(position) AS lo FROM jobs WHERE status = 'queued'`)
      .get()?.lo
    this.db.query<Row, [number, number]>('UPDATE jobs SET position = ? WHERE id = ?').run((lo ?? 1) - 1, id)
  }

  // --- threads (the conversation a project continues by default) -------------

  /** The conversation a folder continues by default, and the worktree it lives in (if any). */
  getThread(projectDir: string): { sessionId: string; workDir: string | null } | null {
    const row = this.db
      .query<{ session_id: string; work_dir: string | null }, [string]>(
        'SELECT session_id, work_dir FROM threads WHERE project_dir = ?',
      )
      .get(projectDir)
    return row ? { sessionId: row.session_id, workDir: row.work_dir } : null
  }

  setThread(projectDir: string, sessionId: string, now: number, workDir: string | null = null): void {
    this.db
      .query<Row, [string, string, string | null, number]>(
        `INSERT INTO threads (project_dir, session_id, work_dir, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_dir) DO UPDATE SET session_id = excluded.session_id, work_dir = excluded.work_dir,
           updated_at = excluded.updated_at`,
      )
      .run(projectDir, sessionId, workDir, now)
  }

  /** The worktree and branch a conversation runs in, from the latest job that ran it there. */
  sessionWorktree(sessionId: string): { workDir: string; branch: string | null } | null {
    const row = this.db
      .query<{ work_dir: string; branch: string | null }, [string]>(
        'SELECT work_dir, branch FROM jobs WHERE session_id = ? AND work_dir IS NOT NULL ORDER BY id DESC LIMIT 1',
      )
      .get(sessionId)
    return row ? { workDir: row.work_dir, branch: row.branch } : null
  }

  /** Worktrees this folder's jobs ran in: their conversations are kept under the worktree's path. */
  /** Each folder tasks ran in since `since`: how many, and when one last moved. */
  folderActivity(since: number): { folder: string; tasks: number; lastAt: number }[] {
    return this.db
      .query<{ project_dir: string; n: number; last: number }, [number]>(
        'SELECT project_dir, COUNT(*) AS n, MAX(COALESCE(finished_at, started_at, created_at)) AS last FROM jobs WHERE created_at >= ? GROUP BY project_dir',
      )
      .all(since)
      .map(r => ({ folder: r.project_dir, tasks: r.n, lastAt: r.last }))
  }

  /** Every task's own-branch worktree, and the folder it belongs to. */
  worktrees(): Map<string, string> {
    const rows = this.db.query<{ work_dir: string; project_dir: string }, []>('SELECT DISTINCT work_dir, project_dir FROM jobs WHERE work_dir IS NOT NULL').all()
    return new Map(rows.map(r => [r.work_dir, r.project_dir]))
  }

  worktreeDirs(projectDir: string): string[] {
    return this.db
      .query<{ work_dir: string }, [string]>('SELECT DISTINCT work_dir FROM jobs WHERE project_dir = ? AND work_dir IS NOT NULL')
      .all(projectDir)
      .map(r => r.work_dir)
  }

  // --- watches (your other chats waiting for a usage-limit reset) ----------------

  private toWatch(r: Row): Watch {
    return {
      sessionId: r.session_id as string,
      cwd: (r.cwd as string | null) ?? null,
      title: r.title as string,
      where: r.where_label as string,
      stopAt: r.stop_at as number,
      dueAt: r.due_at as number,
      state: r.state as Watch['state'],
      sentAt: (r.sent_at as number | null) ?? null,
      jobId: (r.job_id as number | null) ?? null,
      updatedAt: r.updated_at as number,
    }
  }

  putWatch(w: Watch): void {
    this.db
      .query<Row, SqlValue[]>(
        `INSERT INTO watches (session_id, cwd, title, where_label, stop_at, due_at, state, sent_at, job_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET cwd = excluded.cwd, title = excluded.title, where_label = excluded.where_label,
           stop_at = excluded.stop_at, due_at = excluded.due_at, state = excluded.state, sent_at = excluded.sent_at,
           job_id = excluded.job_id, updated_at = excluded.updated_at`,
      )
      .run(w.sessionId, w.cwd, w.title, w.where, w.stopAt, w.dueAt, w.state, w.sentAt, w.jobId, w.updatedAt)
  }

  getWatch(sessionId: string): Watch | null {
    const row = this.db.query<Row, [string]>('SELECT * FROM watches WHERE session_id = ?').get(sessionId)
    return row ? this.toWatch(row) : null
  }

  /** Chats still to be continued: waiting for their reset, or sent continue and not yet seen running. */
  openWatches(): Watch[] {
    return this.db
      .query<Row, []>(`SELECT * FROM watches WHERE state IN ('waiting', 'sent') ORDER BY due_at`)
      .all()
      .map(r => this.toWatch(r))
  }

  setWatchState(sessionId: string, state: Watch['state'], now: number, patch: { sentAt?: number; jobId?: number } = {}): void {
    this.db
      .query<Row, SqlValue[]>(
        'UPDATE watches SET state = ?, sent_at = COALESCE(?, sent_at), job_id = COALESCE(?, job_id), updated_at = ? WHERE session_id = ?',
      )
      .run(state, patch.sentAt ?? null, patch.jobId ?? null, now, sessionId)
  }

  pruneWatches(olderThan: number): void {
    this.db.query<Row, [number]>(`DELETE FROM watches WHERE state NOT IN ('waiting', 'sent') AND updated_at < ?`).run(olderThan)
  }

  // --- events -----------------------------------------------------------------

  logEvent(jobId: number | null, type: string, data: unknown, now: number): void {
    this.db
      .query<Row, [number | null, number, string, string | null]>(
        'INSERT INTO events (job_id, ts, type, data) VALUES (?, ?, ?, ?)',
      )
      .run(jobId, now, type, data === undefined ? null : JSON.stringify(data))
  }

  pruneEvents(olderThan: number): void {
    this.db.query<Row, [number]>('DELETE FROM events WHERE ts < ?').run(olderThan)
  }

  // --- approvals ----------------------------------------------------------------

  addApproval(code: string, jobId: number, kind: ApprovalKind, payload: unknown, now: number): Approval {
    this.db
      .query<Row, [string, number, string, string, number]>(
        `INSERT INTO approvals (code, job_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(code, jobId, kind, JSON.stringify(payload ?? null), now)
    return this.getApproval(code)!
  }

  /** How many times a permission with this same tool and detail was allowed (the last 1000 asked). */
  countAllowed(tool: string, detail: string, describe: (tool: string, input: unknown) => string): number {
    const rows = this.db
      .query<{ payload: string | null }, []>(`SELECT payload FROM approvals WHERE kind = 'permission' AND status = 'allowed' ORDER BY created_at DESC LIMIT 1000`)
      .all()
    let n = 0
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload ?? '{}') as { tool?: string; input?: unknown }
        if (p.tool === tool && describe(tool, p.input) === detail) n++
      } catch {
        // An unreadable payload counts for nothing.
      }
    }
    return n
  }

  getApproval(code: string): Approval | null {
    const row = this.db.query<Row, [string]>('SELECT * FROM approvals WHERE code = ?').get(code)
    if (!row) return null
    return {
      code: row.code as string,
      jobId: row.job_id as number,
      kind: row.kind as ApprovalKind,
      payload: row.payload ? JSON.parse(row.payload as string) : null,
      status: row.status as ApprovalStatus,
      answer: (row.answer as string | null) ?? null,
      createdAt: row.created_at as number,
      resolvedAt: (row.resolved_at as number | null) ?? null,
    }
  }

  resolveApproval(code: string, status: ApprovalStatus, answer: string | null, now: number): void {
    this.db
      .query<Row, [string, string | null, number, string]>(
        'UPDATE approvals SET status = ?, answer = ?, resolved_at = ? WHERE code = ?',
      )
      .run(status, answer, now, code)
  }

  pendingApprovals(jobId?: number): Approval[] {
    const rows =
      jobId === undefined
        ? this.db.query<{ code: string }, []>(`SELECT code FROM approvals WHERE status = 'pending' ORDER BY created_at`).all()
        : this.db
            .query<{ code: string }, [number]>(
              `SELECT code FROM approvals WHERE status = 'pending' AND job_id = ? ORDER BY created_at`,
            )
            .all(jobId)
    return rows.map(r => this.getApproval(r.code)!)
  }

  expirePendingApprovals(now: number): void {
    this.db.query<Row, [number]>(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'`).run(now)
  }

  // --- key/value state --------------------------------------------------------------

  kvGet<T>(key: string): T | undefined {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  kvSet(key: string, value: unknown): void {
    this.db
      .query<Row, [string, string]>(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }
}
