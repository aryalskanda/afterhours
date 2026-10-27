import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatSource } from '../src/daemon/chats'
import type { BranchGit } from '../src/daemon/branches'
import { FolderMap } from '../src/daemon/folders'
import { MacControl } from '../src/daemon/mac'
import { Runner, windowName } from '../src/daemon/runner'
import type { LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import { TelegramError, type BotApi, type InlineKeyboard, type Markup, type MenuButton, type TgMessage, type TgUpdate, type TgUser } from '../src/telegram/api'
import { TelegramBridge } from '../src/telegram/bot'
import { KEYS } from '../src/telegram/ui'
import type { Job } from '../src/shared/types'
import { FakeMac, FakeTmux, makeTree } from './fakes'

const OWNER = 7001
const STRANGER = 9009

interface Sent {
  id: number
  chat: number
  html: string
  markup?: Markup
  silent?: boolean
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
  /** Plays Telegram refusing a message's formatting (it returns why, or null to accept it). */
  refuse: (html: string) => string | null = () => null
  async sendMessage(chat: number, html: string, markup?: Markup, o?: { silent?: boolean }): Promise<TgMessage> {
    if (this.down) throw new Error('telegram sendMessage: 0 network is down')
    const refused = this.refuse(html)
    if (refused) throw new TelegramError('sendMessage', 400, `Bad Request: ${refused}`)
    const id = this.next++
    // A copy: a matcher in a test must never reach the bot's own constants (the main keyboard).
    this.sent.push({ id, chat, html, markup: markup ? structuredClone(markup) : undefined, silent: o?.silent })
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
  menus: { chat: number; button: MenuButton }[] = []
  async setChatMenuButton(chat: number, button: MenuButton): Promise<void> {
    this.menus.push({ chat, button })
  }

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
    for (const b of row) if (b.callback_data && (typeof label === 'string' ? b.text.includes(label) : label.test(b.text))) return b.callback_data
  }
  throw new Error(`no button ${label} in ${JSON.stringify(keyboard.map(r => r.map(b => b.text)))}`)
}

/**
 * A numbered choice: the message lists every choice in full ("1. …"), and its button is only the
 * number. This finds the line with `text` in it and gives that number's button.
 */
function choice(view: { html: string; keyboard: InlineKeyboard }, text: string | RegExp): string {
  const lines = view.html.split('\n')
  for (const line of lines) {
    const m = /^<b>(\d+)\.<\/b> (.*)$/.exec(line)
    if (!m || !(typeof text === 'string' ? m[2]!.includes(text) : text.test(m[2]!))) continue
    for (const row of view.keyboard) for (const b of row) if (b.callback_data && b.text.replace(/^[✓☑☐] /, '') === m[1]) return b.callback_data
  }
  throw new Error(`no numbered choice ${text} in ${JSON.stringify(lines)}`)
}

function setup(o: { mac?: FakeMac; git?: BranchGit } = {}) {
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
    rename: () => false,
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
    git: { head: async () => null, diffStat: async () => null, worktree: async () => null, commitAll: async () => false, snapshot: async () => null },
    killPid: pid => {
      killed.push(pid)
      holders = holders.filter(h => h.pid !== pid)
    },
    log: () => {},
    sleep: async () => {},
  })
  const folders = new FolderMap({ roots: () => [root], store, now: () => now, log: () => {}, watch: false })
  const later: (() => void)[] = []
  const mac = o.mac
    ? new MacControl({ system: o.mac, store, runner, notify: n => void bridge.notify(n), now: () => now, log: () => {}, sleep: async () => {}, later: run => later.push(run) })
    : null
  bridge = new TelegramBridge({
    api,
    store,
    runner,
    folders,
    chats,
    mac,
    git: o.git,
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
    /** What runs a moment later (the Mac going to sleep). */
    later,
    config: () => config,
    say,
    tap,
    now: () => now,
    advance: (ms: number) => (now += ms),
  }
}

type Harness = ReturnType<typeof setup>

async function paired(o: { mac?: FakeMac; git?: BranchGit } = {}): Promise<Harness> {
  const h = setup(o)
  await h.bridge.start()
  await h.say(`/start ${h.bridge.status().pairCode}`)
  return h
}

/** Queues a task in beta from a card and plays the hooks of it starting. */
async function running(h: Harness) {
  await h.say('Do the thing')
  const card = h.api.last().id
  await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
  await h.tap(choice(h.api.view(card), 'beta'), card)
  await h.tap(button(h.api.view(card).keyboard, '✅ Use this folder'), card)
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
    // Every folder is named in full in the message; the buttons are only its numbers.
    expect(view.html).toContain('<b>1.</b> 📦 alpha ›')
    expect(view.html).toContain('<b>3.</b> gamma-web ›')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(expect.arrayContaining(['1', '2', '3']))
    await h.tap(choice(view, 'gamma-web'), card.id)
    view = h.api.view(card.id)
    await h.tap(choice(view, /^web/), card.id)
    view = h.api.view(card.id)
    expect(view.html).toContain('gamma-web/web')
    await h.tap(button(view.keyboard, '✅ Use this folder'), card.id)

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
    await h.tap(choice(h.api.view(first), 'beta'), first)
    await h.tap(button(h.api.view(first).keyboard, '✅ Use this folder'), first)
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
    await h.tap(choice(view, 'alpha/src/components'), results.id)
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
    await h.tap(choice(h.api.view(browser), 'beta'), browser)
    await h.tap(choice(h.api.view(browser), 'docs'), browser) // no subfolders: picks it
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
    await h.tap(choice(h.api.view(msg.id), 'blue'), msg.id)
    expect(await reply).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('"Which color?" → blue') } })
    expect(h.api.view(msg.id).html).toContain('<b>Which color?</b>\n→ blue')
    expect(h.api.view(msg.id).keyboard).toEqual([])
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

  test('queue view: move up and remove', async () => {
    const h = await paired()
    for (const p of ['one', 'two', 'three']) {
      await h.say(p)
      const id = h.api.last().id
      if (p === 'one') {
        await h.tap(button(h.api.view(id).keyboard, '📁 Folder'), id)
        await h.tap(choice(h.api.view(id), 'beta'), id)
        await h.tap(button(h.api.view(id).keyboard, '✅ Use this folder'), id)
      }
      // Later cards already have beta: your last choices carry over.
      await h.tap(button(h.api.view(id).keyboard, '▶️ Queue'), id)
    }
    h.runner.setPaused(true)
    await h.say(KEYS.queue)
    const list = h.api.last().id
    const [one, two, three] = h.store.queued()
    await h.tap(button(h.api.view(list).keyboard, `⬆️ ${three!.id}`), list)
    await h.tap(button(h.api.view(list).keyboard, `⬆️ ${three!.id}`), list)
    expect(h.store.queued().map(j => j.id)).toEqual([three!.id, one!.id, two!.id])
    await h.tap(button(h.api.view(list).keyboard, `🗑 ${one!.id}`), list)
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
    await h.tap(choice(h.api.view(card), 'beta'), card)
    await h.tap(button(h.api.view(card).keyboard, '✅ Use this folder'), card)
    return card
  }

  test('long titles are whole in the message, and the buttons are only numbers: nothing is cut off', async () => {
    const h = await paired()
    const title = 'Make the checkout faster by moving the price lookup out of the loop, then cache each customer’s total'
    h.chatList.push(chat(h, { title }), chat(h, { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', title: `${title} (second)`, where: null }))
    const card = await cardInBeta(h, 'Keep going')
    await h.tap(button(h.api.view(card).keyboard, '💬 Chat…'), card)
    const view = h.api.view(card)
    expect(view.html).toContain(title)
    expect(view.html).toContain(`${title} (second)`)
    const labels = view.keyboard.flat().map(b => b.text)
    expect(labels).toEqual(expect.arrayContaining(['1', '2']))
    expect(labels.some(l => l.includes('…'))).toBe(false)
    // Number 2 is the second chat.
    await h.tap(choice(view, '(second)'), card)
    expect(h.api.view(card).html).toContain('(second)')
  })

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
    // The message has every title in full; the buttons are only numbers.
    await h.tap(choice(view, 'Claude Code prompt queue'), card)
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

  test('automatic continue follows from watching: not offered without it, and turned off with it', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).keyboard.flat().map(b => b.text)).toContain('▶️ Auto-continue ✓')
    await h.tap(button(h.api.view(msg).keyboard, '👀 Watching other chats ✓'), msg)
    // Nothing is watched, so there is nothing to continue: the button is gone and the setting with it.
    expect(h.api.view(msg).keyboard.flat().map(b => b.text).some(t => t.includes('Auto-continue'))).toBe(false)
    expect(h.config().autoContinueChats).toBe(false)
    // Watching again doesn't turn it back on by itself.
    await h.tap(button(h.api.view(msg).keyboard, '👀 Watch other chats'), msg)
    expect(h.config().watchSessions).toBe(true)
    expect(h.config().autoContinueChats).toBe(false)
    expect(h.api.view(msg).keyboard.flat().map(b => b.text)).toContain('▶️ Auto-continue')
    // Turning it on watches (as before).
    await h.tap(button(h.api.view(msg).keyboard, '▶️ Auto-continue'), msg)
    expect(h.config()).toMatchObject({ watchSessions: true, autoContinueChats: true })
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
    await h.tap(choice(h.api.view(list), 'Dark mode for settings'), list)
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
    await h.tap(choice(h.api.view(h.api.last().id), 'Dark mode'), h.api.last().id)
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
    expect(sent[0]!.html).toStartWith('✅ <b>#9 done</b>')
    expect(sent[1]!.html).toContain('Part 1 of 2')
    expect(sent[2]!.html).toContain('Part 2 of 2')
    expect(sent[2]!.html).toContain('Part 8')
    // The parts arrive quietly; Follow up comes after the whole answer.
    expect(sent.map(m => m.silent)).toEqual([undefined, true, true])
    expect(JSON.stringify(sent[2]!.markup)).toContain('Follow up')
    const huge = 'x'.repeat(20_000)
    await h.bridge.notify({ type: 'done', job: { id: 10, projectDir: join(h.root, 'beta'), lastMessage: huge, startedAt: h.now(), finishedAt: h.now(), branch: null } as Job, diff: null, next: null })
    expect(h.api.documents).toEqual([{ chat: OWNER, filename: 'answer-10.md', content: huge }])
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

describe('reading and answering on a phone', () => {
  const longDescription = 'The Linux build runs inside WSL2 unchanged, so Windows works from day one; a native engine can come later without changing anything people already set up.'

  test("Claude's questions come one at a time, in full; multi-select ticks; a typed answer goes to its own question", async () => {
    const h = await paired()
    const job = await running(h)
    const reply = h.runner.onHook('PreToolUse', job.id, {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'How should the engine run on Windows?', header: 'Windows', options: [{ label: 'Native Windows now' }, { label: 'WSL2 first (Recommended)', description: longDescription }] },
          { question: 'Which platforms first?', multiSelect: true, options: [{ label: 'iPhone' }, { label: 'Android' }, { label: 'Desktop' }] },
          { question: 'What should the relay be called?', options: [{ label: 'relay' }, { label: 'bridge' }] },
        ],
      },
    })
    await Bun.sleep(0)
    const msg = h.api.last()
    let view = h.api.view(msg.id)
    expect(view.html).toContain('#' + job.id + ' asks</b> · Windows · 1 of 3')
    expect(view.html).toContain(longDescription) // in full, not cut at 120 characters
    // The options are numbered in the message, in full; the buttons are only the numbers.
    expect(view.html).toContain('<b>1.</b> <b>Native Windows now</b>')
    expect(view.html).toContain('<b>2.</b> <b>WSL2 first (Recommended)</b>')
    expect(view.keyboard.map(r => r.map(b => b.text))).toEqual([['1', '2'], ['✍️ Type an answer']])

    await h.tap(choice(view, 'WSL2'), msg.id)
    view = h.api.view(msg.id)
    expect(view.html).toContain('2 of 3')
    expect(view.keyboard[0]!.map(b => b.text)).toEqual(['☐ 1', '☐ 2', '☐ 3'])
    expect(view.keyboard[1]![0]!.text).toBe('✅ Done')

    // A tap on the first question's old button changes nothing.
    await h.tap(`o:${h.store.pendingApprovals()[0]!.code}:0.0`, msg.id)
    expect(h.api.answers.at(-1)!.text).toBe('That question has moved on.')

    await h.tap(choice(view, 'iPhone'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'Desktop'), msg.id)
    view = h.api.view(msg.id)
    expect(view.keyboard[0]!.map(b => b.text)).toEqual(['☑ 1', '☐ 2', '☑ 3'])
    expect(view.keyboard[1]![0]!.text).toBe('✅ Done (2 picked)')

    // Back and forward again keeps what was picked.
    await h.tap(button(view.keyboard, '⬅️ Back'), msg.id)
    expect(h.api.view(msg.id).keyboard[0]!.map(b => b.text)).toEqual(['1', '✓ 2'])
    await h.tap(choice(h.api.view(msg.id), 'WSL2'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'iPhone'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'Desktop'), msg.id)
    await h.tap(button(h.api.view(msg.id).keyboard, '✅ Done'), msg.id)
    expect(h.api.view(msg.id).html).toContain('3 of 3')

    await h.tap(button(h.api.view(msg.id).keyboard, '✍️ Type an answer'), msg.id)
    expect(h.api.last().html).toContain('What should the relay be called?')
    await h.say('the hub')
    expect(await reply).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason:
          'The user is away from the keyboard and answered from their phone: ' +
          '"How should the engine run on Windows?" → WSL2 first (Recommended); "Which platforms first?" → iPhone, Desktop; "What should the relay be called?" → the hub',
      },
    })
    view = h.api.view(msg.id)
    expect(view.html).toContain('✅ answered')
    expect(view.html).toContain('<b>Which platforms first?</b>\n→ iPhone, Desktop')
    expect(view.html).toContain('→ “the hub”')
    expect(view.keyboard).toEqual([])
  })

  test('a long plan to review arrives whole, rendered, with Approve after the last part', async () => {
    const h = await paired()
    const job = await running(h)
    const section = (n: number) => `## Step ${n}\n\n${'- **Do** the `thing` carefully and check it twice.\n'.repeat(20)}`
    const plan = Array.from({ length: 8 }, (_, i) => section(i + 1)).join('\n')
    expect(plan.length).toBeGreaterThan(8000)
    h.store.updateJob(job.id, { planText: plan })
    h.store.addApproval('rvwab', job.id, 'review', null, h.now())
    const before = h.api.sent.length
    await h.bridge.notify({ type: 'plan_review', job: h.store.getJob(job.id)!, code: 'rvwab' })
    const sent = h.api.sent.slice(before)
    expect(sent.length).toBeGreaterThan(2)
    expect(sent[0]!.html).toContain('plan ready for your review')
    const all = sent.map(m => m.html).join('\n')
    for (let n = 1; n <= 8; n++) expect(all).toContain(`<b>Step ${n}</b>`)
    expect(all).toContain('• <b>Do</b> the <code>thing</code>')
    expect(all).not.toContain('##')
    // Only the last part has the buttons.
    expect(sent.slice(0, -1).every(m => !m.markup)).toBe(true)
    const last = sent.at(-1)!
    await h.tap(button(h.api.view(last.id).keyboard, '✅ Approve'), last.id)
    expect(h.store.getApproval('rvwab')!.status).toBe('allowed')
  })

  test("news that needs nothing from you is silent, and a task's card follows it to the end", async () => {
    const h = await paired()
    const job = await running(h)
    await Bun.sleep(0)
    const card = h.api.sent.find(m => m.html.includes(`#${job.id} started`))!
    expect(card.silent).toBe(true)
    const before = h.api.sent.length
    h.store.updateJob(job.id, { planText: '1. Do it\n2. Check it' })
    await h.bridge.notify({ type: 'plan_approved', job: h.store.getJob(job.id)!, choice: 'auto mode' })
    // The plan goes on the card instead of a message of its own.
    expect(h.api.sent.length).toBe(before)
    let view = h.api.view(card.id)
    expect(view.html).toContain('📝 Plan approved (auto mode)')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(['📄 Full plan', '👀 Peek', '⏹ Stop', '🛑 Kill'])

    await h.tap(button(view.keyboard, '📄 Full plan'), card.id)
    expect(h.api.last().html).toContain('1. Do it')

    h.store.updateJob(job.id, { status: 'done', finishedAt: h.now() + 60_000, startedAt: h.now() })
    await h.bridge.tick()
    view = h.api.view(card.id)
    expect(view.html).toContain('✅ <b>Done</b> in 1m')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(['📄 Full plan'])
  })

  test("a request answered elsewhere or timed out loses its buttons", async () => {
    const h = await paired()
    const job = await running(h)
    void h.runner.onHook('PermissionRequest', job.id, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await Bun.sleep(0)
    const msg = h.api.last()
    expect(h.api.view(msg.id).keyboard.length).toBeGreaterThan(0)
    const code = h.store.pendingApprovals()[0]!.code
    h.store.resolveApproval(code, 'expired', null, h.now())
    await h.bridge.tick()
    const view = h.api.view(msg.id)
    expect(view.html).toContain("⏱ Expired: Claude was told you're away.")
    expect(view.keyboard).toEqual([])
  })

  test('📊 Status shows what waits on you, with its buttons, and the limits', async () => {
    const h = await paired()
    const job = await running(h)
    const decision = h.runner.onHook('PermissionRequest', job.id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    await Bun.sleep(0)
    const notice = h.api.last()
    h.store.kvSet('limits', { fiveHour: { usedPct: 62, resetsAt: h.now() + 3_600_000 } })
    await h.say(KEYS.status)
    const status = h.api.last()
    let view = h.api.view(status.id)
    expect(view.html).toContain(`▶️ <b>#${job.id}</b>`)
    expect(view.html).toContain('⏳ <b>Waiting on you</b>')
    expect(view.html).toContain('▓▓▓▓▓▓░░░░</code> 62%')
    await h.tap(button(view.keyboard, '✅ Allow'), status.id)
    expect(await decision).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    // The status refreshes in place; the request's own message is settled.
    view = h.api.view(status.id)
    expect(view.html).not.toContain('Waiting on you')
    expect(view.keyboard.flat().some(b => b.text === '🔄 Refresh')).toBe(true)
    expect(h.api.view(notice.id).keyboard).toEqual([])
    expect(h.api.view(notice.id).html).toContain('Approved')
  })

  test('formatting Telegram refuses goes out as plain text instead of getting lost', async () => {
    const h = await paired()
    h.api.refuse = html => (html.includes('<b>') ? "can't parse entities: unsupported start tag" : null)
    await h.bridge.notify({ type: 'setup_warning', message: 'plain is fine' })
    await h.bridge.notify({ type: 'limit', job: { id: 3, projectDir: join(h.root, 'beta') } as Job, at: null })
    const sent = h.api.last()
    expect(sent.html).not.toContain('<b>')
    expect(sent.html).toContain('#3 hit the')
  })

  test('long folder and chat names get their own rows instead of being cut', async () => {
    const { layout, labelWidth, ROW_COLUMNS } = await import('../src/telegram/ui')
    const b = (text: string) => ({ text, callback_data: text })
    const rows = layout([b('api'), b('web'), b('docs'), b('a-very-long-folder-name-indeed'), b('x')], 2)
    expect(rows.map(r => r.map(x => x.text))).toEqual([['api', 'web'], ['docs'], ['a-very-long-folder-name-indeed'], ['x']])
    for (const row of rows) expect(Math.max(...row.map(x => labelWidth(x.text) + 2)) * row.length).toBeLessThanOrEqual(ROW_COLUMNS)
    expect(labelWidth('😀a')).toBe(3)
  })
})

describe('two models from Telegram', () => {
  test('🧠 Model with a plan: plan with one, work with another; the card says so and the task gets both', async () => {
    const h = await paired()
    await h.say('Do the thing')
    const card = h.api.last().id
    await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
    await h.tap(choice(h.api.view(card), 'beta'), card)
    await h.tap(button(h.api.view(card).keyboard, '✅ Use this folder'), card)
    // New tasks plan first by default: the model has two parts.
    await h.tap(button(h.api.view(card).keyboard, '🧠 Model'), card)
    expect(h.api.view(card).html).toContain('Plan with')
    await h.tap(button(h.api.view(card).keyboard, /^opus$/), card)
    await h.tap(button(h.api.view(card).keyboard, '🧠 Model'), card)
    // The second row of choices is the work model's.
    const work = h.api.view(card).keyboard.flat().find(b => b.callback_data?.endsWith(':w:haiku'))!
    await h.tap(work.callback_data!, card)
    expect(h.api.view(card).html).toContain('🧠 opus → haiku')
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    expect(h.store.queued().at(-1)).toMatchObject({ model: 'opus', workModel: 'haiku', plan: true })
  })
})

describe('live links from Telegram', () => {
  test('🔗 Live link on the card; the link arrives as a button; a finished task offers Get a live link', async () => {
    const h = await paired()
    await h.say('Make the settings page dark')
    const card = h.api.last().id
    await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
    await h.tap(choice(h.api.view(card), 'beta'), card)
    await h.tap(button(h.api.view(card).keyboard, '✅ Use this folder'), card)
    await h.tap(button(h.api.view(card).keyboard, '🔗 Live link'), card)
    expect(h.api.view(card).html).toContain('ends with a live link')
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    const job = h.store.queued().at(-1)!
    expect(job.wantLink).toBe(true)

    await h.bridge.notify({ type: 'link', job, url: 'https://claude.ai/artifact/abc', title: 'Dark settings', note: null })
    expect(h.api.last().html).toContain('Live link for')
    const kb = h.api.last().markup && 'inline_keyboard' in h.api.last().markup! ? (h.api.last().markup as { inline_keyboard: InlineKeyboard }).inline_keyboard : []
    expect(kb.flat()[0]).toEqual({ text: '🔗 Open the live link', url: 'https://claude.ai/artifact/abc' })

    // A done task without a link: Get a live link queues one, next, in its conversation.
    const done = { ...job, id: job.id, status: 'done' as const, sessionId: 'eeeeeeee-1111-2222-3333-444444444444', links: null, startedAt: h.now(), finishedAt: h.now(), lastMessage: 'Done.' }
    h.store.updateJob(job.id, { status: 'done', sessionId: done.sessionId, finishedAt: h.now() })
    await h.bridge.notify({ type: 'done', job: done, diff: null, next: null })
    const msg = h.api.last().id
    await h.tap(button(h.api.view(msg).keyboard, '🔗 Get a live link'), msg)
    expect(h.store.queued()[0]).toMatchObject({ linkFor: job.id, sessionId: done.sessionId })
  })
})

describe('the queue from Telegram', () => {
  test('⬆️ ⬇️ move a task, ⏸ holds it in its place, ▶️ lets it go, 🧹 Clear (twice) empties it', async () => {
    const h = await paired()
    const ids = ['one', 'two', 'three'].map(prompt => h.runner.enqueue({ projectDir: h.root, prompt, plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' }).id)
    await h.say('/queue')
    const msg = h.api.last().id
    let kb = h.api.view(msg).keyboard
    // The first can't go up, the last can't go down.
    expect(kb[0]!.map(b => b.text)).toEqual([`⬇️ ${ids[0]}`, `⏸ ${ids[0]}`, `✏️ ${ids[0]}`, `🗑 ${ids[0]}`])
    expect(kb[2]!.map(b => b.text)).toEqual([`⬆️ ${ids[2]}`, `⏸ ${ids[2]}`, `✏️ ${ids[2]}`, `🗑 ${ids[2]}`])
    await h.tap(button(kb, `⬆️ ${ids[2]}`), msg)
    expect(h.store.queued().map(j => j.id)).toEqual([ids[0]!, ids[2]!, ids[1]!])
    kb = h.api.view(msg).keyboard
    await h.tap(button(kb, `⏸ ${ids[0]}`), msg)
    expect(h.store.getJob(ids[0]!)!.onHold).toBe(true)
    expect(h.api.view(msg).html).toContain('on hold')
    await h.tap(button(h.api.view(msg).keyboard, `▶️ ${ids[0]}`), msg)
    expect(h.store.getJob(ids[0]!)!.onHold).toBe(false)
    await h.tap(button(h.api.view(msg).keyboard, '🧹 Clear'), msg)
    expect(h.api.answers.at(-1)!.text).toContain('again')
    expect(h.store.queued()).toHaveLength(3)
    await h.tap(button(h.api.view(msg).keyboard, '🧹 Clear'), msg)
    expect(h.store.queued()).toHaveLength(0)
    expect(h.api.view(msg).html).toContain('Nothing queued')
  })
})

describe('killing a stuck task', () => {
  test('🛑 Kill asks for a second tap, then ends the task and says so on the message', async () => {
    const h = await paired()
    const job = await running(h)
    await h.bridge.notify({ type: 'held', job: h.store.getJob(job.id)!, reason: 'no activity for 20m' })
    const msg = h.api.last()
    const kill = button(h.api.view(msg.id).keyboard, '🛑 Kill')
    await h.tap(kill, msg.id)
    expect(h.api.answers.at(-1)!.text).toContain('Tap 🛑 Kill again')
    expect(h.store.getJob(job.id)!.status).toBe('running')
    await h.tap(kill, msg.id)
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'cancelled', error: 'Killed by Telegram' })
    expect(h.api.view(msg.id).html).toContain(`Killed #${job.id}`)
    expect(h.api.view(msg.id).keyboard).toEqual([])
    // Its card and the kill itself arrive quietly.
    expect(h.api.sent.some(m => m.html.includes(`#${job.id} killed`) && m.silent)).toBe(true)
  })

  test('/kill ends the running task; /kill <#> a given one; Status has Kill', async () => {
    const h = await paired()
    const job = await running(h)
    await h.say('/status')
    expect(h.api.view(h.api.last().id).keyboard.flat().map(b => b.text)).toContain(`🛑 Kill #${job.id}`)
    await h.say('/kill 999')
    expect(h.api.last().html).toContain('No task #999.')
    await h.say('/kill')
    expect(h.api.last().html).toContain(`Killed #${job.id}.`)
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
    await h.say('/kill')
    expect(h.api.last().html).toContain('Nothing is running.')
  })
})

describe('more than one task at once', () => {
  const spec = (dir: string, prompt: string) => ({ projectDir: dir, prompt, plan: false, review: false, execMode: 'auto' as const, model: 'sonnet', effort: 'low' as const, sessionPolicy: 'new' as const, source: 'test' })
  /** Two tasks running side by side, in different folders. */
  async function both() {
    const h = await paired()
    h.config().parallel = 2
    const a = h.runner.enqueue(spec(join(h.root, 'alpha'), 'Fix the parser'))
    const b = h.runner.enqueue(spec(join(h.root, 'beta'), 'Write the docs'))
    await h.runner.tick()
    await h.runner.tick()
    return { h, a, b }
  }

  test('📊 Status lists every running task, each with its own Kill', async () => {
    const { h, a, b } = await both()
    await h.say('/status')
    const view = h.api.view(h.api.last().id)
    expect(view.html).toContain(`<b>#${a.id}</b>`)
    expect(view.html).toContain(`<b>#${b.id}</b>`)
    expect(view.html).toContain('Up to 2 tasks at once.')
    const kills = view.keyboard.flat().map(x => x.text).filter(t => t.startsWith('🛑'))
    expect(kills).toEqual([`🛑 Kill #${a.id}`, `🛑 Kill #${b.id}`])
  })

  test('👀 Peek asks which task, with them numbered; a number shows that one', async () => {
    const { h, a, b } = await both()
    await h.say('/peek')
    const picker = h.api.view(h.api.last().id)
    expect(picker.html).toContain('Peek at <b>which task?</b>')
    expect(picker.html).toContain(`<b>1.</b> <b>#${a.id}</b>`)
    expect(picker.html).toContain(`<b>2.</b> <b>#${b.id}</b>`)
    expect(picker.keyboard.flat().map(x => x.text)).toEqual(['1', '2'])
    h.tmux.windows.get(windowName(b.id))!.screen = 'Writing the docs…'
    await h.tap(choice(picker, `#${b.id}`), h.api.last().id)
    const shown = h.api.view(h.api.last().id)
    expect(shown.html).toContain(`<b>#${b.id}</b>`)
    expect(shown.html).toContain('Writing the docs')
    // Its buttons are about that task: Stop and Kill name it.
    expect(shown.keyboard.flat().map(x => x.callback_data)).toEqual(expect.arrayContaining([`j:${b.id}:stop`, `j:${b.id}:kill`, `g:peek:${b.id}`]))
  })

  test('/kill with several running asks which, with their numbers; one number then a second tap ends that one only', async () => {
    const { h, a, b } = await both()
    await h.say('/kill')
    const picker = h.api.view(h.api.last().id)
    expect(picker.html).toContain('Kill which task?')
    const kill = choice(picker, `#${b.id}`)
    await h.tap(kill, h.api.last().id)
    expect(h.api.answers.at(-1)!.text).toContain(`Tap 🛑 Kill again to end #${b.id}`)
    await h.tap(kill, h.api.last().id)
    expect([a.id, b.id].map(id => h.store.getJob(id)!.status)).toEqual(['running', 'cancelled'])
    // With one left, /kill needs no number.
    await h.say('/kill')
    expect(h.store.getJob(a.id)!.status).toBe('cancelled')
  })

  test('/settings: Tasks at once, 1 · 2 · 3, from the chat', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Tasks at once: <b>1</b>')
    await h.tap(button(h.api.view(msg).keyboard, '2 at once'), msg)
    expect(h.config().parallel).toBe(2)
    expect(h.api.view(msg).html).toContain('Tasks at once: <b>2</b>')
    expect(h.api.view(msg).keyboard.flat().map(x => x.text)).toContain('✓ 2 at once')
  })

  test('a typed message goes to the task you picked', async () => {
    const { h, a, b } = await both()
    for (const j of [a, b]) {
      const sid = h.store.getJob(j.id)!.sessionId!
      await h.runner.onHook('SessionStart', j.id, { session_id: sid, transcript_path: `/t${j.id}.jsonl` })
      await h.runner.onHook('UserPromptSubmit', j.id, { session_id: sid, permission_mode: 'auto' })
    }
    await h.tap(`g:type:${b.id}`, h.api.last().id)
    await h.say('also add a changelog')
    expect(h.tmux.windows.get(windowName(b.id))!.input).toContain('text:also add a changelog')
    expect(h.tmux.windows.get(windowName(a.id))!.input).not.toContain('text:also add a changelog')
  })
})

describe('the Mac, from the bot', () => {
  test("/mac: what keeps it awake, and quitting an app takes a second tap; one that won't offers Force quit", async () => {
    const sys = new FakeMac()
    const h = await paired({ mac: sys })
    await h.say('/mac')
    const msg = h.api.last()
    expect(msg.html).toContain('Sleep is turned off while Vorssaint runs')
    // The apps are listed in full in the message, and their buttons are only their numbers.
    expect(msg.html).toContain('<b>1.</b> Vorssaint ☰ ☕')
    expect(h.api.view(msg.id).keyboard.flat().map(b => b.text)).toEqual(['😴 Sleep now', '🌙 Sleep when done', '1', '2', '3', '4', '🔄 Refresh'])
    const monosnap = choice(h.api.view(msg.id), 'Monosnap')
    await h.tap(monosnap, msg.id)
    expect(h.api.answers.at(-1)!.text).toBe('Tap again to quit Monosnap.')
    expect(sys.asked).toEqual([])
    await h.tap(monosnap, msg.id)
    expect(h.api.answers.at(-1)!.text).toBe('Quit Monosnap.')
    expect(h.api.view(msg.id).html).not.toContain('Monosnap')

    sys.stubborn.add(19268)
    const mail = choice(h.api.view(msg.id), 'Mail')
    await h.tap(mail, msg.id)
    await h.tap(mail, msg.id)
    const warning = h.api.last()
    expect(warning.html).toContain('Mail is still open')
    const force = button(h.api.view(warning.id).keyboard, 'Force quit Mail')
    await h.tap(force, warning.id)
    await h.tap(force, warning.id)
    expect(h.api.answers.at(-1)!.text).toBe('Force quit Mail.')
  })

  test('/sleep: quits Vorssaint, says the Mac is going to sleep, then it sleeps', async () => {
    const sys = new FakeMac()
    const h = await paired({ mac: sys })
    await h.say('sleep')
    const card = h.api.last()
    expect(card.html).toContain('It quits Vorssaint first')
    await h.tap(button(h.api.view(card.id).keyboard, '😴 Sleep now'), card.id)
    expect(h.api.answers.at(-1)!.text).toBe('Going to sleep.')
    expect(h.api.sent.some(m => m.html.includes('The Mac is going to sleep</b> (asked from Telegram), after quitting Vorssaint'))).toBe(true)
    expect(sys.slept).toBe(0)
    h.later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
  })

  test('🌙 Sleep when done, on and off; without a Mac, a plain no', async () => {
    const h = await paired({ mac: new FakeMac() })
    await h.say('/mac')
    const msg = h.api.last()
    await h.tap(button(h.api.view(msg.id).keyboard, '🌙 Sleep when done'), msg.id)
    expect(h.api.sent.some(m => m.html.includes('The Mac sleeps once the queue is done, after quitting Vorssaint.'))).toBe(true)
    expect(h.api.view(msg.id).keyboard.flat().map(b => b.text)).toContain('🌙 Sleep when done ✓')
    await h.tap(button(h.api.view(msg.id).keyboard, '🌙 Sleep when done ✓'), msg.id)
    expect(h.api.view(msg.id).keyboard.flat().map(b => b.text)).toContain('🌙 Sleep when done')

    const plain = await paired()
    await plain.say('/mac')
    expect(plain.api.last().html).toContain('Only a Mac can do that.')
  })
})

describe('the menu button', () => {
  test('an app button set by an earlier version is put back to the commands, once', async () => {
    const h = await paired()
    h.store.kvSet('telegram.menu', 'https://mac.example.ts.net/?bot=cq_test_bot')
    await h.bridge.tick()
    expect(h.api.menus).toEqual([{ chat: OWNER, button: { type: 'commands' } }])
    await h.bridge.tick()
    expect(h.api.menus).toHaveLength(1)
    // And the bot says nothing about an app, anywhere.
    await h.say('/help')
    expect(h.api.last().html).not.toMatch(/\/app|Open ↗|inside Telegram/)
  })

  test('/app is not a command any more', async () => {
    const h = await paired()
    await h.say('/app')
    expect(h.api.last().html).not.toContain('cq app setup')
  })
})

describe('what the bot does without the app', () => {
  test('✏️ Change on a queued task: its choices on a card; 💾 Save puts them on the task', async () => {
    const h = await paired()
    await running(h)
    await h.say('Write the docs')
    const card = h.api.last().id
    // The card starts in the folder used last (beta), so it can be queued as it is.
    expect(h.api.view(card).html).toContain('beta')
    await h.tap(button(h.api.view(card).keyboard, '▶️ Queue'), card)
    const queued = h.store.queued()[0]!
    await h.say('/queue')
    const list = h.api.last().id
    await h.tap(button(h.api.view(list).keyboard, `✏️ ${queued.id}`), list)
    const edit = h.api.last().id
    expect(h.api.view(edit).html).toContain(`Changing #${queued.id}`)
    const labels = h.api.view(edit).keyboard.flat().map(b => b.text)
    expect(labels).toContain('💾 Save')
    expect(labels).not.toContain('📁 Folder')
    // A new prompt, another model, and a live link.
    await h.tap(button(h.api.view(edit).keyboard, '✏️ Prompt'), edit)
    await h.say('Write the docs, with examples')
    const shown = h.api.last().id
    await h.tap(button(h.api.view(shown).keyboard, '🧠 Model'), shown)
    await h.tap(button(h.api.view(shown).keyboard, /^haiku$/), shown)
    await h.tap(button(h.api.view(shown).keyboard, '🔗 Live link'), shown)
    await h.tap(button(h.api.view(shown).keyboard, '💾 Save'), shown)
    expect(h.store.getJob(queued.id)).toMatchObject({ status: 'queued', prompt: 'Write the docs, with examples', model: 'haiku', wantLink: true })
    expect(h.api.view(shown).html).toContain(`Changed #${queued.id}`)
    expect(h.store.queued()).toHaveLength(1)
  })

  test('⏰ Later: a preset or a typed time, shown on the card and kept on the task', async () => {
    const h = await paired()
    await h.say('Run the nightly report')
    const card = h.api.last().id
    await h.tap(button(h.api.view(card).keyboard, '📁 Folder'), card)
    await h.tap(choice(h.api.view(card), 'beta'), card)
    await h.tap(button(h.api.view(card).keyboard, '✅ Use this folder'), card)
    await h.tap(button(h.api.view(card).keyboard, '⏰ Later'), card)
    expect(h.api.view(card).html).toContain('When may it start?')
    await h.tap(button(h.api.view(card).keyboard, '✍️ Type a time'), card)
    await h.say('soonish')
    expect(h.api.last().html).toContain('isn’t a time I can read')
    await h.say('in 2h')
    const shown = h.api.last().id
    expect(h.api.view(shown).html).toContain('⏰ starts at')
    await h.tap(button(h.api.view(shown).keyboard, '▶️ Queue'), shown)
    const job = h.store.queued()[0]!
    expect(job.notBefore).toBe(h.now() + 2 * 3600_000)
    expect(h.api.view(shown).html).toContain('Not before')
    // It waits for its time.
    await h.runner.tick()
    expect(h.store.active()).toBeNull()
  })

  test('🌿 Merge, and 🗑 Discard on the second tap, for a task that ran on its own branch', async () => {
    const merged: string[] = []
    const h = await paired({
      git: {
        mergeBranch: async (_dir, branch) => (merged.push(branch), { ok: true, text: `Merged ${branch} into main.` }),
        discardBranch: async (_dir, branch) => (merged.push(`-${branch}`), { ok: true, text: '' }),
      },
    })
    const job = await running(h)
    h.store.updateJob(job.id, { status: 'done', branch: 'afterhours/1-do-the-thing', finishedAt: h.now() })
    await h.bridge.notify({ type: 'done', job: h.store.getJob(job.id)!, diff: null, next: null })
    const done = h.api.sent.findLast(m => m.html.includes(`#${job.id} done`))!
    const discard = button(h.api.view(done.id).keyboard, '🗑 Discard branch')
    await h.tap(discard, done.id)
    expect(h.api.answers.at(-1)!.text).toContain('Tap again')
    expect(merged).toEqual([])
    await h.tap(button(h.api.view(done.id).keyboard, '🌿 Merge'), done.id)
    expect(merged).toEqual(['afterhours/1-do-the-thing'])
    expect(h.api.last().html).toContain('Merged afterhours/1-do-the-thing into main.')
    expect(h.store.getJob(job.id)!.branchNote).toBe('Merged afterhours/1-do-the-thing into main.')
  })
})
