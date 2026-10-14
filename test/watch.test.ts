import { describe, expect, test } from 'bun:test'
import { parseResetText } from '../src/daemon/limits'
import type { Notice } from '../src/daemon/notify'
import type { Conversation, LiveSession } from '../src/daemon/sessions'
import { SessionWatcher } from '../src/daemon/watch'

const LIMIT_TEXT = "You've hit your session limit · resets 4:55am (Asia/Katmandu)"

function setup() {
  let now = Date.UTC(2026, 9, 14, 21, 20)
  let enabled = true
  const live: LiveSession[] = []
  const chats = new Map<string, Conversation>()
  const queued = new Set<string>()
  const kv = new Map<string, unknown>()
  const notices: Notice[] = []
  const watcher = new SessionWatcher({
    liveSessions: () => live,
    conversation: s => chats.get(s.sessionId) ?? null,
    queued: id => queued.has(id),
    limits: () => ({}),
    kvGet: <T>(key: string) => kv.get(key) as T | undefined,
    kvSet: (key, value) => kv.set(key, value),
    notify: n => notices.push(n),
    enabled: () => enabled,
    now: () => now,
  })
  /** A VS Code chat whose last message is a usage-limit stop `minutesAgo` minutes ago. */
  const stopped = (sessionId: string, minutesAgo: number, over: Partial<LiveSession> = {}) => {
    live.push({ pid: 100 + live.length, sessionId, cwd: '/Users/me/app', kind: 'interactive', entrypoint: 'claude-vscode', status: 'idle', ...over })
    chats.set(sessionId, {
      sessionId,
      cwd: '/Users/me/app',
      title: 'Claude Code prompt queue optimizer',
      lastPrompt: 'Build it',
      updatedAt: now,
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      limit: { text: LIMIT_TEXT, at: now - minutesAgo * 60_000 },
    })
  }
  return {
    watcher,
    notices,
    chats,
    queued,
    stopped,
    now: () => now,
    advance: (ms: number) => (now += ms),
    disable: () => (enabled = false),
  }
}

describe('watching your other chats', () => {
  test('one notice per usage-limit stop, with the reset time', () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    h.watcher.check()
    expect(h.notices).toHaveLength(1)
    const n = h.notices[0] as Extract<Notice, { type: 'session_limit' }>
    expect(n).toMatchObject({ type: 'session_limit', where: 'VS Code', window: 'five_hour' })
    expect(n.chat.sessionId).toBe('vscode-1')
    expect(n.at).toBe(parseResetText(LIMIT_TEXT, h.now()))
    h.advance(30_000)
    h.watcher.check()
    expect(h.notices).toHaveLength(1)
  })

  test('a later stop in the same chat is a new notice', () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    h.watcher.check()
    h.advance(10 * 60_000)
    h.chats.get('vscode-1')!.limit = { text: LIMIT_TEXT, at: h.now() }
    h.watcher.check()
    expect(h.notices).toHaveLength(2)
  })

  test("stays quiet about old stops, chats the queue already has, other kinds of sessions, and when it's off", () => {
    const h = setup()
    h.stopped('old', 45)
    h.stopped('queued', 1)
    h.queued.add('queued')
    h.stopped('background', 1, { kind: 'background' })
    h.watcher.check()
    expect(h.notices).toEqual([])
    h.stopped('fresh', 1)
    h.disable()
    h.watcher.check()
    expect(h.notices).toEqual([])
  })

  test('a chat that carried on after the stop is not reported', () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    h.chats.get('vscode-1')!.limit = null
    h.watcher.check()
    expect(h.notices).toEqual([])
  })
})
