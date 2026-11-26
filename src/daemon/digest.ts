// The daily "Today" digest: one short message each evening (Telegram, and a card in the apps) with
// what finished and failed, what waits on you, the pull requests tasks opened that are still open,
// and how much of the usage limits is left. Built fresh whenever it's asked for.

import type { Digest, DigestPr, DigestTask } from '@afterhours/protocol'
import type { Approval, Job, LimitState, LimitWindow } from '../shared/types'
import { formatClock } from './limits'
import { oneLine } from './format'
import { openPrs, prLinks, type Gh } from './prs'
import type { Runner } from './runner'
import type { Store } from './store'

/** How many of each kind are listed; the counts say how many there are. */
export const DIGEST_SHOWN = 5
/** Pull request links are looked for in tasks that ended this recently. */
export const PR_LOOKBACK_MS = 14 * 86_400_000
/** A first digest (or one after a long time off) covers at most this much. */
const MAX_SPAN_MS = 7 * 86_400_000

const APPROVAL_WORDS: Record<Approval['kind'], string> = {
  permission: 'wants a permission',
  question: 'asks you a question',
  review: 'plan to review',
  trust: 'asks to trust its folder',
}

export interface DigestInput {
  now: number
  since: number
  /** Ended tasks (done, failed, cancelled), any order. */
  finished: Job[]
  /** Tasks running or held now. */
  current: Job[]
  approvals: Approval[]
  limits: LimitState
  prs: DigestPr[]
  prsNote: string | null
  label: (dir: string) => string
}

const task = (j: Job, label: (dir: string) => string, detail: string | null, code?: string): DigestTask => ({
  job: j.id,
  folder: label(j.projectDir),
  prompt: oneLine(j.prompt, 80),
  detail: detail ? oneLine(detail, 120) : null,
  ...(code ? { code } : {}),
})

const left = (w: LimitWindow | undefined, now: number) =>
  w && w.usedPct !== null ? { left: Math.max(0, Math.round(100 - w.usedPct)), resetsAt: w.resetsAt && w.resetsAt > now ? w.resetsAt : null } : null

/** The digest from what the queue knows. */
export function buildDigest(o: DigestInput): Digest {
  const since = Math.max(o.since, o.now - MAX_SPAN_MS)
  const ended = o.finished.filter(j => (j.finishedAt ?? 0) >= since).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  const done = ended.filter(j => j.status === 'done')
  // Paused because something went wrong (it can be retried), or ended failed.
  const broken = [
    ...o.current.filter(j => j.status === 'held' && j.error),
    ...ended.filter(j => j.status === 'failed'),
  ]
  const asked = new Map<number, Approval>()
  for (const a of o.approvals) if (!asked.has(a.jobId)) asked.set(a.jobId, a)
  const waitingJobs = o.current.filter(j => asked.has(j.id) || (j.status === 'held' && !j.error))
  const waiting = waitingJobs.map(j => {
    const a = asked.get(j.id)
    return task(j, o.label, a ? APPROVAL_WORDS[a.kind] : holdWords(j.holdReason), a?.code)
  })
  return {
    at: o.now,
    since,
    counts: { done: done.length, failed: broken.length, waiting: waiting.length, prs: o.prs.length },
    failed: broken.slice(0, DIGEST_SHOWN).map(j => task(j, o.label, j.error ?? j.holdReason)),
    waiting: waiting.slice(0, DIGEST_SHOWN),
    prs: o.prs.slice(0, DIGEST_SHOWN),
    done: done.slice(0, DIGEST_SHOWN * 2).map(j => task(j, o.label, null)),
    limits: { fiveHour: left(o.limits.fiveHour, o.now), sevenDay: left(o.limits.sevenDay, o.now) },
    prsNote: o.prsNote,
  }
}

function holdWords(reason: string | null): string {
  if (reason === 'conflict') return 'its chat is open in another window'
  return reason ?? 'paused'
}

/** "21:00", "9pm", "9:30 pm", "2130" → "21:00"; null if it isn't a time. */
export function parseClockTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '')
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (m[3]) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** "21:00" → "9 PM", "22:30" → "10:30 PM". */
export function clockLabel(at: string): string {
  const [h, m] = at.split(':').map(Number) as [number, number]
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

/** The digest as plain text (the log, and devices that only take text). */
export function digestText(d: Digest, now: number): string {
  const lines = [`📋 Today: ${countsLine(d)}`, limitsLine(d, now)]
  for (const t of d.failed) lines.push(`❌ #${t.job} ${t.folder}: ${t.detail ?? 'failed'}`)
  for (const t of d.waiting) lines.push(`✋ #${t.job} ${t.folder}: ${t.detail ?? 'waiting'}`)
  for (const p of d.prs) lines.push(`🔀 ${p.repo} #${p.number} ${p.title}`)
  return lines.filter(Boolean).join('\n')
}

export function countsLine(d: Digest): string {
  const c = d.counts
  if (c.done + c.failed + c.waiting + c.prs === 0) return 'nothing ran, nothing waits on you'
  const parts = [`✅ ${c.done} done`]
  if (c.failed) parts.push(`❌ ${c.failed} failed`)
  if (c.waiting) parts.push(`✋ ${c.waiting} waiting on you`)
  if (c.prs) parts.push(`🔀 ${c.prs} open PR${c.prs === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export function limitsLine(d: Digest, now: number): string {
  const one = (name: string, w: Digest['limits']['fiveHour']) =>
    w && w.left !== null ? `${name} ${w.left}%${w.resetsAt ? ` (resets ${formatClock(w.resetsAt, now)})` : ''}` : null
  const parts = [one('5-hour', d.limits.fiveHour), one('weekly', d.limits.sevenDay)].filter(Boolean)
  return parts.length ? `Limits left: ${parts.join(' · ')}` : 'Limits left: no reading yet (it updates while a task runs)'
}

/** Local "YYYY-MM-DD" and minutes after midnight. */
function local(at: number): { day: string; minutes: number } {
  const d = new Date(at)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { day, minutes: d.getHours() * 60 + d.getMinutes() }
}

export interface DigestClockDeps {
  /** "21:00", or null when it's off. */
  at: () => string | null
  now: () => number
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  /** Sends the digest covering everything since `since`. */
  send: (since: number) => Promise<void>
  log: (line: string) => void
}

/**
 * Sends the digest once a day, at the time set or the first tick after it (a Mac that slept
 * through it sends it on waking, the same evening). Never twice a day, and not the next day.
 */
export class DigestClock {
  private busy = false

  constructor(private readonly d: DigestClockDeps) {}

  async tick(): Promise<boolean> {
    const at = this.d.at()
    if (!at || this.busy) return false
    const now = this.d.now()
    const { day, minutes } = local(now)
    const [h, m] = at.split(':').map(Number) as [number, number]
    if (minutes < h * 60 + m || this.d.get('digest.day') === day) return false
    this.busy = true
    try {
      const last = this.d.get('digest.lastAt')
      const since = typeof last === 'number' ? last : now - 86_400_000
      this.d.set('digest.day', day)
      this.d.set('digest.lastAt', now)
      await this.d.send(since)
      this.d.log(`digest: sent for ${day}`)
      return true
    } finally {
      this.busy = false
    }
  }
}

export interface DigestSourceDeps {
  store: Store
  runner: Pick<Runner, 'limits'>
  gh: () => Gh | null
  label: (dir: string) => string
  now: () => number
}

/** How long looked-up pull requests are reused (opening the card twice doesn't ask GitHub twice). */
const PR_CACHE_MS = 2 * 60_000

/** Builds digests from the queue, the limits and GitHub. */
export class DigestSource {
  private cached: { key: string; at: number; prs: DigestPr[]; note: string | null } | null = null

  constructor(private readonly d: DigestSourceDeps) {}

  /** Everything since `since` (default: the last day). */
  async build(since?: number): Promise<Digest> {
    const now = this.d.now()
    const recent = this.d.store.finishedSince(now - PR_LOOKBACK_MS)
    const { prs, note } = await this.prs(prLinks(recent.map(j => j.lastMessage)), now)
    return buildDigest({
      now,
      since: since ?? now - 86_400_000,
      finished: recent,
      current: this.d.store.running(),
      approvals: this.d.store.pendingApprovals(),
      limits: this.d.runner.limits(),
      prs,
      prsNote: note,
      label: this.d.label,
    })
  }

  /** A pull request was merged here: it isn't open any more. */
  forget(url: string): void {
    if (this.cached) this.cached = { ...this.cached, prs: this.cached.prs.filter(p => p.url !== url) }
  }

  private async prs(urls: string[], now: number): Promise<{ prs: DigestPr[]; note: string | null }> {
    const key = urls.join(' ')
    if (this.cached && this.cached.key === key && now - this.cached.at < PR_CACHE_MS) return this.cached
    const found = await openPrs(urls, this.d.gh())
    this.cached = { key, at: now, ...found }
    return found
  }
}
