import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathKey, samePath, within } from '../shared/paths'

export const CLAUDE_DIR = process.env.CQ_CLAUDE_DIR ?? join(homedir(), '.claude')
export const CLAUDE_JSON = process.env.CQ_CLAUDE_JSON ?? join(homedir(), '.claude.json')

/** An entry from ~/.claude/sessions/<pid>.json: every live Claude Code process, VS Code ones included. */
export interface LiveSession {
  pid: number
  sessionId: string
  cwd?: string
  kind?: string
  entrypoint?: string
  status?: string
  name?: string
  /** When the process started (ms). */
  startedAt?: number
  /** Its inbox socket, where other processes on this Mac can post messages (cross-session messaging). */
  messagingSocketPath?: string
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function liveSessions(claudeDir = CLAUDE_DIR): LiveSession[] {
  const dir = join(claudeDir, 'sessions')
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const sessions: LiveSession[] = []
  for (const file of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf8')) as LiveSession
      if (typeof s.pid === 'number' && typeof s.sessionId === 'string' && alive(s.pid)) sessions.push(s)
    } catch {
      // Being rewritten right now; it'll be readable on the next look.
    }
  }
  return sessions
}

export function sessionHolders(sessionId: string): LiveSession[] {
  return liveSessions().filter(s => s.sessionId === sessionId)
}

/** Whether Claude Code has recorded "trust this folder" for `dir` or a folder above it. */
export function isTrusted(dir: string): boolean {
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }>
  try {
    projects = (JSON.parse(readFileSync(CLAUDE_JSON, 'utf8')) as { projects?: typeof projects }).projects ?? {}
  } catch {
    return false
  }
  // On Windows Claude Code keys these as it was given the folder ("D:/Code/app", "d:/Code/app").
  const trusted = new Set(Object.entries(projects).flatMap(([path, p]) => (p?.hasTrustDialogAccepted ? [pathKey(path)] : [])))
  for (let d = dir; ; d = dirname(d)) {
    if (trusted.has(pathKey(d))) return true
    if (d === dirname(d)) return false
  }
}

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

export interface FoundSession {
  sessionId: string
  cwd: string | null
  /** The transcript file. */
  path: string
}

/** Resolves a full session id or a unique prefix of one to its id and working directory. */
export function findSessions(prefix: string, claudeDir = CLAUDE_DIR): FoundSession[] {
  const root = join(claudeDir, 'projects')
  const found: FoundSession[] = []
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return []
  }
  const needle = prefix.toLowerCase()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl') || !file.toLowerCase().startsWith(needle)) continue
      const sessionId = file.slice(0, -'.jsonl'.length)
      let cwd: string | null = null
      try {
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readHead(join(root, dir, file), 256 * 1024))
        if (m?.[1]) cwd = JSON.parse(`"${m[1]}"`) as string
      } catch {
        // No cwd recorded; the caller falls back to the project it was given.
      }
      found.push({ sessionId, cwd, path: join(root, dir, file) })
    }
  }
  return found
}

/** Where a live session is open, for messages: "open in VS Code". */
export function whereLabel(s: Pick<LiveSession, 'entrypoint'>): string {
  switch (s.entrypoint) {
    case 'claude-vscode':
      return 'VS Code'
    case 'cli':
      return 'a terminal'
    case 'claude-desktop':
      return 'Claude Desktop'
    default:
      return 'another Claude window'
  }
}

/** Where Claude Code keeps the transcripts of conversations that ran in `cwd`. */
export function projectStoreDir(cwd: string, claudeDir = CLAUDE_DIR): string {
  return join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    const n = readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8', 0, n)
    // Started mid-line: drop the partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

/** A Claude Code conversation as Afterhours shows it, read from its transcript. */
export interface Conversation {
  sessionId: string
  /** The folder it ran in, as Claude Code recorded it. */
  cwd: string | null
  title: string
  lastPrompt: string | null
  /** Claude's last answer in full (its text, not tool calls or errors). */
  lastReply: string | null
  /** When the transcript last changed (ms). */
  updatedAt: number
  /** Model of Claude's last reply, e.g. claude-opus-5-5. */
  model: string | null
  /** Permission mode of the last prompt: plan, auto, acceptEdits, bypassPermissions, default… */
  permissionMode: string | null
  /** Set while the conversation's last message is a usage-limit error: its text and when it happened (ms). */
  limit: { text: string; at: number } | null
}

/** The transcript lines Afterhours reads. Claude Code writes many more kinds; the rest are skipped. */
interface Entry {
  type?: string
  timestamp?: string
  cwd?: string
  isMeta?: boolean
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  error?: string
  permissionMode?: string
  customTitle?: string
  agentName?: string
  aiTitle?: string
  lastPrompt?: string
  message?: { model?: string; content?: unknown }
}

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024

function parseLines(text: string): Entry[] {
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const e = JSON.parse(line) as Entry
      if (e && typeof e === 'object') entries.push(e)
    } catch {
      // A line cut off at the edge of what was read.
    }
  }
  return entries
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

/** What you typed in a user line; null for tool results and Claude Code's own notes. */
function typedPrompt(e: Entry): string | null {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return null
  const text = textOf(e.message?.content).trim()
  if (!text || /^<(command-|local-command-|system-reminder|bash-)/.test(text)) return null
  return text
}

function oneLineText(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Reads a conversation's title, last prompt and state from the start and end of its transcript. */
export function readConversation(path: string): Conversation | null {
  let head: Entry[]
  let entries: Entry[]
  let updatedAt: number
  try {
    const st = statSync(path)
    updatedAt = st.mtimeMs
    head = parseLines(readHead(path, HEAD_BYTES))
    entries = st.size > HEAD_BYTES ? [...head, ...parseLines(readTail(path, TAIL_BYTES))] : head
  } catch {
    return null
  }
  const c: Conversation = {
    sessionId: basename(path, '.jsonl'),
    cwd: null,
    title: '',
    lastPrompt: null,
    lastReply: null,
    updatedAt,
    model: null,
    permissionMode: null,
    limit: null,
  }
  let custom: string | null = null
  let agent: string | null = null
  let ai: string | null = null
  let last: Entry | null = null
  for (const e of entries) {
    if (!c.cwd && typeof e.cwd === 'string') c.cwd = e.cwd
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle
    else if (e.type === 'agent-name' && e.agentName) agent = e.agentName
    else if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle
    else if (e.type === 'last-prompt' && e.lastPrompt) c.lastPrompt = e.lastPrompt
    else if ((e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain) {
      last = e
      if (typeof e.permissionMode === 'string') c.permissionMode = e.permissionMode
      const model = e.type === 'assistant' ? e.message?.model : undefined
      if (model && model !== '<synthetic>') {
        c.model = model
        const said = textOf(e.message?.content).trim()
        if (said && !e.isApiErrorMessage) c.lastReply = said
      }
      const typed = typedPrompt(e)
      if (typed) c.lastPrompt = typed
    }
  }
  const first = head.map(typedPrompt).find(t => t !== null)
  c.title = oneLineText(custom ?? agent ?? ai ?? first ?? '') || c.sessionId.slice(0, 8)
  if (c.lastPrompt) c.lastPrompt = oneLineText(c.lastPrompt)
  if (last?.type === 'assistant' && last.isApiErrorMessage && last.error === 'rate_limit') {
    const at = Date.parse(last.timestamp ?? '')
    c.limit = { text: textOf(last.message?.content), at: Number.isFinite(at) ? at : updatedAt }
  }
  return c
}

/** The most recent conversations that ran in any of `dirs`, newest first. */
export function listConversations(dirs: string[], limit: number, claudeDir = CLAUDE_DIR): Conversation[] {
  const found: Conversation[] = []
  for (const dir of new Set(dirs)) {
    const store = projectStoreDir(dir, claudeDir)
    let files: { path: string; mtime: number }[]
    try {
      files = readdirSync(store)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ path: join(store, f), mtime: statSync(join(store, f)).mtimeMs }))
    } catch {
      continue
    }
    files.sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(0, limit)) {
      const c = readConversation(f.path)
      // Different folders can map to the same store name; the recorded folder decides.
      if (c && (c.cwd === null || samePath(c.cwd, dir))) found.push({ ...c, cwd: c.cwd ?? dir })
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** Scratch and system temp folders: chats there are test runs, not your work. */
const TEMP_DIRS = /^\/(private\/)?(tmp|var\/folders)\//
const inTemp = (cwd: string) => TEMP_DIRS.test(cwd) || (process.platform === 'win32' && within(tmpdir(), cwd))

/**
 * Your most recent conversations across every project, newest first: `limit` of them after skipping
 * `skip`, and whether there are more. Chats whose folder is gone, or in a temp folder, are left out.
 */
export function listRecentConversations(skip: number, limit: number, claudeDir = CLAUDE_DIR): { chats: Conversation[]; more: boolean } {
  const root = join(claudeDir, 'projects')
  const files: { path: string; mtime: number }[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return { chats: [], more: false }
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      try {
        files.push({ path: join(root, dir, name), mtime: statSync(join(root, dir, name)).mtimeMs })
      } catch {
        // Removed while listing.
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const chats: Conversation[] = []
  let usable = 0
  for (const f of files) {
    const c = readConversation(f.path)
    if (!c?.cwd || inTemp(c.cwd) || !existsSync(c.cwd)) continue
    if (usable++ < skip) continue
    if (chats.length === limit) return { chats, more: true }
    chats.push(c)
  }
  return { chats, more: false }
}

/** A conversation by its full session id, wherever it ran. */
export function findConversation(sessionId: string, claudeDir = CLAUDE_DIR): Conversation | null {
  const hit = findSessions(sessionId, claudeDir).find(s => s.sessionId === sessionId)
  return hit ? readConversation(hit.path) : null
}

/**
 * Names a conversation the way Claude Code's /rename does: a custom-title line at the end of its
 * transcript, so the name shows in Claude Code too (its /resume list, VS Code). False if there's no
 * such conversation.
 */
export function renameConversation(sessionId: string, title: string, claudeDir = CLAUDE_DIR): boolean {
  const hit = findSessions(sessionId, claudeDir).find(s => s.sessionId === sessionId)
  if (!hit) return false
  appendFileSync(hit.path, `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`)
  return true
}

/** The conversation a live session is running, read from its transcript. */
export function liveConversation(s: LiveSession, claudeDir = CLAUDE_DIR): Conversation | null {
  const direct = s.cwd ? readConversation(join(projectStoreDir(s.cwd, claudeDir), `${s.sessionId}.jsonl`)) : null
  return direct ?? findConversation(s.sessionId, claudeDir)
}
