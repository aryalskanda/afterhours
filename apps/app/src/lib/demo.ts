// A demo machine inside the app, to try it before Afterhours runs on a computer: a task running, one
// waiting, two finished (with their answers, conversations and changes), and a permission request
// a few seconds in. Nothing runs and nothing leaves the phone; what it can't do, it says.

import type { Activity, ApprovalInfo, Event, JobInfo, MachineStatus, Notice, Result, Snapshot, State, TranscriptItem } from '@afterhours/protocol'
import type { RequestBody } from './hub'

export const DEMO_ID = 'demo'
export const DEMO_RELAY = 'demo:'

type Listeners = {
  event: (e: Event) => void
  state: (s: State) => void
  snapshot: (s: Snapshot) => void
  status: (status: MachineStatus, detail?: string) => void
  activity: (a: Activity) => void
}

const MIN = 60_000

/** A conversation item before it's numbered. */
type Unnumbered = TranscriptItem extends infer T ? (T extends unknown ? Omit<T, 'i'> : never) : never
const FOLDER = '~/code/shop/web'

function demoJob(id: number, now: number, over: Partial<JobInfo>): JobInfo {
  return {
    id,
    status: 'queued',
    phase: null,
    holdReason: null,
    folder: FOLDER,
    workDir: null,
    prompt: '',
    plan: true,
    review: false,
    mode: 'auto',
    model: 'sonnet',
    effort: 'high',
    session: null,
    branch: null,
    isolate: true,
    summary: null,
    error: null,
    source: 'demo',
    position: id,
    createdAt: now - 90 * MIN,
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

const ANSWER = `Done. Dark mode follows the system, with a switch in **Settings → Appearance**.

- Theme store: \`src/theme.ts\`
- Tests: 12 passed

\`\`\`ts
export type Theme = 'light' | 'dark' | 'system'
\`\`\``

const PLAN = `## Plan
1. Add a **theme** store with \`light\`, \`dark\` and \`system\`
2. Put a switch in *Settings → Appearance*
3. Test it in both themes`

const PATCH = `@@ -0,0 +1,9 @@
+export type Theme = 'light' | 'dark' | 'system'
+
+let current: Theme = 'system'
+
+export function setTheme(t: Theme): void {
+  current = t
+}
+
+export const theme = () => current`

const NOT_HERE = 'The demo machine can’t do that. Pair a real one: run cq pair on a computer with Afterhours.'

/** The demo machine, as the hub talks to a real one. */
export class DemoConnection {
  status: MachineStatus = 'connecting'
  private readonly listeners: { [K in keyof Listeners]: Set<Listeners[K]> } = { event: new Set(), state: new Set(), snapshot: new Set(), status: new Set(), activity: new Set() }
  private seq = 0
  private readonly events: Event[] = []
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private readonly start: number
  private active: JobInfo
  private queued: JobInfo[]
  private recent: JobInfo[]
  private approvals: ApprovalInfo[] = []
  private paused = false
  private nextJob = 26

  constructor(private readonly o: { name: string; now?: () => number } = { name: 'Demo machine' }) {
    const now = this.now()
    this.start = now
    this.active = demoJob(24, now, { status: 'running', phase: 'working', prompt: 'Add a dark mode switch to the settings page', startedAt: now - 7 * MIN, branch: 'afterhours/24-dark-mode', contextPct: 31 })
    this.queued = [demoJob(25, now, { prompt: 'Write tests for the checkout total', folder: '~/code/shop/api', plan: false })]
    this.recent = [
      demoJob(23, now, { status: 'done', prompt: 'Add CSV export to the reports page', startedAt: now - 70 * MIN, finishedAt: now - 52 * MIN, summary: 'Added CSV export', costUsd: 0.84, usage: { input: 2_100, output: 9_400, cacheRead: 640_000, cacheWrite: 41_000 }, branch: 'afterhours/23-csv' }),
      demoJob(22, now, { status: 'failed', prompt: 'Upgrade the payment library', startedAt: now - 3 * 60 * MIN, finishedAt: now - 170 * MIN, error: 'The tests failed after the upgrade.' }),
    ]
    // Connected a moment later, as a real machine would be; then something needs you.
    this.later(300, () => {
      this.setStatus('connected')
      this.emit('snapshot', this.snapshot())
    })
    this.later(4000, () => this.askPermission())
  }

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  private later(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, ms))
  }

  private emit<K extends keyof Listeners>(type: K, ...args: Parameters<Listeners[K]>): void {
    for (const l of this.listeners[type]) (l as (...a: Parameters<Listeners[K]>) => void)(...args)
  }

  private setStatus(status: MachineStatus): void {
    this.status = status
    this.emit('status', status)
  }

  on<K extends keyof Listeners>(type: K, listener: Listeners[K]): () => void {
    this.listeners[type].add(listener)
    return () => this.listeners[type].delete(listener)
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t)
    this.listeners.status.clear()
    this.status = 'offline'
  }

  private notice(notice: Notice, text: string): void {
    const e: Event = { type: 'event', seq: ++this.seq, at: this.now(), notice, text }
    this.events.push(e)
    this.emit('event', e)
  }

  private askPermission(): void {
    const at = this.now()
    const approval: ApprovalInfo = { code: 'demo1', job: this.active.id, kind: 'permission', tool: 'Bash', detail: 'npm test -- --watch=false', payload: null, createdAt: at, expiresAt: at + 15 * MIN, allowedBefore: 3 }
    this.approvals = [approval]
    this.notice({ type: 'permission', job: this.active, code: 'demo1', tool: 'Bash', detail: 'npm test -- --watch=false', minutes: 15 }, `#${this.active.id} wants to use Bash: npm test -- --watch=false`)
  }

  private snapshot(): Snapshot {
    const now = this.now()
    return {
      type: 'snapshot',
      seq: this.seq,
      machine: { id: DEMO_ID, name: this.o.name, os: 'Demo', arch: '', version: 'demo', protocol: 1 },
      role: 'owner',
      paused: this.paused,
      active: this.active,
      queued: this.queued,
      recent: this.recent,
      approvals: this.approvals,
      limits: { fiveHour: { usedPct: 34, resetsAt: now + 3 * 60 * MIN }, sevenDay: { usedPct: 12, resetsAt: now + 4 * 24 * 60 * MIN }, blockedUntil: null },
      policy: { allowedRoots: ['~/code'], allowBypass: false, allowScreens: true, allowTyping: true },
      defaults: { plan: true, review: false, mode: 'auto', model: 'sonnet', effort: 'high', isolate: true },
      models: ['opus', 'sonnet', 'haiku'],
      features: ['transcript', 'timeline', 'diff', 'activity', 'queue.edit', 'history', 'limits.history'],
    }
  }

  private state(): void {
    this.emit('state', { type: 'state', paused: this.paused, active: this.active, queued: this.queued, limits: this.snapshot().limits })
  }

  private job(id: number): JobInfo | null {
    return [this.active, ...this.queued, ...this.recent].find(j => j.id === id) ?? null
  }

  private transcript(j: JobInfo): TranscriptItem[] {
    const at = j.startedAt ?? this.start
    const items: Unnumbered[] = [
      { kind: 'you', at, text: j.prompt },
      { kind: 'claude', at: at + 20_000, text: 'I’ll look at how the settings page is built first.' },
      { kind: 'tool', at: at + 30_000, id: 't1', name: 'Read', detail: 'src/settings/index.tsx', result: 'export function Settings() {', error: false },
      { kind: 'tool', at: at + 90_000, id: 't2', name: 'Write', detail: 'src/theme.ts', result: 'File created', error: false },
      ...(j.status === 'done' ? [{ kind: 'claude' as const, at: (j.finishedAt ?? at) - 1000, text: ANSWER }] : []),
    ]
    return items.map((x, i) => ({ ...x, i }) as TranscriptItem)
  }

  /** Answers like a machine would, from what the demo knows. */
  async request(body: RequestBody, _o: { timeoutMs?: number } = {}): Promise<Result> {
    const ok = (data?: unknown, text?: string): Result => ({ type: 'result', id: 'demo', ok: true, ...(data !== undefined ? { data } : {}), ...(text ? { text } : {}) })
    const no = (error: string, code = 'invalid'): Result => ({ type: 'result', id: 'demo', ok: false, code, error })
    switch (body.type) {
      case 'sync':
        return ok()
      case 'snapshot':
        return ok(this.snapshot())
      case 'jobs':
        return ok({ active: this.active, queued: this.queued, recent: this.recent.filter(j => !body.status || j.status === body.status), more: false })
      case 'task': {
        const j = this.job(body.job)
        if (!j) return no(`No task #${body.job}.`, 'not-found')
        return ok({ job: j, plan: PLAN, answer: j.status === 'done' ? ANSWER : null })
      }
      case 'transcript': {
        const j = body.job !== undefined ? this.job(body.job) : null
        if (!j) return no('No conversation here.', 'not-found')
        const items = this.transcript(j)
        return ok({ session: `demo-${j.id}`, items, before: null, total: items.length, usage: j.usage ?? { input: 900, output: 3_200, cacheRead: 120_000, cacheWrite: 9_000 }, cost: null, updatedAt: this.now() })
      }
      case 'timeline':
        return ok({ events: this.events.filter(e => 'job' in e.notice && typeof e.notice.job === 'object' && e.notice.job?.id === body.job) })
      case 'diff': {
        const j = this.job(body.job)
        if (!j || j.status === 'queued') return no('Nothing changed yet.', 'not-found')
        if (body.file) return ok({ path: body.file, patch: PATCH, binary: false, truncated: false })
        return ok({ dir: FOLDER, branch: j.branch, basis: 'exact', files: [{ path: 'src/theme.ts', status: 'added', added: 9, removed: 0, binary: false }], truncated: false })
      }
      case 'peek':
        return ok({ job: this.active.id, text: '⏺ Write(src/theme.ts)\n  ⎿  Wrote 9 lines\n\n✻ Working… (7m · esc to interrupt)' })
      case 'answer': {
        const a = this.approvals.find(x => x.code === body.code)
        if (!a) return no(`${body.code} was already answered.`, 'gone')
        this.approvals = []
        const status = body.decision === 'deny' ? 'denied' : 'allowed'
        this.later(200, () => this.notice({ type: 'resolved', code: a.code, job: a.job, status, by: 'this device' }, `#${a.job}'s request was ${status}.`))
        return ok(undefined, body.decision === 'deny' ? `Denied #${a.job}'s request.` : `Allowed #${a.job}'s request. (In the demo nothing runs.)`)
      }
      case 'queue': {
        const j = demoJob(this.nextJob++, this.now(), { prompt: body.prompt, folder: body.folder, createdAt: this.now(), model: body.options?.model ?? 'sonnet' })
        this.queued = [...this.queued, j]
        this.state()
        return ok({ job: j }, `Queued #${j.id}. In the demo it waits forever.`)
      }
      case 'job': {
        if (!this.queued.some(j => j.id === body.job)) return no(`#${body.job} isn’t waiting in the queue.`, 'gone')
        if (body.action === 'remove') this.queued = this.queued.filter(j => j.id !== body.job)
        else if (body.action === 'top') this.queued = [...this.queued.filter(j => j.id === body.job), ...this.queued.filter(j => j.id !== body.job)]
        else if (body.action === 'edit' && body.prompt) this.queued = this.queued.map(j => (j.id === body.job ? { ...j, prompt: body.prompt! } : j))
        this.state()
        return ok(undefined, 'Done.')
      }
      case 'control':
        if (body.action === 'pause' || body.action === 'go') {
          this.paused = body.action === 'pause'
          this.state()
          return ok(undefined, this.paused ? 'Paused.' : 'Going.')
        }
        return no(NOT_HERE)
      case 'folders':
        return ok([{ path: FOLDER, name: 'web', isRepo: true }, { path: '~/code/shop/api', name: 'api', isRepo: true }])
      case 'chats':
        return ok({ chats: [], more: false })
      case 'limits.history': {
        const now = this.now()
        return ok({ samples: Array.from({ length: 12 }, (_, i) => ({ at: now - (60 - i * 5) * MIN, fiveHour: 10 + i * 2, sevenDay: 12 })) })
      }
      default:
        return no(NOT_HERE)
    }
  }
}
