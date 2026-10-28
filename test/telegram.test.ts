import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatSource } from '../src/daemon/chats'
import type { BranchGit } from '../src/daemon/branches'
import { FolderMap } from '../src/daemon/folders'
import { PowerControl } from '../src/daemon/power'
import { Runner, windowName } from '../src/daemon/runner'
import type { LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import { TelegramError, type BotApi, type InlineKeyboard, type Markup, type MenuButton, type TgMessage, type TgUpdate, type TgUser } from '../src/telegram/api'
import { TelegramBridge } from '../src/telegram/bot'
import { KEYS } from '../src/telegram/ui'
import type { Job } from '../src/shared/types'
import { FakePower, FakeTmux, makeTree } from './fakes'

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
  /** Files "sent" by a test, by file id. */
  files = new Map<string, { name: string; bytes: Uint8Array }>()
  async downloadFile(id: string, maxBytes: number): Promise<{ name: string; bytes: Uint8Array } | null> {
    const f = this.files.get(id)
    return f && f.bytes.length <= maxBytes ? f : null
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
  async editMessageReplyMarkup(chat: number, id: number, keyboard: InlineKeyboard): Promise<void> {
    this.edits.push({ chat, id, html: this.view(id).html, keyboard })
  }
  /** Messages the bot took away (an old card that moved down, one you discarded). */
  deleted: number[] = []
  async deleteMessage(_chat: number, id: number): Promise<void> {
    this.deleted.push(id)
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

function setup(o: { mac?: FakePower; git?: BranchGit } = {}) {
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
    ? new PowerControl({ system: o.mac, store, runner, config: () => config, saveConfig: c => (config = c), notify: n => void bridge.notify(n), now: () => now, log: () => {}, later: run => later.push(run) })
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
    uploadsDir: join(home, 'uploads'),
    now: () => now,
    log: () => {},
    pause: async () => {},
  })
  let updateId = 1
  const from = (id: number) => ({ id, is_bot: false, first_name: id === OWNER ? 'Skanda' : 'Mallory', username: id === OWNER ? 'skanda' : 'mallory' })
  const say = (text: string, user = OWNER) =>
    bridge.handle({ update_id: updateId++, message: { message_id: updateId, from: from(user), chat: { id: user, type: 'private' }, date: 0, text } } as TgUpdate)
  /** A photo or file from you, with an optional caption. */
  const sendFile = (id: string, name: string, bytes: string | Uint8Array, caption?: string) => {
    api.files.set(id, { name, bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes })
    return bridge.handle({ update_id: updateId++, message: { message_id: updateId, from: from(OWNER), chat: { id: OWNER, type: 'private' }, date: 0, document: { file_id: id, file_name: name }, ...(caption ? { caption } : {}) } } as TgUpdate)
  }
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
    sendFile,
    tap,
    now: () => now,
    advance: (ms: number) => (now += ms),
  }
}

type Harness = ReturnType<typeof setup>

async function paired(o: { mac?: FakePower; git?: BranchGit } = {}): Promise<Harness> {
  const h = setup(o)
  await h.bridge.start()
  await h.say(`/start ${h.bridge.status().pairCode}`)
  return h
}

const kb = (h: Harness, id: number) => h.api.view(id).keyboard
const labels = (h: Harness, id: number) => kb(h, id).flat().map(b => b.text)
/** Taps the button labelled `label` (a tab may be marked • when open, a choice ✓ when chosen). */
const press = (h: Harness, id: number, label: string) => h.tap(button(kb(h, id), new RegExp(`^([✓•] )?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)), id)

/** Picks a folder on the card: from the recent ones, else from the browser. */
async function pickFolder(h: Harness, card: number, name: string) {
  await press(h, card, 'Folder')
  let view = h.api.view(card)
  if (view.html.includes('Recent folders')) {
    try {
      return await h.tap(choice(view, new RegExp(`^${name}$`)), card)
    } catch {
      await press(h, card, 'Browse')
      view = h.api.view(card)
    }
  }
  for (const part of name.split('/')) await h.tap(choice(h.api.view(card), new RegExp(`^${part}( \\(git\\))?( ›)?$`)), card)
  if (labels(h, card).some(l => l.endsWith('Use this folder'))) await press(h, card, 'Use this folder')
}

/** Queues a task in beta from a card and plays the hooks of it starting. */
async function running(h: Harness) {
  await h.say('Do the thing')
  const card = h.api.last().id
  await pickFolder(h, card, 'beta')
  await press(h, card, 'How')
  await press(h, card, 'Just do it')
  await press(h, card, 'Auto')
  await press(h, card, 'Queue')
  await h.runner.tick()
  const job = h.store.active()!
  await h.runner.onHook('SessionStart', job.id, { session_id: job.sessionId!, transcript_path: '/t.jsonl' })
  await h.runner.onHook('UserPromptSubmit', job.id, { permission_mode: 'auto' })
  return job
}

/** A card in beta, ready to queue. */
async function card(h: Harness, prompt = 'Do the thing') {
  await h.say(prompt)
  const id = h.api.last().id
  // The next card starts in the folder used last.
  if (h.api.view(id).html.includes('<i>pick one</i>')) await pickFolder(h, id, 'beta')
  return id
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

describe('the look', () => {
  /** Every button on a message, as its words. */
  const words = (h: Harness, id: number) => labels(h, id).join(' | ')
  const EMOJI = /\p{Extended_Pictographic}/u

  test('the keys under the text box are plain words; inside a chat only the first one changes', async () => {
    const h = await paired({ mac: new FakePower() })
    expect(h.api.last().markup).toMatchObject({
      keyboard: [[{ text: 'New task' }, { text: 'Status' }, { text: 'Queue' }], [{ text: 'Tasks' }, { text: 'Chats' }, { text: 'Mac' }], [{ text: 'Settings' }, { text: 'Help' }]],
      input_field_placeholder: 'Type a task for Claude',
    })
    await h.say('Mac')
    expect(h.api.last().html).toContain('<b>This Mac</b>')
    await h.say('Help')
    expect(h.api.last().html).toContain('Plan high, work low.')
  })

  test('no button has an icon, anywhere', async () => {
    const h = await paired({ mac: new FakePower() })
    const job = await running(h)
    const id = await card(h, 'Look at everything')
    for (const tab of ['Folder', 'Chat', 'How', 'Model', 'When', 'More']) {
      await press(h, id, tab)
      expect(words(h, id)).not.toMatch(EMOJI)
    }
    for (const text of ['/status', '/queue', '/tasks', '/chats', '/mac', '/settings', '/sleep', '/peek']) {
      await h.say(text)
      expect(words(h, h.api.last().id)).not.toMatch(EMOJI)
    }
    void h.runner.onHook('PermissionRequest', job.id, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
    await Bun.sleep(0)
    expect(words(h, h.api.last().id)).not.toMatch(EMOJI)
    expect(h.api.last().html).not.toMatch(EMOJI)
  })

  test('buttons keep their places: a choice changes its mark, never where anything is', async () => {
    const h = await paired()
    const id = await card(h)
    const shape = () => kb(h, id).map(row => row.map(b => b.callback_data))
    await press(h, id, 'Model')
    const before = shape()
    // The tabs and Queue are at the bottom, where they were before the tab opened.
    expect(kb(h, id).slice(-3).map(r => r.map(b => b.text))).toEqual([['Folder', 'Chat', 'How'], ['• Model', 'When', 'More'], ['Queue', 'Discard']])
    await press(h, id, 'Low')
    await press(h, id, 'Opus')
    await press(h, id, 'Max')
    expect(shape()).toEqual(before)
    expect(labels(h, id)).toEqual(expect.arrayContaining(['✓ Opus', '✓ Max']))
    // Tapping an open tab closes it; nothing opens on a screen of its own, and there's no Back.
    await press(h, id, 'Model')
    expect(kb(h, id).map(r => r.map(b => b.text))).toEqual([['Folder', 'Chat', 'How'], ['Model', 'When', 'More'], ['Queue', 'Discard']])
    expect(labels(h, id).some(l => /back/i.test(l))).toBe(false)
  })

  test('after an update, the new keys go out once; the old ones still work until then', async () => {
    const h = setup()
    // Paired before the new look.
    h.config().telegram.ownerId = OWNER
    await h.bridge.start()
    expect(h.api.last().html).toContain('The bot has a new look.')
    expect(h.api.last().silent).toBe(true)
    expect(h.api.last().markup).toMatchObject({ keyboard: [[{ text: 'New task' }, { text: 'Status' }, { text: 'Queue' }], [{ text: 'Tasks' }, { text: 'Chats' }, { text: 'Computer' }], [{ text: 'Settings' }, { text: 'Help' }]] })
    expect(h.store.kvGet<number>('telegram.look')).toBe(2)
    await h.say('📊 Status')
    expect(h.api.last().html).toContain('<b>Status</b>')
    await h.say('👀 Peek')
    expect(h.api.last().html).toContain('Nothing is running.')
  })
})

describe('queueing with buttons', () => {
  test('type a prompt, pick folder, model, effort and how, then queue', async () => {
    const h = await paired()
    await h.say('Add a dark mode toggle')
    const card = h.api.last()
    let view = h.api.view(card.id)
    expect(view.html).toContain('Add a dark mode toggle')
    expect(view.html).toContain('Folder: <i>pick one</i>')
    // Each line of the card has a button under it, and Queue.
    expect(view.keyboard.map(r => r.map(b => b.text))).toEqual([['Folder', 'Chat', 'How'], ['Model', 'When', 'More'], ['Queue', 'Discard']])

    await press(h, card.id, 'Folder')
    view = h.api.view(card.id)
    // No recent folders yet: the browser. Every folder is named in full; the buttons are only its numbers.
    expect(view.html).toContain('3 folders')
    expect(view.html).toContain('<b>1.</b> alpha (git) ›')
    expect(view.html).toContain('<b>3.</b> gamma-web ›')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(expect.arrayContaining(['1', '2', '3']))
    await h.tap(choice(view, 'gamma-web'), card.id)
    await h.tap(choice(h.api.view(card.id), /^web/), card.id)
    expect(h.api.view(card.id).html).toContain('<b>gamma-web/web</b>')
    await press(h, card.id, 'Use this folder')
    expect(h.api.view(card.id).html).toContain('Folder: <b>gamma-web/web</b>')

    await press(h, card.id, 'How')
    await press(h, card.id, 'Just do it')
    await press(h, card.id, 'Auto')
    await press(h, card.id, 'Model')
    await press(h, card.id, 'Sonnet')
    await press(h, card.id, 'Low')
    view = h.api.view(card.id)
    expect(view.html).toContain('How: <b>No plan</b> · Auto')
    expect(view.html).toContain('Model: <b>Sonnet · Low</b>')

    await press(h, card.id, 'Queue')
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
    expect(h.api.view(card.id).html).toContain('No plan · Auto · Sonnet, Low')
    expect(h.api.answers.at(-1)?.text).toBe(`Queued #${job.id}.`)
    // Tapping the old card again does nothing.
    await h.tap(`d:1:q`, card.id)
    expect(h.store.queued()).toHaveLength(1)
  })

  test('the next prompt starts with your last choices, and its folder is among the recent ones', async () => {
    const h = await paired()
    const first = await card(h, 'first')
    await press(h, first, 'Model')
    await press(h, first, 'Haiku')
    await press(h, first, 'Queue')

    await h.say('second')
    const id = h.api.last().id
    expect(h.api.view(id).html).toContain('Folder: <b>beta</b>')
    expect(h.api.view(id).html).toContain('Haiku')
    await press(h, id, 'Folder')
    expect(h.api.view(id).html).toContain('Recent folders')
    expect(labels(h, id)).toContain('✓ 1')
    await press(h, id, 'Queue')
    expect(h.store.queued().map(j => [j.prompt, j.model])).toEqual([
      ['first', 'haiku'],
      ['second', 'haiku'],
    ])
  })

  test('search picks a deep folder; the card comes down to where you typed', async () => {
    const h = await paired()
    await h.say('Fix the button styles')
    const card = h.api.last().id
    await press(h, card, 'Folder')
    await press(h, card, 'Search')
    // The text box opens as a reply, with a hint in it.
    expect(h.api.last().markup).toMatchObject({ force_reply: true, input_field_placeholder: 'Part of a folder name' })
    await h.say('comp')
    const results = h.api.last()
    expect(h.api.deleted).toContain(card)
    const view = h.api.view(results.id)
    expect(view.html).toContain('Folders matching “comp”')
    await h.tap(choice(view, 'alpha/src/components'), results.id)
    expect(h.api.view(results.id).html).toContain('Folder: <b>alpha/src/components</b>')
    // The search is over: the next message becomes a new prompt, not another search.
    await h.say('another task')
    expect(h.api.view(h.api.last().id).html).toContain('another task')
  })

  test('New task: folder first, then the prompt', async () => {
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
    expect(button(card.keyboard, 'Queue')).toMatch(/^d:\d+:q$/)
  })

  test('typed shortcut still works and fills in the card', async () => {
    const h = await paired()
    await h.say(`q ${h.root}/alpha review opus max: Refactor the parser`)
    const view = h.api.view(h.api.last().id)
    expect(view.html).toContain('Refactor the parser')
    expect(view.html).toContain('How: <b>Plan, you approve it</b> · Auto')
    expect(view.html).toContain('Plan: <b>Opus · Max</b>')
    expect(view.html).toContain('alpha')
  })

  test('Discard takes the card away', async () => {
    const h = await paired()
    const id = await card(h, 'Never mind this')
    await press(h, id, 'Discard')
    expect(h.api.deleted).toContain(id)
    expect(h.store.queued()).toHaveLength(0)
    await h.tap(button(h.api.view(id).keyboard, 'Queue'), id)
    expect(h.api.answers.at(-1)!.text).toBe('You discarded this one.')
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
    await press(h, msg.id, 'Allow')
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

  test('Follow up continues the same conversation; New task here starts a fresh one in its folder', async () => {
    const h = await paired()
    const job = await running(h)
    await h.runner.onHook('Stop', job.id, { permission_mode: 'auto', last_assistant_message: 'Done.' })
    h.advance(2000)
    await h.runner.tick()
    h.tmux.windows.get(windowName(job.id))!.dead = true
    await h.runner.tick()
    await Bun.sleep(0)
    const done = h.api.sent.find(m => m.html.includes(`#${job.id} done`))!
    await press(h, done.id, 'Follow up')
    expect(h.api.last().markup).toMatchObject({ force_reply: true })
    await h.say('Now add tests for it')
    const card = h.api.last().id
    expect(h.api.view(card).html).toContain(`follows up #${job.id}`)
    await press(h, card, 'Queue')
    const follow = h.store.queued()[0]!
    expect(follow).toMatchObject({ prompt: 'Now add tests for it', projectDir: job.projectDir, sessionPolicy: 'session', sessionId: job.sessionId })

    await press(h, done.id, 'New task here')
    expect(h.api.view(h.api.last().id).html).toContain('Now send the prompt')
    await h.say('Write a changelog')
    const fresh = h.api.last().id
    expect(h.api.view(fresh).html).toContain('Chat: <b>new</b>')
    await press(h, fresh, 'Queue')
    expect(h.store.queued().at(-1)).toMatchObject({ prompt: 'Write a changelog', projectDir: job.projectDir, sessionPolicy: 'new' })
  })

  test('the queue: tap a number, and that task’s buttons show under the numbers and stay with it', async () => {
    const h = await paired()
    for (const p of ['one', 'two', 'three']) await press(h, await card(h, p), 'Queue')
    h.runner.setPaused(true)
    await h.say(KEYS.queue)
    const list = h.api.last().id
    const [one, two, three] = h.store.queued()
    const line = (id: number) => new RegExp(`^<b>#${id}</b>`)
    await h.tap(choice(h.api.view(list), line(three!.id)), list)
    await press(h, list, 'Move up')
    await press(h, list, 'Move up')
    expect(h.store.queued().map(j => j.id)).toEqual([three!.id, one!.id, two!.id])
    expect(labels(h, list).slice(0, 3)).toEqual(['✓ 1', '2', '3'])
    await h.tap(choice(h.api.view(list), line(one!.id)), list)
    await press(h, list, 'Remove')
    expect(h.store.queued()).toHaveLength(3)
    await press(h, list, 'Yes, remove')
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

  test('long titles are whole in the message, and the buttons are only numbers: nothing is cut off', async () => {
    const h = await paired()
    const title = 'Make the checkout faster by moving the price lookup out of the loop, then cache each customer’s total'
    h.chatList.push(chat(h, { title }), chat(h, { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', title: `${title} (second)`, where: null }))
    const id = await card(h, 'Keep going')
    await press(h, id, 'Chat')
    const view = h.api.view(id)
    expect(view.html).toContain(title)
    expect(view.html).toContain(`${title} (second)`)
    expect(labels(h, id)).toEqual(expect.arrayContaining(['1', '2']))
    expect(labels(h, id).some(l => l.includes('…'))).toBe(false)
    // Number 2 is the second chat.
    await h.tap(choice(view, '(second)'), id)
    expect(h.api.view(id).html).toContain('(second)')
  })

  test("the Chat tab lists the folder's chats; one open in VS Code is taken over", async () => {
    const h = await paired()
    h.chatList.push(chat(h), chat(h, { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', title: 'Older chat', where: null, updatedAt: h.now() - 7_200_000 }))
    const id = await card(h, 'Keep going with the tests')
    await press(h, id, 'Chat')
    let view = h.api.view(id)
    expect(view.html).toContain('Chats in beta')
    expect(view.html).toContain('Claude Code prompt queue optimizer</b> · open in VS Code · 1h 00m ago')
    expect(view.html).toContain('“Build the queue”')
    expect(view.html).toContain('Older chat')
    // The message has every title in full; the buttons are only numbers.
    await h.tap(choice(view, 'Claude Code prompt queue'), id)
    view = h.api.view(id)
    expect(view.html).toContain('Chat: <b>continues “Claude Code prompt queue optimizer”</b>, open in VS Code: takes it over when it starts')
    await press(h, id, 'Take over: on')
    expect(h.api.view(id).html).toContain('starts once you close it there')
    await press(h, id, 'Take over: off')
    await press(h, id, 'Queue')
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({ prompt: 'Keep going with the tests', projectDir: join(h.root, 'beta'), sessionPolicy: 'session', sessionId: SID })
    expect(job.takeoverAt).toBe(h.now())
  })

  test('New chat from the Chat tab starts a fresh conversation', async () => {
    const h = await paired()
    const id = await card(h, 'Start over')
    await press(h, id, 'Chat')
    expect(h.api.view(id).html).toContain('No Claude Code chats here yet.')
    await press(h, id, 'New chat')
    await press(h, id, 'Queue')
    expect(h.store.queued()[0]).toMatchObject({ sessionPolicy: 'new', sessionId: null, takeoverAt: null })
  })

  test('a chat that hit the usage limit: Continue after the reset continues it here', async () => {
    const h = await paired()
    const c = chat(h, { limit: { text: "You've hit your session limit · resets 4:55am (Asia/Katmandu)", at: h.now() - 60_000 } })
    h.chatList.push(c)
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: h.now() + 3_600_000, window: 'five_hour' })
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Your chat in VS Code hit the 5-hour limit')
    expect(h.api.view(msg).html).toContain('beta · “Claude Code prompt queue optimizer”')
    await press(h, msg, 'Continue after the reset')
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

  test('Follow up… on that notice sends your own prompt into the chat', async () => {
    const h = await paired()
    const c = chat(h)
    h.chatList.push(c)
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: null })
    await press(h, h.api.last().id, 'Follow up…')
    expect(h.api.view(h.api.last().id).html).toContain('Now send the prompt')
    await h.say('Also write the docs')
    const id = h.api.last().id
    expect(h.api.view(id).html).toContain('continues “Claude Code prompt queue optimizer”')
    await press(h, id, 'Queue')
    expect(h.store.queued()[0]).toMatchObject({ prompt: 'Also write the docs', sessionPolicy: 'session', sessionId: SID, projectDir: c.cwd })
    expect(h.store.queued()[0]!.takeoverAt).not.toBeNull()
  })

  test('Take over on a job waiting for a chat that is open in VS Code', async () => {
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
    await press(h, msg.id, 'Take over')
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
    await press(h, msg, 'Don’t continue')
    expect(h.store.getWatch(SID)!.state).toBe('cancelled')
    expect(h.api.view(msg).html).toContain("OK, it won't be continued.")
  })

  test('Continue here instead hands a waiting chat to the queue now', async () => {
    const h = await paired()
    const c = chat(h)
    h.chatList.push(c)
    h.store.putWatch({ sessionId: SID, cwd: c.cwd, title: c.title, where: 'VS Code', stopAt: h.now(), dueAt: h.now() + 60_000, state: 'waiting', sentAt: null, jobId: null, updatedAt: h.now() })
    await h.bridge.notify({ type: 'session_limit', chat: c, where: 'VS Code', at: h.now(), autoAt: h.now() + 60_000 })
    await press(h, h.api.last().id, 'Continue here instead')
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({ sessionId: SID, prompt: 'Continue from where you left off.' })
    expect(job.takeoverAt).not.toBeNull()
    expect(h.store.getWatch(SID)).toMatchObject({ state: 'handed', jobId: job.id })
  })

  test('Settings turns automatic continue off', async () => {
    const h = await paired()
    await h.say(KEYS.settings)
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('and continue it at the reset')
    await press(h, msg, 'Auto-continue: on')
    expect(h.config().autoContinueChats).toBe(false)
    expect(h.api.view(msg).html).not.toContain('and continue it at the reset')
  })

  test('Settings turns watching your other chats off', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Other chats: <b>watched</b>')
    await press(h, msg, 'Watch chats: on')
    expect(h.config().watchSessions).toBe(false)
    expect(h.api.view(msg).html).toContain('Other chats: <b>not watched</b>')
  })

  test('automatic continue follows from watching: off with it, and turning it on watches', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(labels(h, msg)).toContain('Auto-continue: on')
    await press(h, msg, 'Watch chats: on')
    // Nothing is watched, so there is nothing to continue: it's off, and stays where it was.
    expect(labels(h, msg)).toContain('Auto-continue: off')
    expect(h.config().autoContinueChats).toBe(false)
    // Watching again doesn't turn it back on by itself.
    await press(h, msg, 'Watch chats: off')
    expect(h.config().watchSessions).toBe(true)
    expect(h.config().autoContinueChats).toBe(false)
    await press(h, msg, 'Watch chats: on')
    // Turning it on watches (as before).
    await press(h, msg, 'Auto-continue: off')
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

  test('Chats → open one → Write here: what you type goes into that chat, in order, until you leave', async () => {
    const h = await paired()
    h.chatList.push(chat(h), chat(h, { sessionId: 'eeeeeeee-1111-2222-3333-444444444444', title: 'Older chat', where: 'VS Code' }))
    await h.say(KEYS.chats)
    const list = h.api.last().id
    expect(h.api.view(list).html).toContain('Dark mode for settings')
    expect(h.api.view(list).html).toContain('beta · ')
    await h.tap(choice(h.api.view(list), 'Dark mode for settings'), list)
    expect(h.api.view(list).html).toContain('<b>Claude:</b>')
    expect(h.api.view(list).html).toContain('Added the toggle to the settings page.')
    await press(h, list, 'Write here')
    expect(h.api.last().html).toContain('You\'re in “Dark mode for settings”')
    // Only the first key under the text box changes: it leaves the chat.
    expect(h.api.last().markup).toMatchObject({
      keyboard: [[{ text: KEYS.leave }, { text: 'Status' }, { text: 'Queue' }], [{ text: 'Tasks' }, { text: 'Chats' }, { text: 'Computer' }], [{ text: 'Settings' }, { text: 'Help' }]],
      input_field_placeholder: 'Write to “Dark mode for settings”',
    })

    await h.say('Now add a test for the toggle')
    await h.say('And mention it in the README')
    expect(h.api.last().html).toContain('Sent to “Dark mode for settings” as #')
    expect(h.store.queued().map(j => [j.prompt, j.sessionId, j.sessionPolicy, j.model])).toEqual([
      ['Now add a test for the toggle', SID, 'session', 'sonnet'],
      ['And mention it in the README', SID, 'session', 'sonnet'],
    ])
    expect(h.store.queued()[0]!.takeoverAt).toBeNull() // not open anywhere: just resumed

    await h.say(KEYS.leave)
    expect(h.api.last().html).toContain('Left “Dark mode for settings”')
    expect(h.api.last().markup).toMatchObject({ keyboard: [[{ text: KEYS.newTask }, { text: 'Status' }, { text: 'Queue' }], expect.anything(), expect.anything()] })
    await h.say('Something new')
    expect(h.api.last().html).toContain('Something new') // a new task card again
    expect(h.store.queued()).toHaveLength(2)
  })

  test('a chat open in VS Code: your message takes it over', async () => {
    const h = await paired()
    h.chatList.push(chat(h, { where: 'VS Code' }))
    await h.say('/chats')
    await h.tap(choice(h.api.view(h.api.last().id), 'Dark mode'), h.api.last().id)
    await press(h, h.api.last().id, 'Write here')
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

  test('Type and Keys reach the running task from its screen; the keypad opens on the screen itself', async () => {
    const h = await paired()
    const job = await running(h)
    await h.say('/peek')
    const screen = h.api.last().id
    expect(kb(h, screen).map(r => r.map(b => b.text))).toEqual([['Refresh', 'Type', 'Keys'], ['Stop', 'Kill']])
    await press(h, screen, 'Type')
    await h.say('yes, use the second option')
    expect(h.tmux.windows.get(windowName(job.id))!.input).toEqual(['text:yes, use the second option', 'Enter'])
    await press(h, screen, 'Keys')
    expect(kb(h, screen).map(r => r.map(b => b.text))).toEqual([
      ['1', '2', '3'],
      ['Enter', 'Esc', 'Tab'],
      ['Up', 'Down', 'Shift-Tab'],
      ['Refresh', 'Type', '• Keys'],
      ['Stop', 'Kill'],
    ])
    await press(h, screen, 'Enter')
    h.tmux.windows.get(windowName(job.id))!.screen = 'Picked the second option'
    await press(h, screen, 'Down')
    expect(h.tmux.windows.get(windowName(job.id))!.input.slice(-2)).toEqual(['Enter', 'Down'])
    // The screen shows again, with what the key did, and the keypad stays open.
    expect(h.api.view(screen).html).toContain('Picked the second option')
    expect(labels(h, screen)).toContain('• Keys')
  })

  test("Claude's long final answer arrives in full: a few messages, or a file", async () => {
    const h = await paired()
    const para = 'word '.repeat(150).trim()
    const medium = Array.from({ length: 8 }, (_, i) => `Part ${i + 1}: ${para}`).join('\n\n')
    await h.bridge.notify({ type: 'done', job: { id: 9, projectDir: join(h.root, 'beta'), lastMessage: medium, startedAt: h.now(), finishedAt: h.now(), branch: null } as Job, diff: null, next: null })
    const sent = h.api.sent.slice(-3)
    expect(sent[0]!.html).toStartWith('<b>#9 done</b>')
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
    expect(h.api.sent.slice(before).map(m => m.html)).toEqual(['Queue empty.', 'Full Disk Access is missing'])
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
    expect(view.keyboard.map(r => r.map(b => b.text))).toEqual([['1', '2'], ['Type an answer']])

    await h.tap(choice(view, 'WSL2'), msg.id)
    view = h.api.view(msg.id)
    expect(view.html).toContain('2 of 3')
    expect(view.keyboard[0]!.map(b => b.text)).toEqual(['1', '2', '3'])
    expect(view.keyboard[1]![0]!.text).toBe('Done')

    // A tap on the first question's old button changes nothing.
    await h.tap(`o:${h.store.pendingApprovals()[0]!.code}:0.0`, msg.id)
    expect(h.api.answers.at(-1)!.text).toBe('That question has moved on.')

    await h.tap(choice(view, 'iPhone'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'Desktop'), msg.id)
    view = h.api.view(msg.id)
    expect(view.keyboard[0]!.map(b => b.text)).toEqual(['✓ 1', '2', '✓ 3'])
    expect(view.keyboard[1]![0]!.text).toBe('Done (2 picked)')

    // Back and forward again keeps what was picked.
    await press(h, msg.id, 'Back')
    expect(h.api.view(msg.id).keyboard[0]!.map(b => b.text)).toEqual(['1', '✓ 2'])
    await h.tap(choice(h.api.view(msg.id), 'WSL2'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'iPhone'), msg.id)
    await h.tap(choice(h.api.view(msg.id), 'Desktop'), msg.id)
    await h.tap(button(h.api.view(msg.id).keyboard, /^Done/), msg.id)
    expect(h.api.view(msg.id).html).toContain('3 of 3')

    await press(h, msg.id, 'Type an answer')
    expect(h.api.last().html).toContain('What should the relay be called?')
    expect(h.api.last().markup).toMatchObject({ force_reply: true, input_field_placeholder: 'Your answer' })
    await h.say('the hub')
    expect(await reply).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason:
          'The user is away from the keyboard and answered from their phone: ' +
          '"How should the engine run on Windows?" → WSL2 first (Recommended); "Which platforms first?" → iPhone, Desktop; "What should the relay be called?" → the hub',
      },
    })
    view = h.api.view(msg.id)
    expect(view.html).toContain('asked</b> · answered')
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
    expect(labels(h, last.id)).toEqual(['Approve', 'Ask for changes', 'Approve, then accept edits', 'Approve, then no prompts'])
    await press(h, last.id, 'Approve')
    expect(h.store.getApproval('rvwab')!.status).toBe('allowed')
  })

  test("news that needs nothing from you is silent, and a task's card follows it to the end", async () => {
    const h = await paired()
    const job = await running(h)
    await Bun.sleep(0)
    const card = h.api.sent.find(m => m.html.includes(`#${job.id} started`))!
    expect(card.silent).toBe(true)
    expect(card.html).toContain('No plan · Auto · Sonnet, High')
    const before = h.api.sent.length
    h.store.updateJob(job.id, { planText: '1. Do it\n2. Check it' })
    await h.bridge.notify({ type: 'plan_approved', job: h.store.getJob(job.id)!, choice: 'auto mode' })
    // The plan goes on the card instead of a message of its own.
    expect(h.api.sent.length).toBe(before)
    let view = h.api.view(card.id)
    expect(view.html).toContain('Plan approved (auto mode)')
    expect(view.keyboard.map(r => r.map(b => b.text))).toEqual([['Screen', 'Stop', 'Kill'], ['Full plan']])

    await press(h, card.id, 'Full plan')
    expect(h.api.last().html).toContain('1. Do it')

    h.store.updateJob(job.id, { status: 'done', finishedAt: h.now() + 60_000, startedAt: h.now() })
    await h.bridge.tick()
    view = h.api.view(card.id)
    expect(view.html).toContain('<b>Done</b> in 1m')
    expect(view.keyboard.flat().map(b => b.text)).toEqual(['Full plan'])
  })

  test('a request answered elsewhere or timed out loses its buttons', async () => {
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
    expect(view.html).toContain("Expired: Claude was told you're away.")
    expect(view.keyboard).toEqual([])
  })

  test('Status shows what waits on you, with its buttons, and the limits', async () => {
    const h = await paired()
    const job = await running(h)
    const decision = h.runner.onHook('PermissionRequest', job.id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    await Bun.sleep(0)
    const notice = h.api.last()
    h.store.kvSet('limits', { fiveHour: { usedPct: 62, resetsAt: h.now() + 3_600_000 } })
    await h.say(KEYS.status)
    const status = h.api.last()
    let view = h.api.view(status.id)
    expect(view.html).toContain(`<b>#${job.id}</b> · beta`)
    expect(view.html).toContain('<b>Waiting on you</b>')
    expect(view.html).toContain('▓▓▓▓▓▓░░░░</code> 62%')
    expect(view.keyboard.map(r => r.map(b => b.text))).toEqual([
      [`Allow #${job.id}`, `Deny #${job.id}`],
      [`Screen #${job.id}`, `Stop #${job.id}`, `Kill #${job.id}`],
      ['Refresh', 'Pause'],
    ])
    await press(h, status.id, `Allow #${job.id}`)
    expect(await decision).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    // The status refreshes in place; the request's own message is settled.
    view = h.api.view(status.id)
    expect(view.html).not.toContain('Waiting on you')
    expect(labels(h, status.id)).toContain('Refresh')
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
})

describe('plan with one model and effort, work with another', () => {
  test('plan at max, work at low: in the Model tab, on the card, the task and the next card', async () => {
    const h = await paired()
    const id = await card(h)
    await press(h, id, 'How')
    await press(h, id, 'Plan first')
    await press(h, id, 'Model')
    let view = h.api.view(id)
    expect(view.html).toContain('Plan: <b>Sonnet · High</b>')
    expect(view.html).toContain('Work: <b>same as the plan</b>')
    // Plan or Work picks what the model and effort buttons set; the plan first.
    expect(view.keyboard[0]!.map(b => b.text)).toEqual(['• Plan', 'Work'])
    await press(h, id, 'Max')
    await press(h, id, 'Work')
    expect(h.api.view(id).keyboard[0]!.map(b => b.text)).toEqual(['Plan', '• Work'])
    await press(h, id, 'Low')
    view = h.api.view(id)
    expect(view.html).toContain('Plan: <b>Sonnet · Max</b>')
    expect(view.html).toContain('Work: <b>Sonnet · Low</b>')
    // The work's own choice is ticked, and the Work side stays open.
    expect(labels(h, id)).toEqual(expect.arrayContaining(['✓ Sonnet', '✓ Low', '• Work']))
    await press(h, id, 'Queue')
    expect(h.store.queued()[0]).toMatchObject({ plan: true, effort: 'max', workEffort: 'low', workModel: null })
    expect(h.api.view(id).html).toContain('Plan first · Auto · Sonnet, Max → Sonnet, Low')
    await h.say('another')
    expect(h.api.view(h.api.last().id).html).toContain('Work: <b>Sonnet · Low</b>')
  })

  test('plan with Opus, work with Haiku; the same effort for both', async () => {
    const h = await paired()
    const id = await card(h)
    // New tasks plan first by default: the model has two sides.
    await press(h, id, 'Model')
    await press(h, id, 'Opus')
    await press(h, id, 'Work')
    await press(h, id, 'Haiku')
    expect(h.api.view(id).html).toContain('Plan: <b>Opus · High</b>')
    expect(h.api.view(id).html).toContain('Work: <b>Haiku · High</b>')
    await press(h, id, 'Queue')
    expect(h.store.queued().at(-1)).toMatchObject({ model: 'opus', workModel: 'haiku', plan: true, workEffort: null })
  })

  test('with no plan, Model says how to get one, and has one model and effort', async () => {
    const h = await paired()
    const id = await card(h)
    await press(h, id, 'How')
    await press(h, id, 'Just do it')
    await press(h, id, 'Model')
    expect(h.api.view(id).html).toContain('pick Plan first in How')
    expect(labels(h, id)).not.toContain('Work')
  })

  test('typed efforts can split too: max>medium', async () => {
    const h = await paired()
    await h.say(`q ${h.root}/alpha plan max>medium: Rework the importer`)
    const id = h.api.last().id
    expect(h.api.view(id).html).toContain('Plan: <b>Sonnet · Max</b>')
    expect(h.api.view(id).html).toContain('Work: <b>Sonnet · Medium</b>')
  })
})

describe('live links from Telegram', () => {
  test('Live link in More; the link arrives as a button; a finished task offers Get a live link', async () => {
    const h = await paired()
    const id = await card(h, 'Make the settings page dark')
    await press(h, id, 'More')
    await press(h, id, 'Live link: off')
    expect(h.api.view(id).html).toContain('a live link at the end')
    expect(labels(h, id)).toContain('Live link: on')
    await press(h, id, 'Queue')
    const job = h.store.queued().at(-1)!
    expect(job.wantLink).toBe(true)

    await h.bridge.notify({ type: 'link', job, url: 'https://claude.ai/artifact/abc', title: 'Dark settings', note: null })
    expect(h.api.last().html).toContain('Live link for')
    expect(kb(h, h.api.last().id).flat()[0]).toEqual({ text: 'Open the live link', url: 'https://claude.ai/artifact/abc' })

    // A done task without a link: Get a live link queues one, next, in its conversation.
    const done = { ...job, id: job.id, status: 'done' as const, sessionId: 'eeeeeeee-1111-2222-3333-444444444444', links: null, startedAt: h.now(), finishedAt: h.now(), lastMessage: 'Done.' }
    h.store.updateJob(job.id, { status: 'done', sessionId: done.sessionId, finishedAt: h.now() })
    await h.bridge.notify({ type: 'done', job: done, diff: null, next: null })
    const msg = h.api.last().id
    await press(h, msg, 'Get a live link')
    expect(h.store.queued()[0]).toMatchObject({ linkFor: job.id, sessionId: done.sessionId })
  })
})

describe('the queue from Telegram', () => {
  test('pick a task by its number; Move, Hold and Release it; Clear asks on its own button', async () => {
    const h = await paired()
    const ids = ['one', 'two', 'three'].map(prompt => h.runner.enqueue({ projectDir: h.root, prompt, plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' }).id)
    await h.say('/queue')
    const msg = h.api.last().id
    const rows = () => kb(h, msg).map(r => r.map(b => b.text))
    // Numbers only, until one is picked.
    expect(rows()).toEqual([['1', '2', '3'], ['Refresh', 'Pause', 'Clear']])
    await h.tap(choice(h.api.view(msg), `#${ids[2]}</b>`), msg)
    expect(rows()).toEqual([['1', '2', '✓ 3'], ['Move up', 'Move down', 'Run next'], ['Hold', 'Change', 'Remove'], ['Refresh', 'Pause', 'Clear']])
    await press(h, msg, 'Move up')
    expect(h.store.queued().map(j => j.id)).toEqual([ids[0]!, ids[2]!, ids[1]!])
    // It stays picked as it moves.
    expect(rows()[0]).toEqual(['1', '✓ 2', '3'])
    await h.tap(choice(h.api.view(msg), `#${ids[0]}</b>`), msg)
    await press(h, msg, 'Hold')
    expect(h.store.getJob(ids[0]!)!.onHold).toBe(true)
    expect(h.api.view(msg).html).toContain('on hold')
    await press(h, msg, 'Release')
    expect(h.store.getJob(ids[0]!)!.onHold).toBe(false)
    // Tapping the picked number again puts its buttons away.
    await h.tap(choice(h.api.view(msg), `#${ids[0]}</b>`), msg)
    expect(rows()).toEqual([['1', '2', '3'], ['Refresh', 'Pause', 'Clear']])
    await press(h, msg, 'Clear')
    expect(h.api.answers.at(-1)!.text).toContain('again')
    expect(h.store.queued()).toHaveLength(3)
    expect(rows().at(-1)).toEqual(['Refresh', 'Pause', 'Yes, clear'])
    await press(h, msg, 'Yes, clear')
    expect(h.store.queued()).toHaveLength(0)
    expect(h.api.view(msg).html).toContain('Nothing waiting')
  })

  test('Next on the card: the task goes before everything waiting', async () => {
    const h = await paired()
    h.runner.setPaused(true)
    await press(h, await card(h, 'first'), 'Queue')
    const id = await card(h, 'urgent')
    await press(h, id, 'When')
    await press(h, id, 'Next')
    expect(h.api.view(id).html).toContain('Starts: <b>next, before the others</b>')
    await press(h, id, 'Queue')
    expect(h.store.queued().map(j => j.prompt)).toEqual(['urgent', 'first'])
  })
})

describe('killing a stuck task', () => {
  test('Kill asks on the button itself, then ends the task and says so on the message', async () => {
    const h = await paired()
    const job = await running(h)
    await h.bridge.notify({ type: 'held', job: h.store.getJob(job.id)!, reason: 'no activity for 20m' })
    const msg = h.api.last()
    const kill = button(h.api.view(msg.id).keyboard, /^Kill$/)
    await h.tap(kill, msg.id)
    expect(h.api.answers.at(-1)!.text).toContain('Tap again')
    expect(h.store.getJob(job.id)!.status).toBe('running')
    // The Kill button became its second tap, in the same place.
    expect(labels(h, msg.id)).toEqual(['Screen', 'Continue', `Yes, kill #${job.id}`])
    expect(button(h.api.view(msg.id).keyboard, 'Yes, kill')).toBe(`${kill}!`)
    await press(h, msg.id, `Yes, kill #${job.id}`)
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'cancelled', error: 'Killed by Telegram' })
    expect(h.api.view(msg.id).html).toContain(`Killed #${job.id}`)
    expect(h.api.view(msg.id).keyboard).toEqual([])
    // Its card and the kill itself arrive quietly.
    expect(h.api.sent.some(m => m.html.includes(`#${job.id} killed`) && m.silent)).toBe(true)
  })

  test("on a task's card, Stop turns into Continue in place, and Kill closes the card", async () => {
    const h = await paired()
    const job = await running(h)
    await Bun.sleep(0)
    const card = h.api.sent.find(m => m.html.includes(`#${job.id} started`))!.id
    await press(h, card, 'Stop')
    expect(h.store.getJob(job.id)!.status).toBe('held')
    expect(kb(h, card).map(r => r.map(b => b.text))).toEqual([['Screen', 'Continue', 'Kill']])
    await press(h, card, 'Kill')
    await press(h, card, `Yes, kill #${job.id}`)
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
    expect(h.api.view(card).html).toContain('<b>Stopped</b>')
    expect(kb(h, card)).toEqual([])
  })

  test('/kill ends the running task; /kill <#> a given one; Status has Kill', async () => {
    const h = await paired()
    const job = await running(h)
    await h.say('/status')
    expect(labels(h, h.api.last().id)).toContain(`Kill #${job.id}`)
    await h.say('/kill 999')
    expect(h.api.last().html).toContain('No task #999.')
    await h.say('/kill')
    expect(h.api.last().html).toContain(`Killed #${job.id}.`)
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
    await h.say('/kill')
    expect(h.api.last().html).toContain('Nothing is running.')
  })

  test('with the message’s buttons out of reach, a second tap within a few seconds does it', async () => {
    const h = await paired()
    const job = await running(h)
    // A message from before a restart: its buttons aren't known.
    await h.tap(`j:${job.id}:kill`, 1)
    expect(h.store.getJob(job.id)!.status).toBe('running')
    await h.tap(`j:${job.id}:kill`, 1)
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
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

  test('Status lists every running task, each with its own buttons', async () => {
    const { h, a, b } = await both()
    await h.say('/status')
    const view = h.api.view(h.api.last().id)
    expect(view.html).toContain(`<b>#${a.id}</b>`)
    expect(view.html).toContain(`<b>#${b.id}</b>`)
    expect(view.html).toContain('Up to 2 tasks at once.')
    const kills = view.keyboard.flat().map(x => x.text).filter(t => t.startsWith('Kill'))
    expect(kills).toEqual([`Kill #${a.id}`, `Kill #${b.id}`])
  })

  test('the screen asks which task, with them numbered; a number shows that one', async () => {
    const { h, a, b } = await both()
    await h.say('/peek')
    const picker = h.api.view(h.api.last().id)
    expect(picker.html).toContain('Whose screen?')
    expect(picker.html).toContain(`<b>1.</b> <b>#${a.id}</b>`)
    expect(picker.html).toContain(`<b>2.</b> <b>#${b.id}</b>`)
    expect(picker.keyboard.flat().map(x => x.text)).toEqual(['1', '2'])
    h.tmux.windows.get(windowName(b.id))!.screen = 'Writing the docs…'
    await h.tap(choice(picker, `#${b.id}`), h.api.last().id)
    const shown = h.api.view(h.api.last().id)
    expect(shown.html).toContain(`<b>#${b.id} screen</b>`)
    expect(shown.html).toContain('Writing the docs')
    // Its buttons are about that task: Stop and Kill name it.
    expect(shown.keyboard.flat().map(x => x.callback_data)).toEqual(expect.arrayContaining([`j:${b.id}:stop`, `j:${b.id}:kill`, `g:peek:${b.id}`]))
  })

  test('/kill with several running asks which, with their numbers; a number then its second tap ends that one only', async () => {
    const { h, a, b } = await both()
    await h.say('/kill')
    const picker = h.api.last().id
    expect(h.api.view(picker).html).toContain('Kill which task?')
    await h.tap(choice(h.api.view(picker), `#${b.id}`), picker)
    expect(h.api.answers.at(-1)!.text).toContain(`Tap again to end #${b.id}`)
    await press(h, picker, `Yes, kill #${b.id}`)
    expect([a.id, b.id].map(id => h.store.getJob(id)!.status)).toEqual(['running', 'cancelled'])
    // With one left, /kill needs no number.
    await h.say('/kill')
    expect(h.store.getJob(a.id)!.status).toBe('cancelled')
  })

  test('Settings: Tasks at once, 1 · 2 · 3, from the chat', async () => {
    const h = await paired()
    await h.say('/settings')
    const msg = h.api.last().id
    expect(h.api.view(msg).html).toContain('Tasks at once: <b>1</b>')
    await press(h, msg, '2 at once')
    expect(h.config().parallel).toBe(2)
    expect(h.api.view(msg).html).toContain('Tasks at once: <b>2</b>')
    expect(labels(h, msg)).toContain('✓ 2 at once')
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

describe('awake and asleep, from the bot', () => {
  test('the Mac key: stay awake while tasks run, with the lid closed, or for a while; sleep; no apps', async () => {
    const h = await paired({ mac: new FakePower() })
    await h.say('Mac')
    const msg = h.api.last()
    expect(msg.html).toContain('<b>This Mac</b> · sleeps when idle, as usual')
    expect(msg.html).toContain('While tasks run: <b>on</b>')
    expect(msg.html).toContain('cq awake lid on')
    expect(msg.html).not.toMatch(/quit|☰/i)
    expect(kb(h, msg.id).map(r => r.map(b => b.text))).toEqual([
      ['While tasks run: on', 'Lid closed: off'],
      ['Awake 1h', 'Awake 4h', 'Awake 12h'],
      ['Sleep when done: off', 'Sleep now'],
      ['Refresh', 'Copy the command'],
    ])
    // The setup it needs once at the Mac is a tap away from the clipboard.
    expect(kb(h, msg.id).flat().at(-1)).toEqual({ text: 'Copy the command', copy_text: { text: 'cq awake lid on' } })
    await press(h, msg.id, 'While tasks run: on')
    expect(h.config().keepAwake).toBe(false)
    expect(h.api.view(msg.id).html).toContain('While tasks run: <b>off</b>')
  })

  test('Awake 4h keeps it awake that long, tasks or not; tapping it again stops', async () => {
    const h = await paired({ mac: new FakePower() })
    await h.say('/mac')
    const msg = h.api.last().id
    await press(h, msg, 'Awake 4h')
    expect(h.api.answers.at(-1)!.text).toMatch(/^The Mac stays awake until .+, tasks or not\.$/)
    expect(h.api.view(msg).html).toMatch(/<b>This Mac<\/b> · awake until /)
    expect(h.api.view(msg).html).toContain('For a while: <b>until ')
    expect(kb(h, msg)[1]!.map(b => b.text)).toEqual(['Awake 1h', '✓ Awake 4h', 'Awake 12h'])
    await press(h, msg, 'Awake 4h')
    expect(h.api.view(msg).html).toContain('For a while: <b>off</b>')
    expect(h.api.answers.at(-1)!.text).toBe('The Mac sleeps as usual again when nothing runs.')
  })

  test('/mac on Windows: no lid switch, and it says where Windows decides', async () => {
    const h = await paired({ mac: new FakePower('wsl') })
    await h.say('/mac')
    const msg = h.api.last()
    expect(msg.html).toContain('This PC')
    expect(msg.html).toContain('When I close the lid: Do nothing')
    expect(labels(h, msg.id).some(l => l.startsWith('Lid closed'))).toBe(false)
  })

  test('Sleep now asks on its own button, then sleeps', async () => {
    const sys = new FakePower('linux')
    const h = await paired({ mac: sys })
    await h.say('/mac')
    const msg = h.api.last().id
    await press(h, msg, 'Sleep now')
    expect(h.api.answers.at(-1)!.text).toBe('Tap again to put the computer to sleep.')
    expect(kb(h, msg)[2]!.map(b => b.text)).toEqual(['Sleep when done: off', 'Yes, sleep now'])
    expect(h.later).toHaveLength(0)
    await press(h, msg, 'Yes, sleep now')
    expect(h.api.answers.at(-1)!.text).toBe('Going to sleep.')
    expect(h.api.sent.some(m => m.html.includes('Going to sleep</b> (asked from Telegram)'))).toBe(true)
    h.later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
  })

  test('/sleep: says what sleeping does; Sleep now there needs no second tap', async () => {
    const sys = new FakePower('linux')
    const h = await paired({ mac: sys })
    await h.say('sleep')
    const card = h.api.last()
    expect(card.html).toContain('Put the computer to sleep?')
    await press(h, card.id, 'Sleep now')
    expect(h.api.answers.at(-1)!.text).toBe('Going to sleep.')
    expect(sys.slept).toBe(0)
    h.later.forEach(run => run())
    await Bun.sleep(0)
    expect(sys.slept).toBe(1)
  })

  test('Sleep when done, on and off; with nothing to sleep, a plain no', async () => {
    const h = await paired({ mac: new FakePower() })
    await h.say('/mac')
    const msg = h.api.last()
    await press(h, msg.id, 'Sleep when done: off')
    expect(h.api.answers.at(-1)!.text).toBe('The Mac sleeps once the queue is done.')
    expect(labels(h, msg.id)).toContain('Sleep when done: on')
    await press(h, msg.id, 'Sleep when done: on')
    expect(labels(h, msg.id)).toContain('Sleep when done: off')

    const plain = await paired()
    await plain.say('/mac')
    expect(plain.api.last().html).toContain('nothing here to keep awake or sleep')
  })

  test('Lid closed on a Mac that isn’t set up says what to run there, and changes nothing', async () => {
    const h = await paired({ mac: new FakePower() })
    await h.say('/mac')
    await press(h, h.api.last().id, 'Lid closed: off')
    expect(h.api.answers.at(-1)?.text).toBeTruthy()
    expect(h.config().keepAwakeLidClosed).toBe(false)
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
  test('Change on a queued task: its choices on a card; Save puts them on the task', async () => {
    const h = await paired()
    await running(h)
    const id = await card(h, 'Write the docs')
    // The card starts in the folder used last (beta), so it can be queued as it is.
    expect(h.api.view(id).html).toContain('beta')
    await press(h, id, 'Queue')
    const queued = h.store.queued()[0]!
    await h.say('/queue')
    const list = h.api.last().id
    await h.tap(choice(h.api.view(list), `#${queued.id}</b>`), list)
    await press(h, list, 'Change')
    const edit = h.api.last().id
    expect(h.api.view(edit).html).toContain(`Changing #${queued.id}`)
    expect(kb(h, edit).map(r => r.map(b => b.text))).toEqual([['Prompt', 'How', 'Model'], ['When', 'More'], ['Save', 'Cancel']])
    // A new prompt, another model, and a live link.
    await press(h, edit, 'Prompt')
    await h.say('Write the docs, with examples')
    const shown = h.api.last().id
    expect(h.api.deleted).toContain(edit)
    await press(h, shown, 'Model')
    await press(h, shown, 'Haiku')
    await press(h, shown, 'More')
    await press(h, shown, 'Live link: off')
    await press(h, shown, 'Save')
    expect(h.store.getJob(queued.id)).toMatchObject({ status: 'queued', prompt: 'Write the docs, with examples', model: 'haiku', wantLink: true })
    expect(h.api.view(shown).html).toContain(`Changed #${queued.id}`)
    expect(h.store.queued()).toHaveLength(1)
  })

  test('When: a typed time, shown on the card and kept on the task', async () => {
    const h = await paired()
    const id = await card(h, 'Run the nightly report')
    await press(h, id, 'When')
    expect(h.api.view(id).html).toContain('When it starts')
    await press(h, id, 'Type a time')
    expect(h.api.last().markup).toMatchObject({ force_reply: true })
    await h.say('soonish')
    expect(h.api.last().html).toContain('isn’t a time I can read')
    await h.say('in 2h')
    const shown = h.api.last().id
    expect(h.api.view(shown).html).toContain('Starts: <b>at ')
    await press(h, shown, 'Queue')
    const job = h.store.queued()[0]!
    expect(job.notBefore).toBe(h.now() + 2 * 3600_000)
    expect(h.api.view(shown).html).toContain('Not before')
    // It waits for its time.
    await h.runner.tick()
    expect(h.store.active()).toBeNull()
  })

  test('Merge, and Discard on its second tap, for a task that ran on its own branch', async () => {
    const merged: string[] = []
    const h = await paired({
      git: {
        mergeBranch: async (_dir, branch) => (merged.push(branch), { ok: true, text: `Merged ${branch} into main.` }),
        discardBranch: async (_dir, branch) => (merged.push(`-${branch}`), { ok: true, text: '' }),
        pullRequest: async (_dir, branch) => (merged.push(`pr:${branch}`), { ok: true, text: 'Opened a pull request.', url: 'https://example.test/pr/1' }),
      },
    })
    const job = await running(h)
    h.store.updateJob(job.id, { status: 'done', branch: 'afterhours/1-do-the-thing', finishedAt: h.now() })
    await h.bridge.notify({ type: 'done', job: h.store.getJob(job.id)!, diff: null, next: null })
    const done = h.api.sent.findLast(m => m.html.includes(`#${job.id} done`))!
    await press(h, done.id, 'Discard branch')
    expect(h.api.answers.at(-1)!.text).toContain('Tap again')
    expect(labels(h, done.id)).toContain('Yes, discard')
    expect(merged).toEqual([])
    await press(h, done.id, 'Merge')
    expect(merged).toEqual(['afterhours/1-do-the-thing'])
    expect(h.api.last().html).toContain('Merged afterhours/1-do-the-thing into main.')
    expect(h.store.getJob(job.id)!.branchNote).toBe('Merged afterhours/1-do-the-thing into main.')
  })
})

describe('everything the app has, in the bot', () => {
  test('how it goes about it and what it may do are chosen apart: plan you approve, then no prompts', async () => {
    const h = await paired()
    const id = await card(h)
    await press(h, id, 'How')
    await press(h, id, 'Plan, I approve')
    await press(h, id, 'No prompts')
    expect(h.api.view(id).html).toContain('How: <b>Plan, you approve it</b> · No prompts')
    await press(h, id, 'Queue')
    expect(h.store.queued()[0]).toMatchObject({ plan: true, review: true, execMode: 'bypassPermissions' })
    // Only answering: nothing to permit, so no permission is ticked, and tapping one says why.
    const second = await card(h, 'What does it do?')
    await press(h, second, 'How')
    await press(h, second, 'Only answer')
    expect(labels(h, second).filter(l => l.startsWith('✓'))).toEqual(['✓ Only answer'])
    await press(h, second, 'No prompts')
    expect(h.api.answers.at(-1)!.text).toContain('never asks')
    expect(h.api.view(second).html).toContain('How: <b>Only answers</b>')
  })

  test('Starts: every day, after another task, a time limit, and the card says so', async () => {
    const h = await paired()
    await running(h)
    const id = await card(h, 'Nightly checks')
    await press(h, id, 'When')
    await press(h, id, 'Every day at…')
    await h.say('02:30')
    const shown = h.api.last().id
    expect(h.api.view(shown).html).toContain('every day at 02:30')
    expect(labels(h, shown)).toContain('✓ Every day 02:30')
    await press(h, shown, 'More')
    await press(h, shown, '1h')
    expect(h.api.view(shown).html).toContain('stops after 1 h of work')
    await press(h, shown, 'Queue')
    const job = h.store.queued()[0]!
    expect(job).toMatchObject({ repeatDaily: 150, maxMinutes: 60 })
    expect(new Date(job.notBefore!).getHours() * 60 + new Date(job.notBefore!).getMinutes()).toBe(150)

    const second = await card(h, 'Then the report')
    await press(h, second, 'When')
    await h.tap(choice(h.api.view(second), 'Do the thing'), second)
    expect(h.api.view(second).html).toContain('after #')
    await press(h, second, 'Queue')
    expect(h.store.queued().at(-1)!.afterJob).toBe(h.store.active()!.id)
  })

  test('Starts: at the limit reset, when it is known', async () => {
    const h = await paired()
    const id = await card(h)
    await press(h, id, 'When')
    expect(h.api.view(id).html).toContain('not known right now')
    await press(h, id, 'At the reset')
    expect(h.api.answers.at(-1)!.text).toContain('doesn’t know when the limit resets')
    h.store.kvSet('limits', { fiveHour: { usedPct: 80, resetsAt: h.now() + 2 * 3_600_000 } })
    await press(h, id, 'At the reset')
    expect(h.api.view(id).html).toContain('when the 5-hour limit resets')
    expect(labels(h, id)).toContain('✓ At the reset')
    await press(h, id, 'Queue')
    expect(h.store.queued()[0]!.notBefore).toBe(h.now() + 2 * 3_600_000)
  })

  test('three ways: three branches to compare, then keep one', async () => {
    const merged: string[] = []
    const h = await paired({
      git: {
        mergeBranch: async (_d, branch) => (merged.push(`+${branch}`), { ok: true, text: `Merged ${branch}.` }),
        discardBranch: async (_d, branch) => (merged.push(`-${branch}`), { ok: true, text: '' }),
        pullRequest: async () => ({ ok: true, text: 'pr' }),
      },
    })
    const id = await card(h, 'Redo the parser')
    await press(h, id, 'More')
    await press(h, id, '3 models')
    await press(h, id, 'Queue')
    const jobs = h.store.queued()
    expect(jobs).toHaveLength(3)
    expect(new Set(jobs.map(j => j.group)).size).toBe(1)
    expect(jobs.every(j => j.isolate)).toBe(true)
    expect(new Set(jobs.map(j => j.model)).size).toBe(3)
    expect(h.api.view(id).html).toContain('Each on its own branch')
    // Finish them one by one: one message to compare, after the last.
    const finish = async (j: (typeof jobs)[number]) => {
      h.store.updateJob(j.id, { status: 'done', branch: `afterhours/${j.id}-x`, summary: `did it ${j.model}`, finishedAt: h.now() })
      await h.bridge.notify({ type: 'done', job: h.store.getJob(j.id)!, diff: null, next: null })
    }
    await finish(jobs[0]!)
    await finish(jobs[1]!)
    expect(h.api.sent.some(m => m.html.includes('The three ways are done'))).toBe(false)
    await finish(jobs[2]!)
    const compare = h.api.sent.find(m => m.html.includes('The three ways are done'))!
    expect(compare.html).toContain('did it')
    await press(h, compare.id, `Keep #${jobs[1]!.id}`)
    expect(merged).toEqual([])
    await press(h, compare.id, `Yes, keep #${jobs[1]!.id}`)
    expect(merged).toEqual([`-afterhours/${jobs[0]!.id}-x`, `+afterhours/${jobs[1]!.id}-x`, `-afterhours/${jobs[2]!.id}-x`])
  })

  test('a photo or file goes on the card as an attachment, and its caption is the prompt', async () => {
    const h = await paired()
    await h.sendFile('f1', 'notes.txt', 'remember this', 'Summarise the notes')
    const id = h.api.last().id
    expect(h.api.view(id).html).toContain('Summarise the notes')
    expect(h.api.view(id).html).toContain('1 file for Claude to read')
    // A second file lands on the same card, which comes down to where you are.
    await h.sendFile('f2', 'more.txt', 'and this')
    const again = h.api.last().id
    expect(h.api.deleted).toContain(id)
    expect(h.api.view(again).html).toContain('2 files for Claude to read')
    await pickFolder(h, again, 'beta')
    await press(h, again, 'Queue')
    const job = h.store.queued()[0]!
    expect(job.attachments).toHaveLength(2)
    expect(readFileSync(job.attachments![0]!, 'utf8')).toBe('remember this')
    // Too big a file is refused, not saved.
    await h.sendFile('big', 'big.bin', new Uint8Array(6 * 1024 * 1024))
    expect(h.api.last().html).toContain('bigger than 5 MB')
  })

  test('a permission request offers Claude Code’s own “stop asking” rules; a plan can be approved then no prompts', async () => {
    const h = await paired()
    const job = await running(h)
    await h.bridge.notify({ type: 'permission', job: h.store.getJob(job.id)!, code: 'permrl', tool: 'Bash', detail: 'npm test', minutes: 15, suggestions: ['Always allow commands starting with npm test in this project'] })
    const msg = h.api.last()
    expect(msg.html).toContain('Or allow it and stop asking')
    expect(msg.html).toContain('npm test in this project')
    expect(kb(h, msg.id).flat().some(b => b.callback_data === 'a:permrl:r0')).toBe(true)
    await h.bridge.notify({ type: 'plan_review', job: h.store.getJob(job.id)!, code: 'rvwmd' })
    expect(button(kb(h, h.api.last().id), 'Approve, then no prompts')).toBe('a:rvwmd:my')
  })

  test('Tasks lists the finished ones; words find one; a number opens it', async () => {
    const h = await paired()
    const spec = (prompt: string) => ({ projectDir: join(h.root, 'beta'), prompt, plan: false, review: false, execMode: 'auto' as const, model: 'opus', effort: 'high' as const, sessionPolicy: 'new' as const, source: 'cli' })
    const a = h.store.addJob(spec('Fix the flaky test'), h.now())
    const b = h.store.addJob(spec('Write the changelog'), h.now())
    h.store.updateJob(a.id, { status: 'done', lastMessage: 'Fixed.', finishedAt: h.now() })
    h.store.updateJob(b.id, { status: 'failed', error: 'It broke.', finishedAt: h.now() })
    await h.say(KEYS.tasks)
    const list = h.api.last()
    expect(list.html).toContain('<b>Tasks</b>')
    expect(list.html).toContain('Fix the flaky test')
    expect(list.html).toContain('Write the changelog')
    await press(h, list.id, 'Search')
    await h.say('flaky')
    const found = h.api.last()
    expect(found.html).toContain('matching “flaky”')
    expect(found.html).not.toContain('changelog')
    await h.tap(button(kb(h, found.id), /^1$/), found.id)
    expect(h.api.last().html).toContain(`#${a.id} done`)
  })
})
