import { describe, expect, test } from 'bun:test'
import { CONTINUE_INBOX } from '../src/daemon/chats'
import type { Delivery } from '../src/daemon/inbox'
import { parseResetText } from '../src/daemon/limits'
import type { Notice } from '../src/daemon/notify'
import type { Conversation, LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { SENT_WAIT_MS, SessionWatcher } from '../src/daemon/watch'
import type { Job } from '../src/shared/types'

const LIMIT_TEXT = "You've hit your session limit · resets 4:55am (Asia/Katmandu)"
const GRACE = 180_000

function setup(o: { auto?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 14, 21, 20)
  let enabled = true
  let auto = o.auto ?? false
  let live: LiveSession[] = []
  const chats = new Map<string, Conversation>()
  const queued = new Set<string>()
  const notices: Notice[] = []
  const logs: string[] = []
  const delivered: { pid: number; text: string }[] = []
  const enqueued: { sessionId: string; takeover: boolean }[] = []
  let delivery: Delivery = { ok: true }
  const store = new Store(':memory:')
  const watcher = new SessionWatcher({
    liveSessions: () => live,
    conversation: s => chats.get(s.sessionId) ?? null,
    findConversation: id => chats.get(id) ?? null,
    queued: id => queued.has(id),
    limits: () => ({}),
    store,
    notify: n => notices.push(n),
    enabled: () => enabled,
    autoContinue: () => auto,
    graceMs: () => GRACE,
    deliver: async (s, text) => {
      delivered.push({ pid: s.pid, text })
      return delivery
    },
    enqueue: (chat, takeover) => {
      enqueued.push({ sessionId: chat.sessionId, takeover })
      return { id: 40 + enqueued.length } as Job
    },
    log: line => logs.push(line),
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
      lastReply: null,
      updatedAt: now,
      model: 'claude-opus-5-5',
      permissionMode: 'plan',
      limit: { text: LIMIT_TEXT, at: now - minutesAgo * 60_000 },
    })
  }
  return {
    watcher,
    store,
    notices,
    logs,
    chats,
    queued,
    delivered,
    enqueued,
    stopped,
    now: () => now,
    advance: (ms: number) => (now += ms),
    disable: () => (enabled = false),
    setAuto: (v: boolean) => (auto = v),
    setLive: (l: LiveSession[]) => (live = l),
    live: () => live,
    failDelivery: (error: string) => (delivery = { ok: false, error }),
  }
}

describe('watching your other chats', () => {
  test('one notice per usage-limit stop, with the reset time', async () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    await h.watcher.check()
    expect(h.notices).toHaveLength(1)
    const n = h.notices[0] as Extract<Notice, { type: 'session_limit' }>
    expect(n).toMatchObject({ type: 'session_limit', where: 'VS Code', window: 'five_hour', autoAt: null })
    expect(n.chat.sessionId).toBe('vscode-1')
    expect(n.at).toBe(parseResetText(LIMIT_TEXT, h.now()))
    h.advance(30_000)
    await h.watcher.check()
    expect(h.notices).toHaveLength(1)
  })

  test('a later stop in the same chat is a new notice', async () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    await h.watcher.check()
    h.advance(10 * 60_000)
    h.chats.get('vscode-1')!.limit = { text: LIMIT_TEXT, at: h.now() }
    await h.watcher.check()
    expect(h.notices).toHaveLength(2)
  })

  test("stays quiet about old stops, chats the queue already has, other kinds of sessions, and when it's off", async () => {
    const h = setup()
    h.stopped('old', 45)
    h.stopped('queued', 1)
    h.queued.add('queued')
    h.stopped('background', 1, { kind: 'background' })
    await h.watcher.check()
    expect(h.notices).toEqual([])
    h.stopped('fresh', 1)
    h.disable()
    await h.watcher.check()
    expect(h.notices).toEqual([])
  })

  test('a chat that carried on after the stop is not reported', async () => {
    const h = setup()
    h.stopped('vscode-1', 1)
    h.chats.get('vscode-1')!.limit = null
    await h.watcher.check()
    expect(h.notices).toEqual([])
  })
})

describe('continuing them at the reset', () => {
  /** A chat stopped a minute ago, spotted, with its continue scheduled. */
  async function scheduled() {
    const h = setup({ auto: true })
    h.stopped('vscode-1', 1)
    await h.watcher.check()
    const reset = parseResetText(LIMIT_TEXT, h.now())!
    const n = h.notices[0] as Extract<Notice, { type: 'session_limit' }>
    expect(n.autoAt).toBe(reset + GRACE)
    expect(h.store.getWatch('vscode-1')).toMatchObject({ state: 'waiting', dueAt: reset + GRACE, where: 'VS Code' })
    return { h, due: reset + GRACE }
  }

  test('nothing before the reset; at it, continue is posted into the open chat', async () => {
    const { h, due } = await scheduled()
    h.advance(due - h.now() - 1000)
    await h.watcher.check()
    expect(h.delivered).toEqual([])
    h.advance(1000)
    await h.watcher.check()
    expect(h.delivered).toEqual([{ pid: 100, text: CONTINUE_INBOX }])
    expect(h.store.getWatch('vscode-1')!.state).toBe('sent')
    expect(h.notices.at(-1)).toMatchObject({ type: 'chat_continue', how: 'inbox', where: 'VS Code' })
    // Claude answers: it runs again, and nothing else happens.
    h.chats.get('vscode-1')!.limit = null
    h.advance(30_000)
    await h.watcher.check()
    expect(h.store.getWatch('vscode-1')!.state).toBe('done')
    h.advance(SENT_WAIT_MS)
    await h.watcher.check()
    expect(h.enqueued).toEqual([])
  })

  test("if it doesn't start within 2 minutes of continue, it's taken over here", async () => {
    const { h, due } = await scheduled()
    h.advance(due - h.now())
    await h.watcher.check()
    h.advance(SENT_WAIT_MS - 1000)
    await h.watcher.check()
    expect(h.enqueued).toEqual([])
    h.advance(2000)
    await h.watcher.check()
    expect(h.enqueued).toEqual([{ sessionId: 'vscode-1', takeover: true }])
    expect(h.store.getWatch('vscode-1')).toMatchObject({ state: 'handed', jobId: 41 })
    expect(h.notices.at(-1)).toMatchObject({ type: 'chat_continue', how: 'takeover', jobId: 41 })
  })

  test('the inbox refuses: taken over at once', async () => {
    const { h, due } = await scheduled()
    h.failDelivery('connect ENOENT')
    h.advance(due - h.now())
    await h.watcher.check()
    expect(h.enqueued).toEqual([{ sessionId: 'vscode-1', takeover: true }])
    expect(h.logs.some(l => l.includes('connect ENOENT'))).toBe(true)
  })

  test('it continued by itself before the reset was due: nothing is sent', async () => {
    const { h, due } = await scheduled()
    h.chats.get('vscode-1')!.limit = null
    h.advance(due - h.now())
    await h.watcher.check()
    expect(h.delivered).toEqual([])
    expect(h.store.getWatch('vscode-1')!.state).toBe('done')
  })

  test('working at the reset counts as continued', async () => {
    const { h, due } = await scheduled()
    h.live()[0]!.status = 'busy'
    h.advance(due - h.now())
    await h.watcher.check()
    expect(h.delivered).toEqual([])
    expect(h.store.getWatch('vscode-1')!.state).toBe('done')
  })

  test('closed meanwhile: the queue resumes it, without a take-over', async () => {
    const { h, due } = await scheduled()
    h.setLive([])
    h.advance(due - h.now())
    await h.watcher.check()
    expect(h.delivered).toEqual([])
    expect(h.enqueued).toEqual([{ sessionId: 'vscode-1', takeover: false }])
    expect(h.notices.at(-1)).toMatchObject({ type: 'chat_continue', how: 'resume' })
  })

  test("you said don't, or the queue already has it: left alone", async () => {
    const { h, due } = await scheduled()
    h.store.setWatchState('vscode-1', 'cancelled', h.now())
    h.advance(due - h.now())
    await h.watcher.check()
    expect(h.delivered).toEqual([])
    const again = await scheduled()
    again.h.queued.add('vscode-1')
    again.h.advance(again.due - again.h.now())
    await again.h.watcher.check()
    expect(again.h.delivered).toEqual([])
    expect(again.h.store.getWatch('vscode-1')!.state).toBe('handed')
  })

  test('auto-continue off: you only get the notice', async () => {
    const h = setup({ auto: false })
    h.stopped('vscode-1', 1)
    await h.watcher.check()
    expect(h.store.getWatch('vscode-1')).toBeNull()
    expect((h.notices[0] as Extract<Notice, { type: 'session_limit' }>).autoAt).toBeNull()
  })
})
