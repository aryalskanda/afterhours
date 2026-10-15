// Reading a Claude Code transcript into what apps show: entries shaped like Claude Code 2.1.301
// writes them (one line per content block, tool results in user lines, cost-state totals).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTranscriptCache, costOf, readTranscript, transcriptPage, usageOf } from '../src/daemon/transcript'

let dir: string
let path: string

beforeEach(() => {
  clearTranscriptCache()
  dir = mkdtempSync(join(tmpdir(), 'cq-transcript-'))
  path = join(dir, '3f0c2a9e-0000-4000-8000-000000000001.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const cwd = '/home/me/code/shop/web'
const t = (s: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, s)).toISOString()
const line = (o: unknown) => `${JSON.stringify(o)}\n`

const you = (text: string, s: number, extra: object = {}) => line({ type: 'user', cwd, timestamp: t(s), message: { role: 'user', content: text }, ...extra })
const said = (id: string, block: object, s: number, usage?: object) =>
  line({ type: 'assistant', cwd, timestamp: t(s), message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [block], ...(usage ? { usage } : {}) } })
const result = (toolUseId: string, content: unknown, s: number, isError = false) =>
  line({ type: 'user', cwd, timestamp: t(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } })

function conversation(): string {
  return [
    line({ type: 'permission-mode', permissionMode: 'auto', sessionId: 'x' }),
    you('Add a CSV export to the orders page', 0),
    you('<system-reminder>internal</system-reminder>', 1, { isMeta: true }),
    said('msg_1', { type: 'thinking', thinking: 'secret thoughts' }, 2),
    said('msg_1', { type: 'text', text: 'I’ll look at the orders page first.' }, 3, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    said('msg_1', { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: `${cwd}/src/orders.tsx` } }, 4, { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }),
    result('tu_1', '     1→export function Orders() {}', 5),
    said('msg_2', { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test -- --watch=false', description: 'Run the tests' } }, 6, { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    result('tu_2', [{ type: 'text', text: 'FAIL src/orders.test.tsx\n  1 failed' }], 7, true),
    line({ type: 'assistant', cwd, timestamp: t(8), isSidechain: true, message: { id: 'msg_side', content: [{ type: 'text', text: 'subagent internals' }] } }),
    said('msg_3', { type: 'tool_use', id: 'tu_3', name: 'Task', input: { subagent_type: 'Explore', description: 'Find the CSV helpers' } }, 9),
    result('tu_3', 'Found src/lib/csv.ts', 10),
    said('msg_4', { type: 'tool_use', id: 'tu_4', name: 'mcp__github__create_issue', input: { title: 'Flaky test' } }, 11),
    you('[Request interrupted by user for tool use]', 12),
    you('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>', 13),
    line({ type: 'system', subtype: 'compact_boundary', timestamp: t(14), cwd }),
    said('msg_5', { type: 'text', text: 'Done. The export is in **Settings**.' }, 15),
    said('msg_5', { type: 'text', text: 'Tests pass.' }, 16),
    line({ type: 'cost-state', startTime: Date.UTC(2026, 9, 16, 9, 0, 0), totalCostUSD: 0.5, totalLinesAdded: 3, totalLinesRemoved: 1, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 } } }),
    line({ type: 'cost-state', startTime: Date.UTC(2026, 9, 16, 10, 0, 0), totalCostUSD: 0.25, totalLinesAdded: 40, totalLinesRemoved: 2, modelUsage: { 'claude-opus-5-5': { inputTokens: 23, outputTokens: 52, cacheReadInputTokens: 200, cacheCreationInputTokens: 100 } } }),
  ].join('')
}

test('a conversation: what you said, what Claude said, each tool call with its result', () => {
  writeFileSync(path, conversation())
  const page = transcriptPage(path)
  expect(page.session).toBe('3f0c2a9e-0000-4000-8000-000000000001')
  expect(page.items.map(i => ({ ...i, at: undefined }))).toEqual([
    { kind: 'you', i: 0, at: undefined, text: 'Add a CSV export to the orders page' },
    { kind: 'claude', i: 1, at: undefined, text: 'I’ll look at the orders page first.' },
    { kind: 'tool', i: 2, at: undefined, id: 'tu_1', name: 'Read', detail: 'src/orders.tsx', result: '     1→export function Orders() {}', error: false },
    { kind: 'tool', i: 3, at: undefined, id: 'tu_2', name: 'Bash', detail: 'npm test -- --watch=false', result: 'FAIL src/orders.test.tsx\n  1 failed', error: true },
    { kind: 'tool', i: 4, at: undefined, id: 'tu_3', name: 'Task', detail: 'Explore: Find the CSV helpers', result: 'Found src/lib/csv.ts', error: false },
    { kind: 'tool', i: 5, at: undefined, id: 'tu_4', name: 'github · create_issue', detail: 'Flaky test', result: null, error: false },
    { kind: 'note', i: 6, at: undefined, text: 'Interrupted' },
    { kind: 'you', i: 7, at: undefined, text: '/compact keep the plan' },
    { kind: 'note', i: 8, at: undefined, text: 'Context compacted' },
    { kind: 'claude', i: 9, at: undefined, text: 'Done. The export is in **Settings**.\n\nTests pass.' },
  ])
  expect(page.items[0]!.at).toBe(Date.UTC(2026, 9, 16, 10, 0, 0))
  expect(page.total).toBe(10)
  expect(page.before).toBeNull()
})

test('cost and tokens: Claude Code’s own totals, per run; a task counts only its own runs', () => {
  writeFileSync(path, conversation())
  const p = readTranscript(path)
  expect(costOf(p)).toEqual({ usd: 0.75, linesAdded: 43, linesRemoved: 3 })
  expect(usageOf(p)).toEqual({ input: 123, output: 72, cacheRead: 1200, cacheWrite: 110 })
  const since = Date.UTC(2026, 9, 16, 9, 30, 0)
  expect(costOf(p, since)).toEqual({ usd: 0.25, linesAdded: 40, linesRemoved: 2 })
  expect(usageOf(p, since)).toEqual({ input: 23, output: 52, cacheRead: 200, cacheWrite: 100 })
  expect(transcriptPage(path, { since }).cost).toEqual({ usd: 0.25, linesAdded: 40, linesRemoved: 2 })
})

test('without cost-state lines, tokens are each reply’s usage, counted once per message', () => {
  writeFileSync(path, conversation().split('\n').filter(l => !l.includes('cost-state')).join('\n') + '\n')
  const p = readTranscript(path)
  expect(costOf(p)).toBeNull()
  // msg_1 is written twice; its last usage counts once. msg_2 adds its own.
  expect(usageOf(p)).toEqual({ input: 13, output: 47, cacheRead: 100, cacheWrite: 50 })
})

test('paging back from the end, and only what’s new', () => {
  writeFileSync(path, conversation())
  const last = transcriptPage(path, { limit: 4 })
  expect(last.items.map(i => i.i)).toEqual([6, 7, 8, 9])
  expect(last.before).toBe(6)
  const earlier = transcriptPage(path, { before: 6, limit: 4 })
  expect(earlier.items.map(i => i.i)).toEqual([2, 3, 4, 5])
  expect(earlier.before).toBe(2)
  expect(transcriptPage(path, { before: 2, limit: 4 }).before).toBeNull()
  expect(transcriptPage(path, { after: 7 }).items.map(i => i.i)).toEqual([8, 9])
  expect(transcriptPage(path, { after: 9 }).items).toEqual([])
})

test('a growing transcript is read from where it stopped; a half-written line waits', () => {
  writeFileSync(path, you('First', 0) + said('m1', { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, 1))
  expect(transcriptPage(path).total).toBe(2)
  const half = result('a', 'README.md', 2)
  appendFileSync(path, half.slice(0, 20))
  const mid = transcriptPage(path)
  expect(mid.items[1]).toMatchObject({ kind: 'tool', result: null })
  appendFileSync(path, half.slice(20) + said('m2', { type: 'text', text: 'There’s a README.' }, 3))
  const after = transcriptPage(path)
  expect(after.items[1]).toMatchObject({ kind: 'tool', result: 'README.md' })
  expect(after.items[2]).toMatchObject({ kind: 'claude', text: 'There’s a README.' })
  // Replaced by a shorter file: read again from the start.
  writeFileSync(path, you('Only this', 0))
  expect(transcriptPage(path).items).toEqual([expect.objectContaining({ kind: 'you', text: 'Only this' })])
})

test('long results are cut, and an unreadable transcript throws', () => {
  writeFileSync(path, said('m', { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/etc/hosts' } }, 0) + result('x', 'y'.repeat(5000), 1))
  const item = transcriptPage(path).items[0]
  expect(item?.kind === 'tool' && item.result?.length).toBe(800)
  expect(item?.kind === 'tool' && item.detail).toBe('/etc/hosts')
  expect(() => transcriptPage(join(dir, 'missing.jsonl'))).toThrow()
})
