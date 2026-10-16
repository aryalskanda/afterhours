// Pushes: which notices go to which device, what they say with and without details, quiet hours
// in the device's time zone, and sending to Expo: retries, rejected tokens, receipts. Also the
// app-reports log.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushPrefs } from '@afterhours/protocol'
import type { Notice } from '../src/daemon/notify'
import { inQuietHours, localMinutes, pushesFor, PushSender, type PushMessage } from '../src/daemon/remote/push'
import { appendReport } from '../src/daemon/remote/router'
import type { Job } from '../src/shared/types'

const all = { requests: true, done: true, failed: true, limits: true }
const prefs = (p: Partial<PushPrefs> = {}): PushPrefs => ({ events: all, quiet: null, details: true, ...p })
const job = { id: 14, prompt: 'Add a dark mode toggle' } as Job
const machine = { id: 'm1', name: 'build-box' }
const permission: Notice = { type: 'permission', job, code: 'k3x9', tool: 'Bash', detail: 'npm test', minutes: 15 }
// 2026-10-16 03:00 UTC: 08:45 in Kathmandu, 23:00 the day before in New York.
const at = Date.UTC(2026, 9, 16, 3, 0)

describe('what is pushed', () => {
  test('a request, in full or only that something needs you', () => {
    const [full] = pushesFor([{ device: 'd1', token: 'ExponentPushToken[a]', prefs: prefs() }], { machine, notice: permission, text: '🔐 #14 wants to use Bash: npm test', now: at })
    expect(full).toEqual({
      to: 'ExponentPushToken[a]',
      title: 'build-box',
      body: '#14 wants to use Bash: npm test',
      data: { machine: 'm1', type: 'permission', job: 14, code: 'k3x9' },
      sound: 'default',
      priority: 'high',
      ttl: 900,
      channelId: 'requests',
      categoryId: 'permission',
    } satisfies PushMessage)
    const [bare] = pushesFor([{ device: 'd1', token: 't', prefs: prefs({ details: false }) }], { machine, notice: permission, text: '🔐 #14 wants to use Bash: npm test', now: at })
    expect(bare!.body).toBe('#14 needs you.')
    expect(JSON.stringify(bare)).not.toContain('npm test')
  })

  test('each device gets only the notices it chose; some notices are never pushed', () => {
    const targets = [
      { device: 'd1', token: 'a', prefs: prefs({ events: { ...all, done: false } }) },
      { device: 'd2', token: 'b', prefs: prefs({ details: false }) },
    ]
    const done = pushesFor(targets, { machine, notice: { type: 'done', job, diff: null, next: null }, text: '✅ #14 is done', now: at })
    expect(done.map(m => [m.to, m.body, m.channelId, m.categoryId])).toEqual([['b', '#14 finished.', 'updates', undefined]])
    expect(pushesFor(targets, { machine, notice: { type: 'started', job }, text: '▶️ #14 started', now: at })).toEqual([])
    const plan = pushesFor(targets, { machine, notice: { type: 'plan_review', job, code: 'p1' }, text: '📋 #14 plan ready', now: at })
    expect(plan.map(m => m.categoryId)).toEqual(['plan', 'plan'])
    const failed = pushesFor(targets, { machine, notice: { type: 'held', job, reason: 'stuck' }, text: '⏸️ #14 is held: stuck', now: at })
    expect(failed.map(m => m.body)).toEqual(['#14 is held: stuck', '#14 stopped and needs a look.'])
    const setup = pushesFor(targets, { machine, notice: { type: 'setup_warning', message: 'Full Disk Access is off' }, text: '⚠️ Full Disk Access is off', now: at })
    expect(setup.map(m => m.body)).toEqual(['Full Disk Access is off', 'The machine needs a look.'])
  })

  test('quiet hours, in the device’s own time zone, across midnight', () => {
    expect(localMinutes(at, 'Asia/Kathmandu')).toBe(8 * 60 + 45)
    expect(localMinutes(at, 'America/New_York')).toBe(23 * 60)
    const night = (tz: string) => prefs({ quiet: { start: 22 * 60, end: 7 * 60, tz } })
    expect(inQuietHours(night('America/New_York'), at)).toBe(true)
    expect(inQuietHours(night('Asia/Kathmandu'), at)).toBe(false)
    expect(inQuietHours(prefs({ quiet: { start: 8 * 60, end: 9 * 60, tz: 'Asia/Kathmandu' } }), at)).toBe(true)
    expect(pushesFor([{ device: 'd', token: 't', prefs: night('America/New_York') }], { machine, notice: permission, text: 'x', now: at })).toEqual([])
  })
})

describe('sending to Expo', () => {
  function fakeExpo(answers: ((body: unknown) => Response)[]) {
    const calls: { url: string; body: unknown }[] = []
    const f = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      calls.push({ url: String(url), body })
      const answer = answers.shift()
      return answer ? answer(body) : Response.json({ data: (body as unknown[]).map((_, i) => ({ status: 'ok', id: `r${calls.length}-${i}` })) })
    }) as unknown as typeof fetch
    return { calls, fetch: f }
  }
  const message = (to: string): PushMessage => ({ to, title: 'build-box', body: 'x', data: { machine: 'm', type: 'done', job: 1, code: null }, sound: 'default', priority: 'normal', ttl: 60, channelId: 'updates' })

  test('busy or down: tried again, three times at most', async () => {
    const expo = fakeExpo([() => new Response('busy', { status: 429 }), () => new Response('down', { status: 503 })])
    const logs: string[] = []
    const sender = new PushSender({ url: 'http://expo.test/send', fetch: expo.fetch, gone: () => {}, log: l => logs.push(l), now: () => 0, sleep: async () => {} })
    await sender.send([message('a')])
    expect(expo.calls.length).toBe(3)
    expect(sender.waiting).toBe(1)
    const never = fakeExpo([0, 1, 2].map(() => () => new Response('down', { status: 500 })))
    await new PushSender({ url: 'http://expo.test/send', fetch: never.fetch, gone: () => {}, log: l => logs.push(l), now: () => 0, sleep: async () => {} }).send([message('a')])
    expect(never.calls.length).toBe(3)
    expect(logs.at(-1)).toContain('not sent')
  })

  test('tokens rejected now or in the receipts later are forgotten', async () => {
    let now = 0
    const gone: string[] = []
    const expo = fakeExpo([
      () => Response.json({ data: [{ status: 'ok', id: 'r1' }, { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }, { status: 'ok', id: 'r3' }] }),
      () => Response.json({ data: { r1: { status: 'ok' }, r3: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }),
    ])
    const sender = new PushSender({ url: 'http://expo.test/send', receiptsUrl: 'http://expo.test/receipts', fetch: expo.fetch, gone: t => gone.push(t), log: () => {}, now: () => now, sleep: async () => {} })
    await sender.send([message('a'), message('b'), message('c')])
    expect(gone).toEqual(['b'])
    // Receipts are asked for only once they're ready.
    await sender.checkReceipts()
    expect(expo.calls.length).toBe(1)
    now += 16 * 60_000
    await sender.checkReceipts()
    expect(expo.calls[1]).toEqual({ url: 'http://expo.test/receipts', body: { ids: ['r1', 'r3'] } })
    expect(gone).toEqual(['b', 'c'])
    expect(sender.waiting).toBe(0)
  })

  test('a hundred at a time', async () => {
    const expo = fakeExpo([])
    await new PushSender({ fetch: expo.fetch, gone: () => {}, log: () => {}, now: () => 0, sleep: async () => {} }).send(Array.from({ length: 150 }, (_, i) => message(`t${i}`)))
    expect(expo.calls.map(c => (c.body as unknown[]).length)).toEqual([100, 50])
  })
})

describe('problem reports', () => {
  test('appended with who sent them; a big log is set aside', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'afterhours-reports-')), 'logs', 'app-reports.log')
    expect(appendReport(path, { at: 0, device: 'Pixel', app: 'afterhours-app/0.2.0', platform: 'android', text: 'The diff screen is blank\n' })).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('--- 1970-01-01T00:00:00.000Z · Pixel · afterhours-app/0.2.0 · android\nThe diff screen is blank\n\n')
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1))
    appendReport(path, { at: 0, device: 'Pixel', app: 'a', platform: 'p', text: 'again' })
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('again')
  })
})
