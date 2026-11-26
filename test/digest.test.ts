import { describe, expect, test } from 'bun:test'
import { buildDigest, clockLabel, DIGEST_SHOWN, DigestClock, DigestSource, digestText, parseClockTime } from '../src/daemon/digest'
import { mergePr, openPr, openPrs, prLinks, type Gh } from '../src/daemon/prs'
import { Store } from '../src/daemon/store'
import type { Approval, Job, JobSpec } from '../src/shared/types'

const NOW = new Date(2026, 10, 26, 21, 0).getTime()
const HOUR = 3_600_000
const label = (dir: string) => dir.split('/').pop()!

function store(): Store {
  return new Store(':memory:')
}
const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  projectDir: '/code/shop',
  prompt: 'Fix the checkout',
  plan: false,
  review: false,
  execMode: 'auto',
  model: 'opus',
  effort: 'high',
  sessionPolicy: 'new',
  source: 'test',
  ...over,
})
function job(s: Store, patch: Partial<Job>, over: Partial<JobSpec> = {}): Job {
  const j = s.addJob(spec(over), NOW - 10 * HOUR)
  return s.updateJob(j.id, patch)
}

const PR = (n: number, state = 'OPEN', draft = false) =>
  JSON.stringify({ number: n, title: `Change ${n}`, state, isDraft: draft, url: `https://github.com/me/shop/pull/${n}` })

/** A gh that answers `pr view` from a table, and records merges. */
function fakeGh(prs: Record<string, string>, o: { mergeFails?: string } = {}): Gh & { calls: string[][] } {
  const calls: string[][] = []
  const gh = (async (args: string[]) => {
    calls.push(args)
    if (args[1] === 'view') {
      const out = prs[args[2]!]
      return out ? { code: 0, out, err: '' } : { code: 1, out: '', err: 'not found' }
    }
    if (args[1] === 'merge') return o.mergeFails ? { code: 1, out: '', err: o.mergeFails } : { code: 0, out: '', err: '' }
    return { code: 1, out: '', err: 'unknown' }
  }) as Gh & { calls: string[][] }
  gh.calls = calls
  return gh
}

describe('what the digest says', () => {
  test('done, failed (ended or paused with an error), waiting on you, open PRs and the limits left', () => {
    const s = store()
    const done = job(s, { status: 'done', finishedAt: NOW - HOUR })
    const old = job(s, { status: 'done', finishedAt: NOW - 30 * HOUR })
    const failed = job(s, { status: 'failed', finishedAt: NOW - 2 * HOUR, error: 'folder not found' })
    const broken = job(s, { status: 'held', error: 'Claude exited (code 1)', holdReason: 'Claude exited (code 1)' }, { projectDir: '/code/blog' })
    const review = job(s, { status: 'running', phase: 'planning' })
    const conflict = job(s, { status: 'held', holdReason: 'conflict' })
    const cancelled = job(s, { status: 'cancelled', finishedAt: NOW - HOUR, error: 'Killed by iPhone' })
    const approval: Approval = { code: 'abcde', jobId: review.id, kind: 'review', payload: null, status: 'pending', answer: null, createdAt: NOW, resolvedAt: null }
    const d = buildDigest({
      now: NOW,
      since: NOW - 24 * HOUR,
      finished: s.finishedSince(0),
      current: s.running(),
      approvals: [approval],
      limits: { fiveHour: { usedPct: 35, resetsAt: NOW + 2 * HOUR }, sevenDay: { usedPct: 74, resetsAt: NOW + 50 * HOUR } },
      prs: [{ url: 'https://github.com/me/shop/pull/7', repo: 'shop', number: 7, title: 'Change 7', draft: false }],
      prsNote: null,
      label,
    })
    expect(d.counts).toEqual({ done: 1, failed: 2, waiting: 2, prs: 1 })
    expect(d.done.map(t => t.job)).toEqual([done.id])
    expect(d.done.map(t => t.job)).not.toContain(old.id)
    expect(d.failed.map(t => [t.job, t.folder, t.detail])).toEqual([
      [broken.id, 'blog', 'Claude exited (code 1)'],
      [failed.id, 'shop', 'folder not found'],
    ])
    expect(d.waiting).toEqual([
      expect.objectContaining({ job: review.id, detail: 'plan to review', code: 'abcde' }),
      expect.objectContaining({ job: conflict.id, detail: 'its chat is open in another window' }),
    ])
    // Killing a task yourself isn't a failure.
    expect([...d.failed, ...d.done].map(t => t.job)).not.toContain(cancelled.id)
    expect(d.limits).toEqual({ fiveHour: { left: 65, resetsAt: NOW + 2 * HOUR }, sevenDay: { left: 26, resetsAt: NOW + 50 * HOUR } })
    const text = digestText(d, NOW)
    expect(text.split('\n')[0]).toBe('📋 Today: ✅ 1 done · ❌ 2 failed · ✋ 2 waiting on you · 🔀 1 open PR')
    expect(text).toContain('Limits left: 5-hour 65% (resets 11:00 PM) · weekly 26%')
  })

  test('a stalled task is waiting on you, with why', () => {
    const s = store()
    const j = job(s, { status: 'running', stalledAt: NOW - HOUR, stallReason: 'no events for 11m' })
    const d = buildDigest({ now: NOW, since: NOW - 24 * HOUR, finished: [], current: s.running(), approvals: [], limits: {}, prs: [], prsNote: null, label })
    expect(d.waiting).toEqual([expect.objectContaining({ job: j.id, detail: 'stalled: no events for 11m' })])
  })

  test('a few of each are listed; the counts say how many', () => {
    const s = store()
    for (let i = 0; i < 8; i++) job(s, { status: 'failed', finishedAt: NOW - HOUR - i, error: `error ${i}` })
    const d = buildDigest({ now: NOW, since: NOW - 24 * HOUR, finished: s.finishedSince(0), current: [], approvals: [], limits: {}, prs: [], prsNote: null, label })
    expect(d.counts.failed).toBe(8)
    expect(d.failed).toHaveLength(DIGEST_SHOWN)
    expect(d.failed[0]!.detail).toBe('error 0') // newest first
  })

  test('a quiet day says so, and limits with no reading say that', () => {
    const d = buildDigest({ now: NOW, since: NOW - 24 * HOUR, finished: [], current: [], approvals: [], limits: {}, prs: [], prsNote: null, label })
    expect(digestText(d, NOW)).toBe('📋 Today: nothing ran, nothing waits on you\nLimits left: no reading yet (it updates while a task runs)')
  })
})

describe('pull requests', () => {
  test('links in what tasks said, each once', () => {
    expect(
      prLinks([
        'Opened https://github.com/me/shop/pull/7 and https://github.com/me/shop/pull/7.',
        null,
        'See [PR #8](https://github.com/me/blog/pull/8)',
        'https://github.com/me/shop/issues/3',
      ]),
    ).toEqual(['https://github.com/me/shop/pull/7', 'https://github.com/me/blog/pull/8'])
  })

  test("gh's answer: only open ones", () => {
    expect(openPr(PR(7))).toEqual({ url: 'https://github.com/me/shop/pull/7', repo: 'shop', number: 7, title: 'Change 7', draft: false })
    expect(openPr(PR(8, 'MERGED'))).toBeNull()
    expect(openPr('not json')).toBeNull()
  })

  test('looked up with gh; none listed, with a note, when gh is missing', async () => {
    const urls = ['https://github.com/me/shop/pull/7', 'https://github.com/me/shop/pull/8', 'https://github.com/me/shop/pull/9']
    const gh = fakeGh({ [urls[0]!]: PR(7), [urls[1]!]: PR(8, 'MERGED'), [urls[2]!]: PR(9, 'OPEN', true) })
    expect(await openPrs(urls, gh)).toEqual({ prs: [openPr(PR(7))!, openPr(PR(9, 'OPEN', true))!], note: null })
    expect((await openPrs(urls, null)).note).toContain('gh isn’t installed')
    expect(await openPrs([], null)).toEqual({ prs: [], note: null })
  })

  test('merged with gh as a merge commit; a refusal says why', async () => {
    const url = 'https://github.com/me/shop/pull/7'
    const gh = fakeGh({})
    expect(await mergePr(url, gh)).toEqual({ ok: true, text: 'Merged shop #7.' })
    expect(gh.calls).toEqual([['pr', 'merge', url, '--merge']])
    expect(await mergePr(url, fakeGh({}, { mergeFails: 'Pull request is not mergeable: the base branch policy prohibits the merge.' }))).toEqual({
      ok: false,
      text: 'Couldn’t merge shop #7: Pull request is not mergeable: the base branch policy prohibits the merge.',
    })
    expect((await mergePr('https://example.com/x', gh)).ok).toBe(false)
  })

  test('the source finds PRs in recent tasks and reuses the lookup for a while', async () => {
    const s = store()
    job(s, { status: 'done', finishedAt: NOW - 3 * 24 * HOUR, lastMessage: 'Opened https://github.com/me/shop/pull/7' })
    const gh = fakeGh({ 'https://github.com/me/shop/pull/7': PR(7) })
    let now = NOW
    const source = new DigestSource({ store: s, runner: { limits: () => ({}) }, gh: () => gh, label, now: () => now })
    const d = await source.build()
    expect(d.prs.map(p => p.number)).toEqual([7])
    expect(d.counts.done).toBe(0) // three days ago: not today's
    await source.build()
    expect(gh.calls).toHaveLength(1)
    source.forget('https://github.com/me/shop/pull/7')
    expect((await source.build()).prs).toEqual([])
    now += 3 * 60_000
    await source.build()
    expect(gh.calls).toHaveLength(2)
  })
})

describe('the time', () => {
  test('typed times', () => {
    expect(parseClockTime('21:00')).toBe('21:00')
    expect(parseClockTime('9pm')).toBe('21:00')
    expect(parseClockTime('10:30 pm')).toBe('22:30')
    expect(parseClockTime('12am')).toBe('00:00')
    expect(parseClockTime('2130')).toBe('21:30')
    expect(parseClockTime('7')).toBe('07:00')
    expect(parseClockTime('25:00')).toBeNull()
    expect(parseClockTime('13pm')).toBeNull()
    expect(parseClockTime('tonight')).toBeNull()
    expect(clockLabel('21:00')).toBe('9 PM')
    expect(clockLabel('22:30')).toBe('10:30 PM')
    expect(clockLabel('00:15')).toBe('12:15 AM')
  })

  function clock(at: string | null, start: number) {
    let now = start
    const kv = new Map<string, unknown>()
    const sent: number[] = []
    const c = new DigestClock({ at: () => at, now: () => now, get: k => kv.get(k), set: (k, v) => kv.set(k, v), send: async since => void sent.push(since), log: () => {} })
    return { c, sent, kv, set: (t: number) => (now = t) }
  }

  test('once a day at the time set, covering everything since the last one', async () => {
    const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
    const t = clock('21:00', day(26, 20, 59))
    expect(await t.c.tick()).toBe(false)
    t.set(day(26, 21, 0))
    expect(await t.c.tick()).toBe(true)
    expect(t.sent).toEqual([day(25, 21, 0)])
    t.set(day(26, 23, 0))
    expect(await t.c.tick()).toBe(false) // not twice
    t.set(day(27, 21, 1))
    expect(await t.c.tick()).toBe(true)
    expect(t.sent[1]).toBe(day(26, 21, 0))
  })

  test('asleep at the time: sent on waking that evening, not the next morning', async () => {
    const day = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
    const t = clock('21:00', day(26, 23, 40))
    expect(await t.c.tick()).toBe(true)
    const u = clock('21:00', day(27, 7, 0))
    u.kv.set('digest.day', '2026-11-25')
    expect(await u.c.tick()).toBe(false)
  })

  test('off: never', async () => {
    const t = clock(null, new Date(2026, 10, 26, 22, 0).getTime())
    expect(await t.c.tick()).toBe(false)
  })
})
