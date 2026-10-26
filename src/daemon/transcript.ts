// A Claude Code conversation as apps show it: what you said, what Claude said, each tool call in a
// line with an excerpt of what came back, and what happened along the way. Transcripts only grow,
// so each one is read once and then only from where the last read stopped.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import type { TranscriptItem, TranscriptPage, Usage } from '@afterhours/protocol'
import { toolName, toolSummary } from './tools'

/** Longest excerpt of a tool's result kept per call. */
const RESULT_CHARS = 800
/** Transcripts kept parsed in memory. */
const CACHE_SIZE = 16

interface Parsed {
  path: string
  /** Bytes read so far (always the end of a complete line). */
  offset: number
  items: TranscriptItem[]
  /** Tool calls waiting for their result: tool_use id → index in `items`. */
  open: Map<string, number>
  /** Usage per API message (a message is written once per content block; the last one counts). */
  perMessage: Map<string, Usage & { at: number | null }>
  /** Claude Code's own running totals, one per time it ran the conversation, by its start time. */
  costRuns: Map<number, { usd: number; linesAdded: number; linesRemoved: number; usage: Usage }>
  /** The message id of the last item Claude said, to join its text blocks. */
  lastClaudeMessage: string | null
  cwd: string | null
  updatedAt: number
}

const cache = new Map<string, Parsed>()

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface Entry {
  type?: string
  /** cost-state lines: Claude Code's totals for the run that started at `startTime`. */
  startTime?: number
  totalCostUSD?: number
  totalLinesAdded?: number
  totalLinesRemoved?: number
  modelUsage?: Record<string, Record<string, unknown>>
  subtype?: string
  timestamp?: string
  cwd?: string
  isMeta?: boolean
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  isCompactSummary?: boolean
  content?: unknown
  message?: { id?: string; content?: unknown; usage?: Record<string, unknown> }
}

function at(e: Entry): number | null {
  const t = e.timestamp ? Date.parse(e.timestamp) : NaN
  return Number.isFinite(t) ? t : null
}

function excerpt(text: string, max = RESULT_CHARS): string {
  const t = text.replace(/\s+$/, '')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A tool result's text: a string, or text blocks (images become a word). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: Block) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** What you typed, from a user line's text; null for Claude Code's own notes and command output. */
function typed(text: string): { kind: 'you' | 'note'; text: string } | null {
  const t = text.trim()
  if (!t) return null
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    const name = command[1]!.startsWith('/') ? command[1]! : `/${command[1]}`
    return { kind: 'you', text: args ? `${name} ${args}` : name }
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t)
  if (bash) return { kind: 'you', text: `! ${bash[1]!.trim()}` }
  if (/^\[Request interrupted by user/.test(t)) return { kind: 'note', text: 'Interrupted' }
  if (/^<[a-z-]+>/.test(t)) return null // command output, reminders, hook text
  return { kind: 'you', text: t }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

type WithoutIndex<T> = T extends unknown ? Omit<T, 'i'> : never

function add(p: Parsed, item: WithoutIndex<TranscriptItem>): number {
  const i = p.items.length
  p.items.push({ ...item, i } as TranscriptItem)
  return i
}

function read(p: Parsed, e: Entry): void {
  if (e.isSidechain) return // a subagent's own steps; its call and result are in the main thread
  if (!p.cwd && typeof e.cwd === 'string') p.cwd = e.cwd
  const when = at(e)
  if (e.type === 'cost-state') {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const m of Object.values(e.modelUsage ?? {})) {
      usage.input += num(m.inputTokens)
      usage.output += num(m.outputTokens)
      usage.cacheRead += num(m.cacheReadInputTokens)
      usage.cacheWrite += num(m.cacheCreationInputTokens)
    }
    p.costRuns.set(num(e.startTime), { usd: num(e.totalCostUSD), linesAdded: num(e.totalLinesAdded), linesRemoved: num(e.totalLinesRemoved), usage })
    return
  }
  if (e.type === 'system') {
    if (e.subtype === 'compact_boundary') add(p, { kind: 'note', at: when, text: 'Context compacted' })
    return
  }
  if (e.type === 'user') {
    if (e.isMeta) return
    if (e.isCompactSummary) return
    const content = e.message?.content
    if (typeof content === 'string') {
      const t = typed(content)
      if (t) add(p, { kind: t.kind, at: when, text: t.text })
      p.lastClaudeMessage = null
      return
    }
    if (!Array.isArray(content)) return
    const texts: string[] = []
    for (const b of content as Block[]) {
      if (b?.type === 'tool_result' && b.tool_use_id) {
        const index = p.open.get(b.tool_use_id)
        if (index === undefined) continue
        p.open.delete(b.tool_use_id)
        const item = p.items[index]
        if (item?.kind === 'tool') {
          // Only blank lines go from the start: a file's first line keeps its indent.
          const text = resultText(b.content).replace(/^(\s*\n)+/, '').trimEnd()
          p.items[index] = { ...item, result: text ? excerpt(text) : null, error: b.is_error === true }
        }
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text)
      } else if (b?.type === 'image') {
        texts.push('[image]')
      }
    }
    if (texts.length > 0) {
      const t = typed(texts.join('\n'))
      if (t) add(p, { kind: t.kind, at: when, text: t.text })
      p.lastClaudeMessage = null
    }
    return
  }
  if (e.type === 'assistant') {
    const msg = e.message ?? {}
    const id = msg.id ?? null
    if (id && msg.usage) {
      const u = msg.usage
      p.perMessage.set(id, {
        at: when,
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
      })
    }
    const blocks: Block[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? (msg.content as Block[]) : []
    if (e.isApiErrorMessage) {
      const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join(' ').trim()
      if (text) add(p, { kind: 'note', at: when, text: excerpt(text, 300) })
      p.lastClaudeMessage = null
      return
    }
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const last = p.items[p.items.length - 1]
        if (id && p.lastClaudeMessage === id && last?.kind === 'claude') {
          p.items[p.items.length - 1] = { ...last, text: `${last.text}\n\n${b.text.trim()}` }
        } else {
          add(p, { kind: 'claude', at: when, text: b.text.trim() })
        }
        p.lastClaudeMessage = id
      } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        const index = add(p, {
          kind: 'tool',
          at: when,
          id: b.id ?? `${p.items.length}`,
          name: toolName(b.name),
          detail: toolSummary(b.name, b.input, p.cwd),
          result: null,
          error: false,
        })
        if (b.id) p.open.set(b.id, index)
        p.lastClaudeMessage = null
      }
    }
  }
}

function fresh(path: string): Parsed {
  return { path, offset: 0, items: [], open: new Map(), perMessage: new Map(), costRuns: new Map(), lastClaudeMessage: null, cwd: null, updatedAt: 0 }
}

/** Reads what was added to the transcript since last time. Throws if it can't be read. */
export function readTranscript(path: string): Parsed {
  let p = cache.get(path)
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    // Shorter than what was read: it was replaced; start over.
    if (!p || st.size < p.offset) p = fresh(path)
    if (st.size > p.offset) {
      const buf = Buffer.alloc(st.size - p.offset)
      const n = readSync(fd, buf, 0, buf.length, p.offset)
      const end = buf.lastIndexOf(10, n - 1) // only complete lines; a line being written waits
      if (end >= 0) {
        const text = buf.toString('utf8', 0, end + 1)
        for (const line of text.split('\n')) {
          if (!line.startsWith('{')) continue
          try {
            read(p, JSON.parse(line) as Entry)
          } catch {
            // A malformed line: skip it, as Claude Code does.
          }
        }
        p.offset += end + 1
      }
    }
    p.updatedAt = st.mtimeMs
  } finally {
    closeSync(fd)
  }
  cache.delete(path)
  cache.set(path, p)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return p
}

/**
 * Which of `ids` the conversation mentions since `since`: background work started then (a tool's
 * result names what it started). Unreadable: all of them, as if each were.
 */
export function mentionedSince(path: string, since: number, ids: string[]): Set<string> {
  try {
    const text = readTranscript(path)
      .items.filter(i => (i.at ?? 0) >= since)
      .map(i => ('result' in i ? `${i.detail}\n${i.result ?? ''}` : i.text))
      .join('\n')
    return new Set(ids.filter(id => text.includes(id)))
  } catch {
    return new Set(ids)
  }
}

/**
 * Claude Code's own totals across its runs of the conversation (only runs from `since` on: a task
 * continuing a conversation counts its own); null if it recorded none.
 */
export function costOf(p: Pick<Parsed, 'costRuns'>, since = 0): { usd: number; linesAdded: number; linesRemoved: number } | null {
  const runs = [...p.costRuns.entries()].filter(([start]) => start >= since).map(([, r]) => r)
  if (runs.length === 0) return null
  const total = { usd: 0, linesAdded: 0, linesRemoved: 0 }
  for (const r of runs) {
    total.usd += r.usd
    total.linesAdded += r.linesAdded
    total.linesRemoved += r.linesRemoved
  }
  return total
}

/** Tokens used from `since` on: Claude Code's own count when it recorded one, else each reply's usage summed. */
export function usageOf(p: Pick<Parsed, 'perMessage' | 'costRuns'>, since = 0): Usage {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const runs = [...p.costRuns.entries()].filter(([start]) => start >= since).map(([, r]) => r.usage)
  const recorded = runs.some(u => u.input + u.output > 0)
  const replies = [...p.perMessage.values()].filter(u => since === 0 || (u.at ?? 0) >= since)
  for (const u of recorded ? runs : replies) {
    total.input += u.input
    total.output += u.output
    total.cacheRead += u.cacheRead
    total.cacheWrite += u.cacheWrite
  }
  return total
}

/**
 * A page of a transcript: the newest `limit` items, the ones before `before`, or those after
 * `after`. Usage and cost count from `since` (a task's start), else the whole conversation.
 */
export function transcriptPage(path: string, o: { before?: number; after?: number; limit?: number; since?: number } = {}): TranscriptPage {
  const p = readTranscript(path)
  const limit = o.limit ?? 100
  const total = p.items.length
  let items: TranscriptItem[]
  let before: number | null
  if (o.after !== undefined) {
    const start = Math.max(0, o.after + 1)
    items = p.items.slice(start, start + limit)
    before = start > 0 ? start : null
  } else {
    const end = Math.min(o.before ?? total, total)
    const start = Math.max(0, end - limit)
    items = p.items.slice(start, end)
    before = start > 0 ? start : null
  }
  return { session: basename(path, '.jsonl'), items, before, total, usage: usageOf(p, o.since), cost: costOf(p, o.since), updatedAt: p.updatedAt }
}

/** For tests: forget what was read. */
export function clearTranscriptCache(): void {
  cache.clear()
}
