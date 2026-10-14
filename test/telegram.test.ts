import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatSource } from '../src/daemon/chats'
import { FolderMap } from '../src/daemon/folders'
import { Runner, windowName } from '../src/daemon/runner'
import type { LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import type { BotApi, InlineKeyboard, Markup, TgMessage, TgUpdate, TgUser } from '../src/telegram/api'
import { TelegramBridge } from '../src/telegram/bot'
import { KEYS } from '../src/telegram/ui'
import type { Job } from '../src/shared/types'
import { FakeTmux, makeTree } from './fakes'

const OWNER = 7001
const STRANGER = 9009

interface Sent {
  id: number
  chat: number
  html: string
  markup?: Markup
}

class FakeApi implements BotApi {
  sent: Sent[] = []
  edits: { chat: number; id: number; html: string; keyboard?: InlineKeyboard }[] = []
  answers: { id: string; text?: string }[] = []
  private next = 100

  async getMe(): Promise<TgUser> {
    return { id: 1, is_bot: true, first_name: 'cq', username: 'cq_test_bot' }
  }
  getUpdates(): Promise<never> {
    return new Promise(() => {}) // the tests feed updates through handle()
  }
  /** Plays Telegram being unreachable. */
  down = false
  async sendMessage(chat: number, html: string, markup?: Markup): Promise<TgMessage> {
    if (this.down) throw new Error('telegram sendMessage: 0 network is down')
    const id = this.next++
    this.sent.push({ id, chat, html, markup })
    return { message_id: id, chat: { id: chat, type: 'private' }, date: 0, text: html }
  }
  async editMessageText(chat: number, id: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    this.edits.push({ chat, id, html, keyboard })
  }
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text })
  }
  documents: { chat: number; filename: string; content: string }[] = []
  async sendDocument(chat: number, filename: string, content: string): Promise<TgMessage> {
    this.documents.push({ chat, filename, content })
    return { message_id: this.next++, chat: { id: chat, type: 'private' }, date: 0 }
  }
  async setMyCommands(): Promise<void> {}

  /** What a message shows now: its latest edit, or what was sent. */
  view(id: number): { html: string; keyboard: InlineKeyboard } {
    const edit = [...this.edits].reverse().find(e => e.id === id)
    if (edit) return { html: edit.html, keyboard: edit.keyboard ?? [] }
    const msg = this.sent.find(m => m.id === id)!
    return { html: msg.html, keyboard: msg.markup && 'inline_keyboard' in msg.markup ? msg.markup.inline_keyboard : [] }
  }
  last(): Sent {
    return this.sent.at(-1)!
  }
}

function button(keyboard: InlineKeyboard, label: string | RegExp): string {
  for (const row of keyboard) {
    for (const b of row) if (typeof label === 'string' ? b.text.includes(label) : label.test(b.text)) return b.callback_data
  }
  throw new Error(`no button ${label} in ${JSON.stringify(keyboard.map(r => r.map(b => b.text)))}`)
}

function setup() {
  let now = Date.UTC(2026, 9, 14, 9, 0)
  const root = makeTree()
  const home = mkdtempSync(join(tmpdir(), 'cq-tg-'))
  let config: Config = {
    ...DEFAULT_CONFIG,
    telegram: { enabled: true, token: 'x', ownerId: null, ownerName: null },
    folders: { roots: [root], maxDepth: 6 },
    defaults: { ...DEFAULT_CONFIG.defaults },
  }
  const store = new Store(':memory:')
  const tmux = new FakeTmux()
  const api = new FakeApi()
  let bridge: TelegramBridge
  // Your other Claude Code chats, and the windows that have them open.
  const chatList: Chat[] = []
  let holders: LiveSession[] = []
  const killed: number[] = []
  const chats: ChatSource = {
    list: folder => chatList.filter(c => c.cwd === folder),
    recent: (page, perPage) => ({ chats: chatList.slice(page * perPage, (page + 1) * perPage), more: chatList.length > (page + 1) * perPage }),
    get: sessionId => chatList.find(c => c.sessionId === sessionId) ?? null,
  }
  const runner = new Runner({
    store,
    tmux,
    notify: n => void bridge.notify(n),
    config: () => config,
    saveConfig: c => {
      config = c
    },
    now: () => now,
    claudePath: '/bin/claude',
    selfCommand: ['/bin/cq'],
    port: 7787,
    home,
    jobsDir: home,
    scripts: { hook: '/h', status: '/s' },
    writeFile: () => {},
    sessionHolders: id => holders.filter(h => h.sessionId === id),
    git: { head: async () => null, diffStat: async () => null, worktree: async () => null, commitAll: async () => false },
    killPid: pid => {
      killed.push(pid)
      holders = holders.filter(h => h.pid !== pid)
    },
    log: () => {},
    sleep: async () => {},
  })
  const folders = new FolderMap({ roots: () => [root], maxDepth: () => 6, cachePath: join(home, 'folders.json'), now: () => now, log: () => {} })
  bridge = new TelegramBridge({
    api,
    store,
    runner,
    folders,
    chats,
    config: () => config,
    saveConfig: c => {
      config = c
    },
    commandContext: () => ({ runner, store, config: () => config, saveConfig: c => (config = c), now: () => now, source: 'cli' }),
    now: () => now,
    log: () => {},
  })
  let updateId = 1
  const from = (id: number) => ({ id, is_bot: false, first_name: id === OWNER ? 'Skanda' : 'Mallory', username: id === OWNER ? 'skanda' : 'mallory' })
  const say = (text: string, user = OWNER) =>
    bridge.handle({ update_id: updateId++, message: { message_id: updateId, from: from(user), chat: { id: user, type: 'private' }, date: 0, text } } as TgUpdate)
  const tap = (data: string, messageId: number, user = OWNER) =>
    bridge.handle({
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: from(user), message: { message_id: messageId, chat: { id: user, type: 'private' }, date: 0, text: 'old text' }, data },
    } as TgUpdate)
  return {
    api,
    bridge,
    runner,
    store,
    tmux,
    root,
    chatList,
    killed,
    setHolders: (h: LiveSession[]) => (holders = h),
    config: () => config,
    say,
    tap,
    now: () => now,
    advance: (ms: number) => (now += ms),
  }
}

type Harness = ReturnType<typeof setup>

async function paired(): Promise<Harness> {
  const h = setup()
  await h.bridge.start()
  await h.say(`/start ${h.bridge.status().pairCode}`)
  return h
}

/** Queues a task in beta from a card and plays the hooks of it starting. */
async function running(h: Harness) {
  await h.say('Do the thing')
  const card = h.api.last().id
  await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
  await h.tap(button(h.api.view(card).keyboard, 'beta ›'), card)
  await h.tap(button(h.api.view(card).keyboard, '✅ Use beta'), card)
  await h.tap(button(h.api.view(card).keyboard, '🗺 Mode'), card)
  await h.tap(button(h.api.view(card).keyboard, /^auto$/), card)
  await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
  await h.runner.tick()
  const job = h.store.active()!
  await h.runner.onHook('SessionStart', job.id, { session_id: job.sessionId!, transcript_path: '/t.jsonl' })
  await h.runner.onHook('UserPromptSubmit', job.id, { permission_mode: 'auto' })
  return job
}

describe('pairing', () => {
  test('only the right code pairs, and then strangers are ignored', async () => {
    const h = setup()
    await h.bridge.start()
    const code = h.bridge.status().pairCode!
    expect(code).toMatch(/^\d{6}$/)
    await h.say('/start 000000', STRANGER)
    expect(h.api.last().html).toContain("doesn't match")
    await h.say(`/start ${code}`)
    expect(h.config().telegram.ownerId).toBe(OWNER)
    expect(h.config().telegram.ownerName).toBe('@skanda')
    expect(h.api.last().html).toContain('Paired')
    expect(h.api.last().markup).toMatchObject({ is_persistent: true })
    const before = h.api.sent.length
    await h.say('rm -rf everything please', STRANGER)
    await h.tap('g:pause', 1, STRANGER)
    expect(h.api.sent.length).toBe(before)
    expect(h.runner.paused).toBe(false)
  })
})

describe('queueing with buttons', () => {
  test('type a prompt, pick folder, model, effort and mode, then queue', async () => {
    const h = await paired()
    await h.say('Add a dark mode toggle')
    const card = h.api.last()
    let view = h.api.view(card.id)
    expect(view.html).toContain('Add a dark mode toggle')
    expect(view.html).toContain('no folder yet')
    expect(button(view.keyboard, 'Pick a folder first')).toBe(button(view.keyboard, '📁 Folder'))

    await h.tap(button(view.keyboard, '📁 Folder'), card.id)
    view = h.api.view(card.id)
    expect(view.html).toContain('3 folders')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(
      expect.arrayContaining(['📦 alpha ›', 'beta ›', 'gamma-web ›']),
    )
    await h.tap(button(view.keyboard, 'gamma-web ›'), card.id)
    view = h.api.view(card.id)
    await h.tap(button(view.keyboard, 'web ›'), card.id)
    view = h.api.view(card.id)
    expect(view.html).toContain('gamma-web/web')
    await h.tap(button(view.keyboard, '✅ Use web'), card.id)

    view = h.api.view(card.id)
    expect(view.html).toContain('gamma-web/web')
    await h.tap(button(view.keyboard, '🧠 Model'), card.id)
    await h.tap(button(h.api.view(card.id).keyboard, 'sonnet'), card.id)
    await h.tap(button(h.api.view(card.id).keyboard, '⚡ Effort'), card.id)
    await h.tap(button(h.api.view(card.id).keyboard, /^low$/), card.id)
    await h.tap(button(h.api.view(card.id).keyboard, '🗺 Mode'), card.id)
    await h.tap(button(h.api.view(card.id).keyboard, /^auto$/), card.id)
    view = h.api.view(card.id)
    expect(view.html).toContain('🗺 auto · 🧠 sonnet · ⚡ low')

    await h.tap(button(view.keyboard, '▶️ Queue'), card.id)
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({
      projectDir: join(h.root, 'gamma-web', 'web'),
      prompt: 'Add a dark mode toggle',
      plan: false,
      execMode: 'auto',
      model: 'sonnet',
      effort: 'low',
      sessionPolicy: 'continue',
      source: 'telegram',
    })
    expect(h.api.view(card.id).html).toContain(`Queued #${job.id}`)
    expect(h.api.answers.at(-1)?.text).toBe(`Queued #${job.id}.`)
    // Tapping the old card again does nothing.
    await h.tap(`d:1:q`, card.id)
    expect(h.store.queued()).toHaveLength(1)
  })

  test('the next prompt starts with your last choices', async () => {
    const h = await paired()
    await h.say('first')
    const first = h.api.last().id
    await h.tap(button(h.api.view(first).keyboard, '📁 Folder'), first)
    await h.tap(button(h.api.view(first).keyboard, 'beta ›'), first)
    await h.tap(button(h.api.view(first).keyboard, '✅ Use beta'), first)
    await h.tap(button(h.api.view(first).keyboard, '🧠 Model'), first)
    await h.tap(button(h.api.view(first).keyboard, 'haiku'), first)
    await h.tap(button(h.api.view(first).keyboard, '▶️ Queue'), first)

    await h.say('second')
    const view = h.api.view(h.api.last().id)
    expect(view.html).toContain('beta')
    expect(view.html).toContain('🧠 haiku')
    await h.tap(button(view.keyboard, '▶️ Queue'), h.api.last().id)
    expect(h.store.queued().map(j => [j.prompt, j.model])).toEqual([
      ['first', 'haiku'],
      ['second', 'haiku'],
    ])
  })

  test('search picks a deep folder', async () => {
    const h = await paired()
    await h.say('Fix the button styles')
    const card = h.api.last().id
    await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
    await h.tap(button(h.api.view(card).keyboard, '🔍 Search'), card)
    await h.say('comp')
    const results = h.api.last()
    const view = h.api.view(results.id)
    expect(view.html).toContain('comp')
    await h.tap(button(view.keyboard, 'alpha/src/components'), results.id)
    expect(h.api.view(results.id).html).toContain('alpha/src/components')
    // The search is over: the next message becomes a new prompt, not another search.
    await h.say('another task')
    expect(h.api.view(h.api.last().id).html).toContain('another task')
  })

  test('➕ New task: folder first, then the prompt', async () => {
    const h = await paired()
    await h.say(KEYS.newTask)
    const browser = h.api.last().id
    expect(h.api.view(browser).html).toContain('3 folders')
    await h.tap(button(h.api.view(browser).keyboard, 'beta ›'), browser)
    await h.tap(button(h.api.view(browser).keyboard, 'docs'), browser) // no subfolders: picks it
    expect(h.api.view(browser).html).toContain('Now send the prompt')
    await h.say('Write the docs index')
    const card = h.api.view(h.api.last().id)
    expect(card.html).toContain('Write the docs index')
    expect(card.html).toContain('beta/docs')
    expect(button(card.keyboard, '▶️ Queue')).toMatch(/^d:\d+:q$/)
  })

  test('typed shortcut still works and fills in the card', async () => {
    const h = await paired()
    await h.say(`q ${h.root}/alpha review opus max: Refactor the parser`)
    const view = h.api.view(h.api.last().id)
    expect(view.html).toContain('Refactor the parser')
    expect(view.html).toContain('🗺 review→auto · 🧠 opus · ⚡ max')
    expect(view.html).toContain('alpha')
  })
})

describe('notifications with buttons', () => {

  test('started, then Allow on a permission request', async () => {
    const h = await paired()
    const job = await running(h)
    await Bun.sleep(0)
    expect(h.api.sent.some(m => m.html.includes(`#${job.id} started`))).toBe(true)
    const decision = h.runner.onHook('PermissionRequest', job.id, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await Bun.sleep(0)
    const msg = h.api.last()
    expect(msg.html).toContain('wants to use Bash')
    expect(msg.html).toContain('npm test')
    await h.tap(button(h.api.view(msg.id).keyboard, '✅ Allow'), msg.id)
    expect(await decision).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const after = h.api.view(msg.id)
    expect(after.html).toContain('Approved')
    expect(after.keyboard).toEqual([])
  })

  test("a question's option button answers it", async () => {
    const h = await paired()
    const job = await running(h)
    const reply = h.runner.onHook('PreToolUse', job.id, {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] },
    })
    await Bun.sleep(0)
    const msg = h.api.last()
    await h.tap(button(h.api.view(msg.id).keyboard, 'b) blue'), msg.id)
    expect(await reply).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('"Which color?" → blue') } })
    expect(h.api.view(msg.id).html).toContain('Answered: blue')
  })

  test('➕ Follow up continues the same conversation', async () => {
    const h = await paired()
    const job = await running(h)
    await h.runner.onHook('Stop', job.id, { permission_mode: 'auto', last_assistant_message: 'Done.' })
    h.advance(2000)
    await h.runner.tick()
    h.tmux.windows.get(windowName(job.id))!.dead = true
    await h.runner.tick()
    await Bun.sleep(0)
    const done = h.api.sent.find(m => m.html.includes(`#${job.id} done`))!
    await h.tap(button(h.api.view(done.id).keyboard, 'Follow up'), done.id)
    await h.say('Now add tests for it')
    const card = h.api.view(h.api.last().id)
    expect(card.html).toContain(`follows up #${job.id}`)
    await h.tap(button(card.keyboard, '▶️ Queue'), h.api.last().id)
    const follow = h.store.queued()[0]!
    expect(follow).toMatchObject({ prompt: 'Now add tests for it', projectDir: job.projectDir, sessionPolicy: 'session', sessionId: job.sessionId })
  })

  test('queue view: run next and remove', async () => {
    const h = await paired()
    for (const p of ['one', 'two', 'three']) {
      await h.say(p)
      const id = h.api.last().id
      if (p === 'one') {
        await h.tap(button(h.api.view(id).keyboard, '📁 Folder'), id)
        await h.tap(button(h.api.view(id).keyboard, 'beta ›'), id)
        await h.tap(button(h.api.view(id).keyboard, '✅ Use beta'), id)
      }
      // Later cards already have beta: your last choices carry over.
      await h.tap(button(h.api.view(id).keyboard, '▶️ Queue'), id)
    }
    h.runner.setPaused(true)
    await h.say(KEYS.queue)
    const list = h.api.last().id
    const [one, two, three] = h.store.queued()
    await h.tap(button(h.api.view(list).keyboard, `⬆️ #${three!.id} next`), list)
    expect(h.store.queued().map(j => j.id)).toEqual([three!.id, one!.id, two!.id])
    await h.tap(button(h.api.view(list).keyboard, `🗑 #${one!.id}`), list)
    expect(h.store.queued().map(j => j.id)).toEqual([three!.id, two!.id])
    expect(h.api.view(list).html).not.toContain(`#${one!.id}</b>`)
  })
})

describe('your other chats (VS Code, a terminal)', () => {
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
  const chat = (h: Harness, over: Partial<Chat> = {}): Chat => ({
    sessionId: SID,
    cwd: join(h.root, 'beta'),
    title: 'Claude Code prompt queue optimizer',
    lastPrompt: 'Build the queue',
    lastReply: null,
    updatedAt: h.now() - 3_600_000,
    model: 'claude-opus-5-5',
    permissionMode: 'plan',
    limit: null,
    where: 'VS Code',
    busy: false,
    running: false,
    ...over,
  })

  async function cardInBeta(h: Harness, prompt: string): Promise<number> {
    await h.say(prompt)
    const card = h.api.last().id
    await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
    await h.tap(button(h.api.view(card).keyboard, 'beta ›'), card)
    await h.tap(button(h.api.view(card).keyboard, '✅ Use beta'), card)
    return card
  }

  test("💬 Chat… lists the folder's chats; one open in VS Code is taken over", async () => {
    const h = await paired()
    h.chatList.push(chat(h), chat(h, { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', title: 'Older chat', where: null, updatedAt: h.now() - 7_200_000 }))
    const card = await cardInBeta(h, 'Keep going with the tests')
    await h.tap(button(h.api.view(card).keyboard, '💬 Chat…'), card)
    let view = h.api.view(card)
    expect(view.html).toContain('Chats in beta')
    expect(view.html).toContain('Claude Code prompt queue optimizer</b> · open in VS Code · 1h 00m ago')
    expect(view.html).toContain('“Build the queue”')
    expect(view.html).toContain('Older chat')
    await h.tap(button(view.keyboard, 'Claude Code prompt queue optimizer'), card)
    view = h.api.view(card)
    expect(view.html).toContain('💬 continues “Claude Code prompt queue optimizer” · 🟢 open in VS Code')
    expect(view.html).toContain('🤝 takes it over when it starts')
    await h.tap(button(view.keyboard, '⏳ Wait instead'), card)
    expect(h.api.view(card).html).toContain('⏳ starts once you close it there')
    await h.tap(button(h.api.view(card).keyboard, '🤝 Take over'), card)
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({ prompt: 'Keep going with the tests', projectDir: join(h.root, 'beta'), sessionPolicy: 'session', sessionId: SID })
    expect(job.takeoverAt).toBe(h.now())
  })

  test('🆕 New chat from the list starts a fresh conversation', async () => {
    const h = await paired()
    const card = await cardInBeta(h, 'Start over')
    await h.tap(button(h.api.view(card).keyboard, '💬 Chat…'), card)
    expect(h.api.view(card).html).toContain('No Claude Code chats here yet.')
    await h.tap(button(h.api.view(card).keyboard, '🆕 New chat'), card)
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    expect(h.store.queued()[0]).toMatchObject({ sessionPolicy: 'new', sessionId: null, takeoverAt: null })
  })

  test('a chat that hit the usage limit: ▶️ continues it here after the reset', async () => {
    const h = await paired()
    const c = chat(h, { limit: { text: "You've hit your session limit · resets 4:55am (Asia/Katmandu)", at: h.now() - 60_000 } })
    h.chatList.push(c)
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: h.now() + 3_600_000, window: 'five_hour' })
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Your chat in VS Code hit the 5-hour limit')
    expect(h.api.view(msg).html).toContain('📁 beta · “Claude Code prompt queue optimizer”')
    await h.tap(button(h.api.view(msg).keyboard, '▶️ Continue after the reset'), msg)
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({
      prompt: 'Continue from where you left off.',
      projectDir: c.cwd,
      sessionPolicy: 'session',
      sessionId: SID,
      // It was still planning: the plan comes to you before anything runs.
      plan: true,
      review: true,
      execMode: 'auto',
      model: 'opus',
      isolate: false,
    })
    expect(job.takeoverAt).not.toBeNull()
    expect(h.api.view(msg).html).toContain(`Queued #${job.id}`)
    await h.tap(`w:${SID}:c`, msg)
    expect(h.store.queued()).toHaveLength(1)
    expect(h.api.answers.at(-1)?.text).toBe(`Already queued as #${job.id}.`)
  })

  test('✏️ Follow up… on that notice sends your own prompt into the chat', async () => {
    const h = await paired()
    const c = chat(h)
    h.chatList.push(c)
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: null })
    await h.tap(button(h.api.view(h.api.last().id).keyboard, '✏️ Follow up…'), h.api.last().id)
    expect(h.api.view(h.api.last().id).html).toContain('Now send the prompt')
    await h.say('Also write the docs')
    const card = h.api.last().id
    expect(h.api.view(card).html).toContain('💬 continues “Claude Code prompt queue optimizer”')
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    expect(h.store.queued()[0]).toMatchObject({ prompt: 'Also write the docs', sessionPolicy: 'session', sessionId: SID, projectDir: c.cwd })
    expect(h.store.queued()[0]!.takeoverAt).not.toBeNull()
  })

  test('🤝 Take over on a job waiting for a chat that is open in VS Code', async () => {
    const h = await paired()
    h.setHolders([{ pid: 4321, sessionId: SID, entrypoint: 'claude-vscode', kind: 'interactive', status: 'idle', startedAt: h.now() - 60_000 }])
    const job = h.runner.enqueue({
      projectDir: join(h.root, 'beta'),
      prompt: 'next step',
      plan: false,
      review: false,
      execMode: 'auto',
      model: 'haiku',
      effort: 'low',
      sessionPolicy: 'session',
      sessionId: SID,
      source: 'cli',
    })
    await h.runner.tick()
    await Bun.sleep(0)
    const msg = h.api.sent.find(m => m.html.includes(`#${job.id} is waiting`))!
    expect(msg.html).toContain('its chat is open in VS Code')
    await h.tap(button(h.api.view(msg.id).keyboard, '🤝 Take over'), msg.id)
    expect(h.killed).toEqual([4321])
    expect(h.store.getJob(job.id)!.status).toBe('running')
    expect(h.api.view(msg.id).html).toContain('took the conversation over from VS Code')
  })

  test("a chat in VS Code that will continue at the reset: Don't continue cancels it", async () => {
    const h = await paired()
    const c = chat(h, { limit: { text: 'resets 4:55am', at: h.now() - 60_000 } })
    h.chatList.push(c)
    const due = h.now() + 3_600_000
    h.store.putWatch({ sessionId: SID, cwd: c.cwd, title: c.title, where: 'VS Code', stopAt: h.now() - 60_000, dueAt: due, state: 'waiting', sentAt: null, jobId: null, updatedAt: h.now() })
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: due - 180_000, window: 'five_hour', autoAt: due })
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain("I'll tell it to continue, so it carries on in VS Code")
    await h.tap(button(h.api.view(msg).keyboard, 'Don’t continue'), msg)
    expect(h.store.getWatch(SID)!.state).toBe('cancelled')
    expect(h.api.view(msg).html).toContain("OK, it won't be continued.")
  })

  test('Continue here instead hands a waiting chat to the queue now', async () => {
    const h = await paired()
    const c = chat(h)
    h.chatList.push(c)
    h.store.putWatch({ sessionId: SID, cwd: c.cwd, title: c.title, where: 'VS Code', stopAt: h.now(), dueAt: h.now() + 60_000, state: 'waiting', sentAt: null, jobId: null, updatedAt: h.now() })
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: h.now(), autoAt: h.now() + 60_000 })
    await h.tap(button(h.api.view(h.api.last().id).keyboard, 'Continue here instead'), h.api.last().id)
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({ sessionId: SID, prompt: 'Continue from where you left off.' })
    expect(job.takeoverAt).not.toBeNull()
    expect(h.store.getWatch(SID)).toMatchObject({ state: 'handed', jobId: job.id })
  })

  test('/settings turns automatic continue off', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('and continue it at the reset')
    await h.tap(button(h.api.view(msg).keyboard, '▶️ Auto-continue ✓'), msg)
    expect(h.config().autoContinueChats).toBe(false)
    expect(h.api.view(msg).html).not.toContain('and continue it at the reset')
  })

  test('/settings turns watching your other chats off', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Other chats: I tell you')
    await h.tap(button(h.api.view(msg).keyboard, '👀 Watching other chats ✓'), msg)
    expect(h.config().watchSessions).toBe(false)
    expect(h.api.view(msg).html).toContain('Other chats: not watched')
  })
})

describe('every session from your phone', () => {
  const SID = 'dddddddd-1111-2222-3333-444444444444'
  const chat = (h: Harness, over: Partial<Chat> = {}): Chat => ({
    sessionId: SID,
    cwd: join(h.root, 'beta'),
    title: 'Dark mode for settings',
    lastPrompt: 'Add a dark mode toggle',
    lastReply: 'Added the toggle to the settings page.',
    updatedAt: h.now() - 600_000,
    model: 'claude-sonnet-5-5',
    permissionMode: 'auto',
    limit: null,
    where: null,
    busy: false,
    running: false,
    ...over,
  })

  test('💬 Chats → open one → ✍️ Write here: what you type goes into that chat, in order, until you leave', async () => {
    const h = await paired()
    h.chatList.push(chat(h), chat(h, { sessionId: 'eeeeeeee-1111-2222-3333-444444444444', title: 'Older chat', where: 'VS Code' }))
    await h.say(KEYS.chats)
    const list = h.api.last().id
    expect(h.api.view(list).html).toContain('Dark mode for settings')
    expect(h.api.view(list).html).toContain('📁 beta')
    await h.tap(button(h.api.view(list).keyboard, 'Dark mode for settings'), list)
    expect(h.api.view(list).html).toContain('<b>Claude:</b>')
    expect(h.api.view(list).html).toContain('Added the toggle to the settings page.')
    await h.tap(button(h.api.view(list).keyboard, '✍️ Write here'), list)
    expect(h.api.last().html).toContain('You\'re in “Dark mode for settings”')
    expect(JSON.stringify(h.api.last().markup)).toContain(KEYS.leave)

    await h.say('Now add a test for the toggle')
    await h.say('And mention it in the README')
    expect(h.api.last().html).toContain('➕ Sent to “Dark mode for settings” as #')
    expect(h.store.queued().map(j => [j.prompt, j.sessionId, j.sessionPolicy, j.model])).toEqual([
      ['Now add a test for the toggle', SID, 'session', 'sonnet'],
      ['And mention it in the README', SID, 'session', 'sonnet'],
    ])
    expect(h.store.queued()[0]!.takeoverAt).toBeNull() // not open anywhere: just resumed

    await h.say(KEYS.leave)
    expect(h.api.last().html).toContain('Left “Dark mode for settings”')
    await h.say('Something new')
    expect(h.api.last().html).toContain('Something new') // a new task card again
    expect(h.store.queued()).toHaveLength(2)
  })

  test('a chat open in VS Code: your message takes it over', async () => {
    const h = await paired()
    h.chatList.push(chat(h, { where: 'VS Code' }))
    await h.say('/chats')
    await h.tap(button(h.api.view(h.api.last().id).keyboard, 'Dark mode'), h.api.last().id)
    await h.tap(button(h.api.view(h.api.last().id).keyboard, '✍️ Write here'), h.api.last().id)
    expect(h.api.last().html).toContain("It's open in VS Code")
    await h.say('Keep going')
    expect(h.api.last().html).toContain('it closes there first')
    expect(h.store.queued()[0]!.takeoverAt).not.toBeNull()
  })

  test('the chat the queue is running: your message is typed straight into it', async () => {
    const h = await paired()
    const job = await running(h)
    h.chatList.push(chat(h, { sessionId: job.sessionId!, running: true }))
    h.store.kvSet('telegram.focus', { sessionId: job.sessionId, title: 'Dark mode for settings' })
    await h.say('also handle the system theme')
    expect(h.tmux.windows.get(windowName(job.id))!.input).toEqual(['text:also handle the system theme', 'Enter'])
    expect(h.api.last().html).toContain(`Typed into “Dark mode for settings” (#${job.id})`)
  })

  test('⌨️ Type and 🔘 Keys reach the running task from Peek', async () => {
    const h = await paired()
    const job = await running(h)
    await h.say(KEYS.peek)
    const peek = h.api.last().id
    await h.tap(button(h.api.view(peek).keyboard, '⌨️ Type'), peek)
    await h.say('yes, use the second option')
    expect(h.tmux.windows.get(windowName(job.id))!.input).toEqual(['text:yes, use the second option', 'Enter'])
    await h.tap(button(h.api.view(peek).keyboard, '🔘 Keys'), peek)
    const keys = h.api.last().id
    await h.tap(button(h.api.view(keys).keyboard, '⏎ Enter'), keys)
    await h.tap(button(h.api.view(keys).keyboard, '↓'), keys)
    expect(h.tmux.windows.get(windowName(job.id))!.input.slice(-2)).toEqual(['Enter', 'Down'])
  })

  test("Claude's long final answer arrives in full: a few messages, or a file", async () => {
    const h = await paired()
    const para = 'word '.repeat(150).trim()
    const medium = Array.from({ length: 8 }, (_, i) => `Part ${i + 1}: ${para}`).join('\n\n')
    await h.bridge.notify({ type: 'done', job: { id: 9, projectDir: join(h.root, 'beta'), lastMessage: medium, startedAt: h.now(), finishedAt: h.now(), branch: null } as Job, diff: null, next: null })
    const sent = h.api.sent.slice(-3)
    expect(sent[0]!.html).toContain("Claude's full answer follows.")
    expect(sent[1]!.html).toContain('(1/2)')
    expect(sent[2]!.html).toContain('(2/2)')
    expect(sent[2]!.html).toContain('Part 8')
    const huge = 'x'.repeat(20_000)
    await h.bridge.notify({ type: 'done', job: { id: 10, projectDir: join(h.root, 'beta'), lastMessage: huge, startedAt: h.now(), finishedAt: h.now(), branch: null } as Job, diff: null, next: null })
    expect(h.api.documents).toEqual([{ chat: OWNER, filename: 'reply-10.md', content: huge }])
  })

  test('notices sent while Telegram is unreachable arrive later, in order', async () => {
    const h = await paired()
    h.api.down = true
    await h.bridge.notify({ type: 'empty' })
    await h.bridge.notify({ type: 'setup_warning', message: 'Full Disk Access is missing' })
    const before = h.api.sent.length
    h.api.down = false
    await h.bridge.flushOutbox()
    expect(h.api.sent.slice(before).map(m => m.html)).toEqual(['🏁 Queue empty.', '⚠️ Full Disk Access is missing'])
    await h.bridge.flushOutbox()
    expect(h.api.sent.length).toBe(before + 2)
  })
})
