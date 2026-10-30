import { randomInt } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { codeRoots, type Config } from '../shared/config'
import { within as inside } from '../shared/paths'
import type { Approval, Effort, Job, JobSpec } from '../shared/types'
import { continueSpec, type ChatSource } from '../daemon/chats'
import { parseQueueText, type CommandContext } from '../daemon/commands'
import { listChildren, parentWithin, relativeToRoots, type FolderMap } from '../daemon/folders'
import { folderLabel, folderPath, suggestProjectFolders, type FolderSuggestion } from '../daemon/folder-suggest'
import { isWsl } from '../platform/os'
import { formatClock } from '../daemon/limits'
import { settleBranch, type BranchGit } from '../daemon/branches'
import type { PowerControl } from '../daemon/power'
import { describeAnswers, type Notice, type Question, type QuestionAnswer } from '../daemon/notify'
import type { Runner } from '../daemon/runner'
import { MAX_UPLOAD_BYTES, saveUpload, withAttachments } from '../daemon/uploads'
import type { Store } from '../daemon/store'
import { refusedFormatting, type BotApi, type InlineKeyboard, type Markup, type ReplyKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from './api'
import { htmlToText, telegramHtmlProblem } from './markdown'
import { LATER, nextClock, parseWhen } from './when'
import { TelegramState, type Choices, type Draft } from './state'
import * as ui from './ui'

export interface TelegramOptions {
  api: BotApi
  store: Store
  runner: Runner
  folders: FolderMap
  /** Your Claude Code conversations, for the card's Chat tab and the usage-limit hand-off. */
  chats: ChatSource
  config: () => Config
  saveConfig: (config: Config) => void
  /** For reusing the text commands' status output. */
  commandContext: () => CommandContext
  /** Staying awake and sleeping; null or missing where there's nothing to sleep (a container). */
  mac?: PowerControl | null
  /** For Merge and Discard on a task that ran on its own branch. */
  git?: BranchGit
  /** Where photos and files you send are kept for a task to read (the apps' uploads folder). */
  uploadsDir?: string
  now: () => number
  log: (line: string) => void
  /** Waits a moment (a key pressed, before the screen is shown again); tests don't wait. */
  pause?: (ms: number) => Promise<void>
  /** Runs something a moment later (tests run it at once). */
  later?: (run: () => void, ms: number) => void
}

/** Something the bot asked you to type next. */
type Pending =
  | { kind: 'prompt'; draftId: number }
  /** When: a time you type for a card. */
  | { kind: 'later'; draftId: number; daily?: boolean }
  | { kind: 'search'; draftId: number }
  /** Tasks: words to find among the finished ones. */
  | { kind: 'tasksearch' }
  /** Project folders → Add: a folder you type. */
  | { kind: 'rootpath' }
  /** An answer you type: to one question of a set (`step`), or to all of them. */
  | { kind: 'answer'; code: string; step?: number }
  | { kind: 'changes'; code: string }
  | { kind: 'followup'; jobId: number }
  /** What you type next goes into this running task (the latest one when no number). */
  | { kind: 'say'; job?: number }

/** The chat you're inside (Chats → Write here): what you type goes into it. */
interface Focus {
  sessionId: string
  title: string
}

export interface TelegramStatus {
  ok: boolean
  bot: string | null
  paired: boolean
  owner: string | null
  pairCode: string | null
  error: string | null
}

const COMMANDS = [
  { command: 'new', description: 'A new task: pick the folder, then send the prompt' },
  { command: 'status', description: "What's running, what waits on you, usage" },
  { command: 'queue', description: 'Waiting tasks: move, hold, change or remove' },
  { command: 'tasks', description: 'Finished tasks: open one, or search' },
  { command: 'chats', description: 'Your Claude Code chats, from any project' },
  { command: 'mac', description: 'Keep this computer awake, or put it to sleep' },
  { command: 'sleep', description: 'Put this computer to sleep' },
  { command: 'settings', description: 'Notifications, tasks at once, other chats' },
  { command: 'kill', description: 'End the running task now, and what it started' },
  { command: 'peek', description: "The running task's screen" },
  { command: 'pause', description: 'Stop starting new tasks' },
  { command: 'resume', description: 'Resume the queue or a paused task' },
  { command: 'leave', description: 'Leave the chat you are in' },
  { command: 'cancel', description: 'Never mind what you asked me to type' },
  { command: 'help', description: 'How this works' },
]

/** Plain words that act as commands rather than becoming a prompt. */
const WORDS: Record<string, string> = {
  status: 'status',
  st: 'status',
  queue: 'queue',
  ls: 'queue',
  tasks: 'tasks',
  chats: 'chats',
  peek: 'peek',
  pause: 'pause',
  resume: 'resume',
  go: 'resume',
  help: 'help',
  settings: 'settings',
  mac: 'mac',
  pc: 'mac',
  computer: 'mac',
  apps: 'mac',
  sleep: 'sleep',
}

const PENDING_TTL = 30 * 60_000
/** Without a message's buttons at hand, the second tap of something that asks twice comes within this. */
const CONFIRM_MS = 15_000
/** How long the photos of one album are gathered before they go into a chat together. */
const ALBUM_MS = 1500
/** /mac and /sleep where there's nothing to sleep. */
const NO_POWER = 'There is nothing here to keep awake or sleep (a container).'
const MAX_PAIR_ATTEMPTS = 5
/** The bot's look: when it changes, the keys under the text box are sent again, once. */
const LOOK = 2

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A message's text without formatting, within Telegram's limit: what's sent when formatting fails. */
function plain(html: string): string {
  return ui.esc(ui.clip(htmlToText(html), 4000))
}

/** The line added to a request's message once it was settled somewhere else. */
function settledLine(a: Approval | null): string {
  switch (a?.status) {
    case 'allowed':
      return 'Allowed elsewhere.'
    case 'denied':
      return 'Declined elsewhere.'
    case 'answered':
      return 'Answered elsewhere.'
    case 'expired':
      return "Expired: Claude was told you're away."
    default:
      return 'No longer waiting.'
  }
}

function questionsOf(a: Approval): Question[] {
  return ((a.payload as { questions?: Question[] } | null)?.questions ?? []) as Question[]
}

const isEffort = (e: string | undefined): e is Effort => ui.EFFORTS.includes(e as Effort)

export class TelegramBridge {
  private state: TelegramState
  private running = false
  private abort = new AbortController()
  private botName: string | null = null
  private error: string | null = null
  private pending: (Pending & { at: number }) | null = null
  /** Recent messages with buttons, so a tap can update them in place. */
  private sent = new Map<number, { html: string; keyboard?: InlineKeyboard }>()
  /** Messages showing the queue, refreshed after a tap, with the task picked in each. */
  private queueMessages = new Map<number, number | null>()
  /** Where you are in answering each set of Claude's questions, by request code. */
  private questions = new Map<string, ui.QuestionState & { messageId: number }>()
  /** Each running task's card (its "started" message), edited as the task goes on. */
  private cards = new Map<number, { messageId: number; card: ui.Card }>()
  /** The message holding each request's buttons, by code, to tidy up once it's settled anywhere. */
  private requests = new Map<string, number>()
  /** Messages showing Status, a screen, or this computer, refreshed in place. */
  private statusMessages = new Set<number>()
  private peekMessages = new Map<number, boolean>()
  private ticking = false
  private pairAttempts = new Map<number, number>()
  /** Something that asks twice, tapped once where its button couldn't change: what, and when. */
  private armed = new Map<string, number>()
  /** The tap being handled: its data (without the "!" of a second tap), and whether it is one. */
  private tapping: { data: string; confirmed: boolean } | null = null
  private username: string | null = null
  /** The menu button last set, and when setting it last failed (tried again after a while). */
  private menuFailedAt = 0

  constructor(private o: TelegramOptions) {
    this.state = new TelegramState(o.store.db)
  }

  private get owner(): number | null {
    return this.o.config().telegram.ownerId
  }

  /** "Mac", "computer" or "PC". */
  private get word(): string {
    return this.o.mac?.word ?? 'computer'
  }

  /** The keys under the text box: inside a chat, the first one leaves it. */
  private keys(): ReplyKeyboard {
    return ui.mainKeyboard(this.word, this.focus()?.title ?? null)
  }

  async start(): Promise<void> {
    this.running = true
    try {
      const me = await this.o.api.getMe()
      this.botName = me.username ? `@${me.username}` : me.first_name
      this.username = me.username ?? null
      this.error = null
    } catch (err) {
      this.error = errorText(err)
      this.o.log(`telegram: can't reach the bot (${this.error})`)
    }
    if (this.owner === null) this.pairCode()
    this.o.api.setMyCommands(COMMANDS).catch(err => this.o.log(`telegram: setMyCommands failed: ${errorText(err)}`))
    await this.resetMenu()
    await this.newLook()
    void this.loop()
    this.o.log(`telegram: ${this.botName ?? 'bot'} ${this.owner === null ? 'waiting to pair' : 'ready'}`)
  }

  /** The keys under the text box changed: the new ones go out once, with a word on what's new. */
  private async newLook(): Promise<void> {
    const chat = this.owner
    if (chat === null || this.o.store.kvGet<number>('telegram.look') === LOOK) return
    try {
      await this.send(
        chat,
        {
          html:
            '<b>The bot has a new look.</b> Plain buttons that stay where they are, and a task card that shows every choice with a button for each. ' +
            `In Model you can plan at one effort and work at another. ${ui.machineKey(this.word)} keeps the ${this.word} awake or puts it to sleep. Help says where everything is.`,
          silent: true,
        },
        this.keys(),
      )
      this.o.store.kvSet('telegram.look', LOOK)
    } catch (err) {
      this.o.log(`telegram: couldn't send the new keys: ${errorText(err)}`)
    }
  }

  stop(): void {
    this.running = false
    this.abort.abort()
  }

  status(): TelegramStatus {
    const paired = this.owner !== null
    return {
      ok: this.running && this.error === null,
      bot: this.botName,
      paired,
      owner: this.o.config().telegram.ownerName,
      pairCode: paired ? null : this.pairCode(),
      error: this.error,
    }
  }

  private pairCode(): string {
    let code = this.o.store.kvGet<string>('telegram.pairCode')
    if (!code) {
      code = String(randomInt(100000, 1000000))
      this.o.store.kvSet('telegram.pairCode', code)
    }
    return code
  }

  private async loop(): Promise<void> {
    let backoff = 1000
    while (this.running) {
      try {
        const offset = this.o.store.kvGet<number>('telegram.offset') ?? 0
        const updates = await this.o.api.getUpdates(offset, 50, this.abort.signal)
        this.error = null
        backoff = 1000
        await this.flushOutbox()
        for (const update of updates) {
          this.o.store.kvSet('telegram.offset', update.update_id + 1)
          await this.handle(update).catch(err => this.o.log(`telegram: update failed: ${errorText(err)}`))
        }
      } catch (err) {
        if (!this.running) return
        const message = errorText(err)
        if (message !== this.error) this.o.log(`telegram: ${message}`)
        this.error = message
        await Bun.sleep(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  /** Exposed for tests: handles one update as if it came from polling. */
  async handle(update: TgUpdate): Promise<void> {
    if (update.message) await this.onMessage(update.message)
    else if (update.callback_query) await this.onCallback(update.callback_query)
  }

  // --- sending -------------------------------------------------------------------

  private remember(messageId: number, html: string, keyboard?: InlineKeyboard): void {
    this.sent.set(messageId, { html, keyboard })
    if (this.sent.size > 300) this.sent.delete(this.sent.keys().next().value!)
  }

  /** The HTML as given when Telegram will take it, else the same text without formatting. */
  private checked(html: string): string {
    const problem = telegramHtmlProblem(html)
    if (!problem) return html
    this.o.log(`telegram: a message had formatting Telegram would refuse (${problem}); sending it as plain text`)
    return plain(html)
  }

  /** Sends a view and what follows it (more parts, a file). Returns the last message: where its buttons are. */
  private async send(chat: number, view: ui.View, markup?: Markup): Promise<TgMessage> {
    let msg = await this.sendOne(chat, view, markup)
    for (const part of view.follow ?? []) msg = await this.sendOne(chat, part)
    if (view.file) await this.o.api.sendDocument(chat, view.file.name, view.file.text, view.file.caption)
    return msg
  }

  /**
   * One message. If Telegram refuses its formatting or length, it goes again as plain text; if it
   * refuses its app buttons, again without them.
   */
  private async sendOne(chat: number, view: ui.View, markup?: Markup): Promise<TgMessage> {
    const reply = view.keyboard ? { inline_keyboard: view.keyboard } : markup
    let html = this.checked(view.html)
    let msg: TgMessage
    try {
      msg = await this.o.api.sendMessage(chat, html, reply, { silent: view.silent })
    } catch (err) {
      if (refusedFormatting(err)) {
        this.o.log(`telegram: ${errorText(err)}; sending it as plain text`)
        html = plain(html)
      } else throw err
      msg = await this.o.api.sendMessage(chat, html, reply, { silent: view.silent })
    }
    if (view.keyboard) this.remember(msg.message_id, html, view.keyboard)
    return msg
  }

  private async edit(chat: number, messageId: number, view: ui.View): Promise<void> {
    let html = this.checked(view.html)
    try {
      await this.o.api.editMessageText(chat, messageId, html, view.keyboard)
    } catch (err) {
      if (!refusedFormatting(err)) throw err
      html = plain(html)
      await this.o.api.editMessageText(chat, messageId, html, view.keyboard)
    }
    this.remember(messageId, html, view.keyboard)
  }

  private sendText(chat: number, text: string): Promise<TgMessage> {
    return this.send(chat, { html: ui.esc(text) })
  }

  /** Asks you to type something: the text box opens as a reply, with `placeholder` in it. */
  private async ask(chat: number, text: string, placeholder: string): Promise<void> {
    await this.send(chat, { html: ui.esc(text) }, { force_reply: true, input_field_placeholder: ui.clip(placeholder, 64) })
  }

  /** Takes an old message away; where Telegram won't (it's over two days old), says where it went. */
  private async drop(chat: number, messageId: number, line = 'Moved further down.'): Promise<void> {
    this.sent.delete(messageId)
    try {
      await this.o.api.deleteMessage(chat, messageId)
    } catch {
      await this.o.api.editMessageText(chat, messageId, `<i>${ui.esc(line)}</i>`).catch(() => {})
    }
  }

  /** Adds a closing line to a message and removes its buttons. */
  private async settle(chat: number, message: TgMessage | undefined, line: string): Promise<void> {
    if (message) await this.settleMessage(chat, message.message_id, line, message.text)
  }

  private async settleMessage(chat: number, messageId: number, line: string, text?: string): Promise<void> {
    const html = this.sent.get(messageId)?.html ?? ui.esc(text ?? '')
    this.sent.delete(messageId)
    await this.o.api.editMessageText(chat, messageId, `${html}\n\n<b>${ui.esc(line)}</b>`)
  }

  /** Settles a request's buttons: on the message tapped, and on the one it was sent in. */
  private async settleRequest(chat: number, code: string, line: string, tapped?: TgMessage): Promise<void> {
    const sentIn = this.requests.get(code)
    this.requests.delete(code)
    this.questions.delete(code)
    if (tapped) await this.settle(chat, tapped, line)
    if (sentIn !== undefined && sentIn !== tapped?.message_id) await this.settleMessage(chat, sentIn, line).catch(() => {})
  }

  /**
   * Whether something that asks twice (Kill, Sleep now, Clear…) may go ahead. The second tap may.
   * The first turns the tapped button into the second ("Yes, kill #12") where it is, and says so; it
   * goes back to how it was when the message is next shown. Where the button can't change, a second
   * tap within a few seconds does it.
   */
  private async secondTap(chat: number, message: TgMessage | undefined, label: string): Promise<boolean> {
    const t = this.tapping
    if (!t || t.confirmed) return true
    const at = message?.message_id
    const keyboard = (at !== undefined ? this.sent.get(at)?.keyboard : undefined) ?? message?.reply_markup?.inline_keyboard
    if (at !== undefined && keyboard?.flat().some(b => b.callback_data === t.data)) {
      const next = keyboard.map(row => row.map(b => (b.callback_data === t.data ? ui.btn(label, `${t.data}!`) : b)))
      await this.o.api.editMessageReplyMarkup(chat, at, next)
      const known = this.sent.get(at)
      if (known) this.sent.set(at, { ...known, keyboard: next })
      return false
    }
    const tapped = this.armed.get(t.data)
    if (tapped !== undefined && this.o.now() - tapped <= CONFIRM_MS) {
      this.armed.delete(t.data)
      return true
    }
    this.armed.set(t.data, this.o.now())
    return false
  }

  /** Called by the notifier for every notice. */
  async notify(notice: Notice): Promise<void> {
    const chat = this.owner
    if (chat === null || !this.running) return
    const ctx = this.noticeContext()
    // A plan approved for you goes on the task's card rather than in a message of its own.
    if (notice.type === 'plan_approved') {
      const c = this.cards.get(notice.job.id)
      if (c) {
        c.card.plan = notice.choice
        await this.edit(chat, c.messageId, ui.taskCard(notice.job, c.card, ctx)).catch(err =>
          this.o.log(`telegram: couldn't update #${notice.job.id}'s card: ${errorText(err)}`),
        )
        return
      }
    }
    const msg = await this.deliver(chat, ui.noticeView(notice, ctx))
    if (!msg) return
    if (notice.type === 'started') this.cards.set(notice.job.id, { messageId: msg.message_id, card: {} })
    if (notice.type === 'permission' || notice.type === 'question' || notice.type === 'plan_review' || notice.type === 'trust') {
      this.requests.set(notice.code, msg.message_id)
      if (notice.type === 'question') this.questions.set(notice.code, { ...ui.newQuestionState(), messageId: msg.message_id })
    }
  }

  /**
   * Sends a notice, or keeps it to send later when Telegram can't be reached (and behind any already
   * kept, so they arrive in order). Returns the message with its buttons when all of it went out now.
   */
  private async deliver(chat: number, view: ui.View): Promise<TgMessage | null> {
    const parts = [view, ...(view.follow ?? [])]
    let sent = 0
    let last: TgMessage | null = null
    if (this.state.outbox().length === 0) {
      try {
        for (; sent < parts.length; sent++) last = await this.sendOne(chat, parts[sent]!)
        if (view.file) {
          await this.o.api.sendDocument(chat, view.file.name, view.file.text, view.file.caption).catch(err =>
            this.o.log(`telegram: couldn't send ${view.file!.name}: ${errorText(err)}`),
          )
        }
        return last
      } catch (err) {
        this.o.log(`telegram: couldn't send a notice (${errorText(err)}); keeping it to send later`)
      }
    }
    for (const part of parts.slice(sent)) this.state.addOutbox(this.checked(part.html), part.keyboard, this.o.now())
    return null
  }

  /**
   * Tidies up after what happened elsewhere: requests answered from the terminal, an app or by
   * timing out lose their buttons, and finished tasks' cards say how they ended. Every few seconds.
   */
  async tick(): Promise<void> {
    const chat = this.owner
    if (chat === null || !this.running || this.ticking) return
    this.ticking = true
    try {
      await this.resetMenu()
      for (const [code, messageId] of [...this.requests]) {
        const a = this.o.store.getApproval(code)
        if (a?.status === 'pending') continue
        this.requests.delete(code)
        this.questions.delete(code)
        await this.settleMessage(chat, messageId, settledLine(a)).catch(err => this.o.log(`telegram: couldn't tidy request ${code}: ${errorText(err)}`))
      }
      for (const [jobId, c] of [...this.cards]) {
        const job = this.o.store.getJob(jobId)
        if (job && (job.status === 'queued' || job.status === 'running' || job.status === 'held')) continue
        this.cards.delete(jobId)
        if (job) await this.edit(chat, c.messageId, ui.taskCard(job, c.card, this.uiContext())).catch(err => this.o.log(`telegram: couldn't close #${jobId}'s card: ${errorText(err)}`))
      }
    } finally {
      this.ticking = false
    }
  }

  /** Sends what was kept while Telegram was unreachable, oldest first; drops what's a day old. */
  async flushOutbox(): Promise<void> {
    const chat = this.owner
    if (chat === null) return
    this.state.pruneOutbox(this.o.now() - 24 * 60 * 60_000)
    for (const item of this.state.outbox()) {
      try {
        await this.send(chat, { html: item.html, keyboard: item.keyboard as ui.View['keyboard'] })
      } catch {
        return
      }
      this.state.deleteOutbox(item.id)
    }
  }

  // --- context ---------------------------------------------------------------------

  private roots(): string[] {
    return codeRoots(this.o.config())
  }

  private within(path: string): boolean {
    return this.roots().some(r => inside(r, path))
  }

  private recent(): string[] {
    return this.o.store.recentFolders(8).filter(p => existsSync(p))
  }

  private uiContext(): ui.UiContext {
    const roots = this.roots()
    return {
      now: this.o.now(),
      models: this.o.config().models,
      folderId: path => this.state.folderId(path),
      label: path => relativeToRoots(path, roots),
      hasConversation: folder => this.o.store.getThread(folder) !== null,
      chat: sessionId => this.o.chats.get(sessionId),
      resetsAt: this.resetsAt(),
      ahead: [...this.o.store.running(), ...this.o.store.queued()].map(j => ({ id: j.id, prompt: j.prompt })),
      machine: this.word,
    }
  }

  /** When the 5-hour limit resets, while that's still ahead. */
  private resetsAt(): number | null {
    const at = this.o.runner.limits().fiveHour?.resetsAt ?? null
    return at !== null && at > this.o.now() ? at : null
  }

  private choices(): Choices {
    const d = this.o.config().defaults
    const last = this.o.store.kvGet<Partial<Choices>>('telegram.last') ?? {}
    const folder = [last.folder, d.project].find((p): p is string => typeof p === 'string' && existsSync(p)) ?? null
    return {
      folder,
      plan: last.plan ?? d.plan,
      review: last.review ?? d.review,
      execMode: last.execMode ?? d.execMode,
      model: last.model ?? d.model,
      workModel: last.workModel !== undefined ? last.workModel : (d.workModel ?? null),
      effort: last.effort ?? d.effort,
      workEffort: last.workEffort !== undefined ? last.workEffort : (d.workEffort ?? null),
      isolate: last.isolate ?? this.o.config().isolate,
    }
  }

  private setPending(p: Pending | null): void {
    this.pending = p ? { ...p, at: this.o.now() } : null
  }

  private takePending(): Pending | null {
    const p = this.pending
    this.pending = null
    return p && this.o.now() - p.at < PENDING_TTL ? p : null
  }

  /** The menu button shows the bot's commands. An app button set by an earlier version is put back, once. */
  private async resetMenu(): Promise<void> {
    const chat = this.owner
    if (chat === null || !(this.o.store.kvGet<string>('telegram.menu') ?? '')) return
    if (this.o.now() - this.menuFailedAt < 10 * 60_000) return
    try {
      await this.o.api.setChatMenuButton(chat, { type: 'commands' })
      this.o.store.kvSet('telegram.menu', '')
      this.o.log('telegram: the menu button shows the commands again')
    } catch (err) {
      this.menuFailedAt = this.o.now()
      this.o.log(`telegram: couldn't set the menu button: ${errorText(err)}`)
    }
  }

  /** A device was paired with this machine: you hear about every one. */
  async devicePaired(device: { name: string; platform: string }, role: string): Promise<void> {
    const chat = this.owner
    if (chat === null || !this.running) return
    await this.send(chat, { html: `<b>${ui.esc(device.name)}</b> paired with this machine, as ${ui.esc(role)}. Not you? Remove it in the app, or with <code>cq devices remove</code> on the ${ui.esc(this.word)}.` }).catch(err =>
      this.o.log(`telegram: couldn't say a device paired: ${errorText(err)}`),
    )
  }

  // --- messages ---------------------------------------------------------------------

  /** Which key under the text box this is, today's or one from before the new look. */
  private keyOf(text: string): string | null {
    for (const [key, label] of Object.entries(ui.KEYS)) if (text === label) return key
    if (text === 'Mac' || text === 'PC' || text === 'Computer') return 'mac'
    return ui.OLD_KEYS[text] ?? null
  }

  private async onKey(chat: number, key: string): Promise<void> {
    switch (key) {
      case 'newTask':
        await this.leaveChat(chat, true)
        return this.newTask(chat)
      case 'status':
        return this.showStatus(chat)
      case 'queue':
        return this.showQueue(chat)
      case 'tasks':
        return this.showTasks(chat)
      case 'chats':
        return this.showChats(chat, 0)
      case 'mac':
        return this.showMac(chat)
      case 'settings':
        await this.send(chat, this.settingsView())
        return
      case 'help':
        return this.showHelp(chat)
      case 'leave':
        return this.leaveChat(chat)
      case 'peek':
        return this.showPeek(chat)
    }
  }

  private async onMessage(m: TgMessage): Promise<void> {
    if (m.chat.type !== 'private' || !m.from) return
    const text = (m.text ?? '').trim()
    if (this.owner === null) return this.tryPair(m, text)
    if (m.from.id === this.owner && (m.photo || m.document)) return this.onFile(m.chat.id, m)
    if (m.from.id !== this.owner || !text) return // only you; strangers get no reply
    const chat = m.chat.id

    const key = this.keyOf(text)
    if (key) return this.onKey(chat, key)
    // A folder typed for Project folders can start with / (a Mac or Linux path): only a real command isn't taken for it.
    if (this.pending?.kind === 'rootpath' && text.startsWith('/') && !COMMANDS.some(c => c.command === text.slice(1).split(/[\s@]/)[0]!.toLowerCase())) {
      const pending = this.takePending()
      if (pending) return this.onPendingText(chat, pending, text)
    }
    if (text.startsWith('/')) return this.onCommand(chat, text)

    const pending = this.takePending()
    if (pending) return this.onPendingText(chat, pending, text)

    // Inside a chat, everything you type goes there.
    const focus = this.focus()
    if (focus) return this.sendToChat(chat, focus, text)

    const word = WORDS[text.toLowerCase()]
    if (word) return this.onCommand(chat, `/${word}`)
    return this.newDraft(chat, text)
  }

  /** A photo or file: kept on the computer, and added to the card you're on (or a new one, with its caption as the prompt). */
  private async onFile(chat: number, m: TgMessage): Promise<void> {
    const dir = this.o.uploadsDir
    if (!dir) return void (await this.sendText(chat, `Files aren’t kept on this ${this.word}.`))
    const pick = m.document ?? [...(m.photo ?? [])].sort((a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height))[0]
    if (!pick) return
    const name = m.document?.file_name ?? 'photo.jpg'
    let got: Awaited<ReturnType<BotApi['downloadFile']>>
    try {
      got = await this.o.api.downloadFile(pick.file_id, MAX_UPLOAD_BYTES)
    } catch (err) {
      this.o.log(`telegram: couldn't download a file: ${errorText(err)}`)
      return void (await this.sendText(chat, 'I couldn’t download that file. Try again.'))
    }
    if (!got) return void (await this.sendText(chat, 'That file is bigger than 5 MB.'))
    const saved = saveUpload(dir, name === 'photo.jpg' ? got.name : name, Buffer.from(got.bytes).toString('base64'), this.o.now())
    if ('error' in saved) return void (await this.sendText(chat, saved.error))
    const caption = (m.caption ?? '').trim()
    // Inside a chat, a photo or file goes into that conversation, like what you type.
    const focus = this.focus()
    if (focus) return this.fileToChat(chat, focus, saved.path, caption, m.media_group_id)
    let d = this.state.latestOpenDraft(this.o.now() - 24 * 3600_000)
    if (!d) {
      d = this.state.addDraft({ ...this.choices(), prompt: caption }, this.o.now())
    } else if (caption && !d.prompt) {
      d = this.state.updateDraft(d.id, { prompt: caption })
    }
    if (d.attachments.length >= 10) return void (await this.sendText(chat, 'That card has 10 files already.'))
    d = this.state.updateDraft(d.id, { attachments: [...d.attachments, saved.path] })
    await this.showDraft(chat, d)
    if (!d.prompt && d.folder) this.setPending({ kind: 'prompt', draftId: d.id })
  }

  /** Photos of one album, gathered for a moment so they go into the chat together. */
  private albums = new Map<string, { files: string[]; caption: string }>()

  private async fileToChat(chat: number, f: Focus, path: string, caption: string, album: string | undefined): Promise<void> {
    if (!album) return this.sendToChat(chat, f, caption, [path])
    const gathering = this.albums.get(album)
    if (gathering) {
      gathering.files.push(path)
      if (caption && !gathering.caption) gathering.caption = caption
      return
    }
    this.albums.set(album, { files: [path], caption })
    ;(this.o.later ?? setTimeout)(() => {
      const a = this.albums.get(album)
      this.albums.delete(album)
      if (a) void this.sendToChat(chat, f, a.caption, a.files).catch(err => this.o.log(`telegram: sending an album to a chat failed: ${errorText(err)}`))
    }, ALBUM_MS)
  }

  private async tryPair(m: TgMessage, text: string): Promise<void> {
    const from = m.from!
    const tries = this.pairAttempts.get(from.id) ?? 0
    if (tries >= MAX_PAIR_ATTEMPTS) return
    const typed = (/^\/start\s+(\d{6})$/.exec(text) ?? /^(\d{6})$/.exec(text))?.[1]
    if (!typed) {
      if (text.startsWith('/start')) await this.sendText(m.chat.id, `Send /start followed by the pairing code that \`cq telegram\` printed on your ${this.word}.`)
      return
    }
    if (typed !== this.pairCode()) {
      this.pairAttempts.set(from.id, tries + 1)
      await this.sendText(m.chat.id, `That code doesn't match. Use the one \`cq telegram\` printed on your ${this.word}.`)
      return
    }
    const config = this.o.config()
    config.telegram.ownerId = from.id
    config.telegram.ownerName = from.username ? `@${from.username}` : from.first_name
    this.o.saveConfig(config)
    this.o.store.kvSet('telegram.pairCode', '')
    this.o.store.kvSet('telegram.look', LOOK)
    this.o.log(`telegram: paired with ${config.telegram.ownerName} (${from.id})`)
    await this.send(m.chat.id, { html: `<b>Paired.</b> Only you can use this bot now.\n\n${ui.helpHtml(this.word)}` }, this.keys())
    // Where Claude will work, with the way to change it: a wrong guess in setup costs nothing.
    await this.send(m.chat.id, ui.foldersWelcomeView(this.roots().map(path => ({ label: this.folderName(path) })))).catch(() => {})
  }

  private async showHelp(chat: number): Promise<void> {
    await this.send(chat, { html: ui.helpHtml(this.word) }, this.keys())
  }

  private async onCommand(chat: number, text: string): Promise<void> {
    const name = text.slice(1).split(/[\s@]/)[0]!.toLowerCase()
    switch (name) {
      case 'start':
      case 'help':
        return this.showHelp(chat)
      case 'new':
        await this.leaveChat(chat, true)
        return this.newTask(chat)
      case 'chats':
        return this.showChats(chat, 0)
      case 'leave':
        return this.leaveChat(chat)
      case 'queue':
        return this.showQueue(chat)
      case 'tasks':
        return this.showTasks(chat, undefined, text.replace(/^\/tasks(?:@\S+)?\s*/i, '').trim())
      case 'status':
        return this.showStatus(chat)
      case 'peek':
        return this.showPeek(chat)
      case 'mac':
        return this.showMac(chat)
      case 'sleep': {
        const mac = this.o.mac
        if (!mac) return void (await this.sendText(chat, NO_POWER))
        await this.send(chat, ui.sleepView(await mac.status()))
        return
      }
      case 'kill': {
        // /kill ends the running task; /kill 14 ends #14 (a queued one comes off the queue).
        const arg = /^\/kill(?:@\S+)?\s+#?(\d+)\s*$/.exec(text)?.[1]
        const running = this.o.store.running()
        if (!arg && running.length > 1) return void (await this.send(chat, ui.killPickerView(running, this.noticeContext())))
        const id = arg ? Number(arg) : running[0]?.id
        await this.sendText(chat, id === undefined ? 'Nothing is running.' : await this.o.runner.kill(id, { by: 'Telegram' }))
        return
      }
      case 'pause':
        this.o.runner.setPaused(true)
        await this.sendText(chat, 'Paused. The running task keeps going; nothing new starts until /resume.')
        return
      case 'resume':
        await this.sendText(chat, await this.o.runner.go())
        return
      case 'settings':
        await this.send(chat, this.settingsView())
        return
      case 'cancel':
        this.setPending(null)
        await this.sendText(chat, 'OK, never mind.')
        return
      default:
        await this.sendText(chat, 'I don’t know that command. /help')
    }
  }

  private async onPendingText(chat: number, p: Pending, text: string): Promise<void> {
    switch (p.kind) {
      case 'prompt': {
        const d = this.state.getDraft(p.draftId)
        if (!d || d.status !== 'open') return this.newDraft(chat, text)
        await this.showDraft(chat, this.state.updateDraft(d.id, { prompt: text, view: null }))
        return
      }
      case 'later': {
        const d = this.state.getDraft(p.draftId)
        if (!d || d.status !== 'open') return this.newDraft(chat, text)
        const at = parseWhen(text, this.o.now())
        if (at === null) {
          this.setPending(p)
          await this.sendText(chat, 'That isn’t a time I can read. Try 23:00, 11pm, in 2h or tomorrow 9am.')
          return
        }
        const clock = new Date(at)
        const patch = p.daily ? { repeatDaily: clock.getHours() * 60 + clock.getMinutes(), notBefore: null } : { notBefore: at, repeatDaily: null }
        await this.showDraft(chat, this.state.updateDraft(d.id, { ...patch, atReset: false, afterJob: null, front: false, view: 'when' }))
        return
      }
      case 'tasksearch':
        return this.showTasks(chat, undefined, text)
      case 'rootpath': {
        const path = folderPath(text)
        const r = this.addRoot(path)
        if (!r.ok) this.setPending(p) // try again
        await this.send(chat, this.projectFoldersView(r.text))
        return
      }
      case 'search': {
        const d = this.state.getDraft(p.draftId)
        if (!d || d.status !== 'open') return this.newDraft(chat, text)
        await this.showDraft(chat, this.state.updateDraft(d.id, { view: `folder:search:${text}` }))
        this.setPending({ kind: 'search', draftId: d.id }) // typing again refines the search
        return
      }
      case 'answer': {
        const state = this.questions.get(p.code)
        const approval = this.o.store.getApproval(p.code)
        const job = approval ? this.o.store.getJob(approval.jobId) : null
        // One question of a set: that question gets your text, then the next one shows.
        if (p.step !== undefined && state && job && approval?.status === 'pending' && state.step === p.step) {
          // Typed: the question's message is far up by now, so the next one comes down here.
          await this.sendText(chat, await this.answerStep(chat, p.code, job, questionsOf(approval), state, { text }, { below: true }))
          return
        }
        const reply = this.o.runner.answer(p.code, 'answer', text)
        await this.settleRequest(chat, p.code, `Answered: “${ui.clip(text, 200)}”`)
        await this.sendText(chat, reply)
        return
      }
      case 'changes': {
        const reply = this.o.runner.answer(p.code, 'deny', text)
        await this.settleRequest(chat, p.code, 'You asked for changes.')
        await this.sendText(chat, reply)
        return
      }
      case 'followup': {
        const job = this.o.store.getJob(p.jobId)
        if (!job?.sessionId) return this.newDraft(chat, text)
        // Open in VS Code or a terminal since: continuing it from here means taking it over.
        const open = this.o.chats.get(job.sessionId)?.where != null
        const draft = this.state.addDraft(
          { ...this.choices(), folder: job.projectDir, prompt: text, sessionId: job.sessionId, followJob: job.id, takeover: open },
          this.o.now(),
        )
        return this.showDraft(chat, draft)
      }
      case 'say':
        await this.sendText(chat, await this.o.runner.say(text, p.job))
        return
    }
  }

  // --- the task card ----------------------------------------------------------------

  /** The card as it is now, with what its open tab needs. */
  private async card(d: Draft): Promise<ui.View> {
    return ui.draftCard(d, this.uiContext(), await this.cardExtras(d))
  }

  private async cardExtras(d: Draft): Promise<ui.CardExtras> {
    const v = ui.parseView(d.view)
    if (v.tab === 'chat' && d.folder) return { chats: { list: this.o.chats.list(d.folder, 8), hasLast: this.o.store.getThread(d.folder) !== null } }
    if (v.tab !== 'folder') return {}
    if (v.folder.mode === 'browse') {
      const dir = this.browseDir(d)
      return { browse: { dir, parent: parentWithin(dir, this.roots()), children: listChildren(dir), page: v.folder.page } }
    }
    if (v.folder.mode === 'search') return { hits: await this.o.folders.search(v.folder.query, this.recent(), 8) }
    return { recent: this.recent() }
  }

  /** The folder the browser shows: the one browsed last, else the card's, else the first of your code folders. */
  private browseDir(d: Draft): string {
    return [d.browse, d.folder].find((p): p is string => !!p && existsSync(p) && this.within(p)) ?? this.roots()[0]!
  }

  /** The Folder tab: your recent folders, or the browser while there are none yet. */
  private folderTab(d: Draft): Partial<Draft> {
    return this.recent().length > 0 ? { view: 'folder' } : { view: 'folder:browse:0', browse: this.browseDir(d) }
  }

  /** Sends the card at the bottom of the chat, where you are; the one it was in goes. */
  private async showDraft(chat: number, draft: Draft): Promise<void> {
    const old = draft.messageId
    const msg = await this.send(chat, await this.card(draft))
    this.state.updateDraft(draft.id, { messageId: msg.message_id })
    if (old !== null && old !== msg.message_id) await this.drop(chat, old)
  }

  private async newDraft(chat: number, text: string): Promise<void> {
    let choices = this.choices()
    let prompt = text
    let newChat = false
    // The typed shortcut still works: "q nacho plan opus: …" fills in the card.
    const shortcut = /^q\s+([\s\S]+)$/i.exec(text)
    if (shortcut) {
      const { options: o, prompt: rest } = parseQueueText(shortcut[1]!, this.o.config())
      prompt = rest
      choices = {
        folder: o.project ?? choices.folder,
        plan: o.plan ?? choices.plan,
        review: o.review ?? (o.plan === false ? false : choices.review),
        execMode: o.execMode ?? choices.execMode,
        model: o.model ?? choices.model,
        workModel: o.model !== undefined ? (o.workModel ?? null) : choices.workModel,
        effort: o.effort ?? choices.effort,
        workEffort: o.effort !== undefined ? (o.workEffort ?? null) : choices.workEffort,
        isolate: o.isolate ?? choices.isolate,
      }
      newChat = o.policy === 'new'
    }
    if (!prompt) {
      await this.sendText(chat, 'Send what Claude should do, as plain text.')
      return
    }
    await this.showDraft(chat, this.state.addDraft({ ...choices, prompt, newChat }, this.o.now()))
  }

  /** New task: the card opens on its Folder tab; then you send the prompt. */
  private async newTask(chat: number): Promise<void> {
    let draft = this.state.addDraft({ ...this.choices(), prompt: '' }, this.o.now())
    draft = this.state.updateDraft(draft.id, this.folderTab(draft))
    await this.showDraft(chat, draft)
    if (draft.folder) this.setPending({ kind: 'prompt', draftId: draft.id })
  }

  private async onDraftButton(chat: number, message: TgMessage | undefined, id: number, args: string[]): Promise<string | undefined> {
    let d = this.state.getDraft(id)
    if (!d) return 'This card is gone. Send the prompt again.'
    if (d.status === 'queued') return `Already queued as #${d.jobId}.`
    if (d.status === 'discarded') return 'You discarded this one.'
    const at = message?.message_id ?? d.messageId
    if (at === null || at === undefined) return
    if (d.messageId !== at) d = this.state.updateDraft(d.id, { messageId: at })
    const ctx = this.uiContext()
    /** Changes the card and shows it again, in place. */
    const show = async (patch: Partial<Draft> = {}): Promise<void> => {
      d = this.state.updateDraft(id, patch)
      await this.edit(chat, at, await this.card(d))
    }
    const [op, a, b] = args
    // Any other tap ends a search, so your next message isn't taken as more search words.
    if (op !== 's' && this.pending?.kind === 'search' && this.pending.draftId === d.id) this.setPending(null)

    switch (op) {
      case 'v': {
        // A tab: opens it, or closes it (-). "work" is the Model tab, setting the work.
        if (a === '-') return void (await show({ view: null }))
        if (a === 'work') return void (await show({ view: 'model:work' }))
        if (a === 'folder') return void (await show(this.folderTab(d)))
        return void (await show({ view: a && ['chat', 'how', 'model', 'when', 'more'].includes(a) ? a : null }))
      }
      case 'k': // Back, on cards from before the tabs
        await show({ view: null })
        if (!d.prompt && d.folder) this.setPending({ kind: 'prompt', draftId: d.id })
        return
      case 'f':
        return void (await show({ view: 'folder:browse:0', browse: this.browseDir(d) }))
      case 'r':
        return void (await show({ view: 'folder' }))
      case 'b': {
        const dir = this.state.folderPath(Number(a))
        if (!dir || !existsSync(dir)) return 'That folder is gone. Rescan folders in Settings.'
        return void (await show({ view: `folder:browse:${Number(b) || 0}`, browse: dir }))
      }
      case 'u': {
        const dir = this.state.folderPath(Number(a))
        if (!dir || !existsSync(dir)) return 'That folder is gone. Rescan folders in Settings.'
        // A follow-up can only continue its conversation in the folder it ran in.
        const moved = d.sessionId && dir !== d.folder
        await show({ folder: dir, browse: dir, view: null, ...(moved ? { sessionId: null, followJob: null, takeover: false } : {}) })
        this.setPending(d.prompt ? null : { kind: 'prompt', draftId: d.id })
        return d.prompt ? undefined : 'Now send the prompt.'
      }
      case 's':
        this.setPending({ kind: 'search', draftId: d.id })
        await this.ask(chat, 'Type part of a folder name, e.g. api or shop web.', 'Part of a folder name')
        return
      case 'rs':
        await this.o.folders.rebuild()
        await show({ view: 'folder:browse:0', browse: this.browseDir(d) })
        return `Folder map rebuilt: ${this.o.folders.size} folders.`
      case 'o': {
        if (a === 'h') {
          const how = ui.HOW[b as ui.HowKey]
          if (!how) return
          return void (await show({ plan: how.plan, review: how.review, execMode: b === 'ask' ? 'plan' : d.execMode === 'plan' ? 'auto' : d.execMode, view: 'how' }))
        }
        if (a === 'p') {
          const perm = ui.PERMISSIONS[b as ui.PermissionKey]
          if (!perm) return
          if (ui.howOf(d) === 'ask') return 'An answer changes nothing, so it never asks. Pick another How first.'
          return void (await show({ execMode: perm.execMode, view: 'how' }))
        }
        return void (await show({ view: 'how' }))
      }
      case 'm':
        // The planning model; the work model stays as it was, unless it's now the same.
        if (!a) return void (await show({ view: 'model' }))
        return void (await show({ model: a, ...(d.workModel === a ? { workModel: null } : {}), view: 'model' }))
      case 'w':
        if (!a) return void (await show({ view: 'model:work' }))
        return void (await show({ workModel: a === 'same' || a === d.model ? null : a, view: 'model:work' }))
      case 'e':
        if (!a) return void (await show({ view: 'model' }))
        if (!isEffort(a)) return
        return void (await show({ effort: a, ...(d.workEffort === a ? { workEffort: null } : {}), view: 'model' }))
      case 'we':
        if (!a) return void (await show({ view: 'model:work' }))
        if (!isEffort(a)) return
        return void (await show({ workEffort: a === d.effort ? null : a, view: 'model:work' }))
      case 'c': // the new-chat switch on cards from before the Chat tab
        return void (await show(d.sessionId ? { sessionId: null, followJob: null, takeover: false, newChat: true, view: 'chat' } : { newChat: !d.newChat, view: 'chat' }))
      case 't': {
        if (!d.folder) return 'Pick a folder first.'
        if (!a) return void (await show({ view: 'chat' }))
        if (a === 'new' || a === 'last') {
          await show({ sessionId: null, followJob: null, takeover: false, newChat: a === 'new', view: 'chat' })
        } else {
          const c = this.o.chats.get(a)
          if (!c) return 'That chat is gone.'
          // Open in VS Code or a terminal: taking it over is what continuing it from here means.
          await show({ sessionId: c.sessionId, followJob: null, newChat: false, takeover: c.where !== null, view: 'chat' })
        }
        if (!d.prompt) this.setPending({ kind: 'prompt', draftId: d.id })
        return
      }
      case 'h':
        await show({ takeover: !d.takeover, view: 'chat' })
        return d.takeover ? 'It takes the chat over when it starts.' : 'It waits until you close the chat there.'
      case 'i':
        await show({ isolate: !d.isolate, view: 'chat' })
        return d.isolate ? 'It runs on its own git branch.' : 'It runs in your checkout.'
      case 'l':
        return void (await show({ wantLink: !d.wantLink, view: 'more' }))
      case 'p':
        this.setPending({ kind: 'prompt', draftId: d.id })
        await this.ask(chat, `Send the new prompt${d.editJob ? ` for #${d.editJob}` : ''}.`, 'The new prompt')
        return
      case 'a': {
        const now = this.o.now()
        const clear = { notBefore: null, repeatDaily: null, atReset: false, afterJob: null, front: false }
        const pick = { h: LATER.hour, n: LATER.tonight, m: LATER.morning }[a as 'h' | 'n' | 'm']
        if (pick) return void (await show({ ...clear, notBefore: pick(now), view: 'when' }))
        if (a === 'c') return void (await show({ ...clear, view: 'when' }))
        if (a === 'x') return void (await show({ ...clear, front: true, view: 'when' }))
        if (a === 't' || a === 'd') {
          this.setPending({ kind: 'later', draftId: d.id, daily: a === 'd' })
          await this.ask(
            chat,
            a === 'd' ? 'Send the time of day it should start, every day: 02:30 or 11pm.' : 'Send when it may start: 23:00, 11pm, in 2h or tomorrow 9am.',
            a === 'd' ? 'Time of day, e.g. 02:30' : 'A time, e.g. 23:00 or in 2h',
          )
          return
        }
        if (a === 'r') {
          if (!ctx.resetsAt) return `The ${this.word} doesn’t know when the limit resets right now: it learns it while a task runs.`
          return void (await show({ ...clear, atReset: true, view: 'when' }))
        }
        if (a === 'j') {
          const job = Number(b)
          if (!ctx.ahead?.some(j => j.id === job)) return `#${job} isn't running or waiting any more.`
          return void (await show({ ...clear, afterJob: job, view: 'when' }))
        }
        return void (await show({ view: 'when' }))
      }
      case 'mo':
        return void (await show({ view: 'more' }))
      case 'tl':
        return void (await show({ maxMinutes: Number(a) > 0 ? Number(a) : null, view: 'more' }))
      case 'at':
        await show({ attachments: [], view: 'more' })
        return 'Files removed.'
      case 'q':
        return d.editJob ? this.saveEdit(chat, at, d) : this.queueDraft(chat, at, d)
      case 'x':
        this.state.updateDraft(d.id, { status: 'discarded' })
        if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
        await this.drop(chat, at, d.editJob ? `#${d.editJob} stays as it was.` : 'Discarded.')
        return d.editJob ? `#${d.editJob} stays as it was.` : 'Discarded.'
    }
  }

  /** When a card starts: a time, every day at a time, when the limit resets; null for "when it's its turn". */
  private startOf(d: Draft): { notBefore: number | null } | string {
    if (d.atReset) {
      const at = this.resetsAt()
      return at === null ? `The ${this.word} doesn’t know when the limit resets right now. Pick another start.` : { notBefore: at }
    }
    if (d.repeatDaily !== null) return { notBefore: nextClock(this.o.now(), Math.floor(d.repeatDaily / 60), d.repeatDaily % 60) }
    return { notBefore: d.notBefore }
  }

  private async queueDraft(chat: number, messageId: number, d: Draft): Promise<string> {
    if (!d.folder) {
      await this.edit(chat, messageId, await this.card(this.state.updateDraft(d.id, this.folderTab(d))))
      return 'Pick a folder first.'
    }
    if (!d.prompt) {
      this.setPending({ kind: 'prompt', draftId: d.id })
      return 'Send the prompt first, as your next message.'
    }
    if (!existsSync(d.folder)) return 'That folder is gone.'
    const now = this.o.now()
    const start = this.startOf(d)
    if (typeof start === 'string') return start
    const base: JobSpec = {
      projectDir: d.folder,
      prompt: d.prompt,
      plan: d.plan,
      review: d.review,
      execMode: d.execMode,
      model: d.model,
      workModel: d.plan ? d.workModel : null,
      workEffort: d.plan ? d.workEffort : null,
      // An answer changes nothing, so there's nothing to show on a page.
      wantLink: d.wantLink && d.execMode !== 'plan',
      effort: d.effort,
      sessionPolicy: d.sessionId ? 'session' : d.newChat ? 'new' : 'continue',
      sessionId: d.sessionId ?? undefined,
      takeover: d.sessionId !== null && d.takeover,
      isolate: d.isolate,
      front: d.front && !ui.startsLater(d),
      notBefore: start.notBefore,
      afterJob: d.afterJob,
      repeatDaily: d.repeatDaily,
      maxMinutes: d.maxMinutes,
      attachments: d.attachments.length > 0 ? d.attachments : null,
      source: 'telegram',
    }
    const job = this.o.runner.enqueue(base)
    this.state.updateDraft(d.id, { status: 'queued', jobId: job.id })
    if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
    const last: Choices = {
      folder: d.folder,
      plan: d.plan,
      review: d.review,
      execMode: d.execMode,
      model: d.model,
      workModel: d.workModel,
      effort: d.effort,
      workEffort: d.workEffort,
      isolate: d.isolate,
    }
    this.o.store.kvSet('telegram.last', last)
    this.o.store.kvSet('lastProject', d.folder)
    await this.edit(chat, messageId, ui.queuedView(job, this.whenText(job), this.uiContext()))
    return `Queued #${job.id}.`
  }

  /** Save on a card changing a waiting task: the task takes what the card shows. */
  private async saveEdit(chat: number, messageId: number, d: Draft): Promise<string> {
    const job = d.editJob !== null ? this.o.store.getJob(d.editJob) : null
    if (!job || job.status !== 'queued') return `#${d.editJob} isn't waiting in the queue any more.`
    if (!d.prompt) return 'Send the prompt first.'
    const start = this.startOf(d)
    if (typeof start === 'string') return start
    this.o.store.updateJob(job.id, {
      prompt: d.prompt,
      plan: d.plan,
      review: d.review,
      execMode: d.execMode,
      model: d.model,
      workModel: d.plan && d.workModel && d.workModel !== d.model ? d.workModel : null,
      effort: d.effort,
      workEffort: d.plan && d.workEffort && d.workEffort !== d.effort ? d.workEffort : null,
      wantLink: d.wantLink && d.execMode !== 'plan',
      notBefore: start.notBefore,
      afterJob: d.afterJob,
      repeatDaily: d.repeatDaily,
      maxMinutes: d.maxMinutes,
      ...(job.sessionId ? {} : { isolate: d.isolate }),
    })
    // Next: it goes to the front, as Run next does.
    if (d.front && !ui.startsLater(d)) this.o.runner.top(job.id)
    this.state.updateDraft(d.id, { status: 'queued', jobId: job.id })
    if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
    await this.edit(chat, messageId, ui.queuedView(this.o.store.getJob(job.id)!, this.whenText(job), this.uiContext(), { changed: true }))
    return `Changed #${job.id}.`
  }

  private whenText(job: Job): string {
    const now = this.o.now()
    const ahead = this.o.store.queued().findIndex(j => j.id === job.id)
    const running = this.o.store.running()
    const active = running.at(-1)
    if (ahead === 0 && running.length === 0) {
      if (this.o.runner.paused) return 'The queue is paused: /resume to start it.'
      const until = this.o.runner.limits().blockedUntil
      if (until && until > now) return `Starts after the usage limit resets at ${formatClock(until, now)}.`
      return 'Starting now.'
    }
    const others = ahead > 0 ? ` and ${ahead} more` : ''
    // Beside what's running, when it may and they can't get in each other's way.
    if (ahead === 0 && running.length < this.o.runner.parallel && !this.o.runner.collision(job, running) && !this.o.runner.paused) return `Starts beside ${running.map(j => `#${j.id}`).join(' and ')}.`
    return active ? `Runs after #${running.map(j => j.id).join(' or #')}${others}.` : `${ahead} ahead of it.`
  }

  // --- lists and screens -----------------------------------------------------------------

  /** Tasks: the finished ones, newest first; `query` narrows them (kept while you page back). */
  private async showTasks(chat: number, edit?: number, query?: string, before?: number): Promise<void> {
    if (query !== undefined) this.o.store.kvSet('telegram.tasksQuery', query)
    const words = (query ?? (before ? this.o.store.kvGet<string>('telegram.tasksQuery') : '') ?? '').trim()
    const found = this.o.store.searchFinished({ before, query: words, limit: 9 })
    const view = ui.tasksView(found.slice(0, 8), { query: words, more: found.length > 8 }, this.noticeContext())
    if (edit !== undefined) await this.edit(chat, edit, view)
    else await this.send(chat, view)
  }

  /** Queue; `messageId` shows it again in place, keeping the task picked there unless `selected` says otherwise. */
  private async showQueue(chat: number, messageId?: number, selected?: number | null): Promise<void> {
    const queued = this.o.store.queued()
    const kept = selected !== undefined ? selected : messageId !== undefined ? (this.queueMessages.get(messageId) ?? null) : null
    const sel = kept !== null && queued.some(j => j.id === kept) ? kept : null
    const view = ui.queueView(this.o.store.running(), queued, this.uiContext(), this.o.runner.paused, sel)
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.queueMessages.set(messageId, sel)
    if (this.queueMessages.size > 50) this.queueMessages.delete(this.queueMessages.keys().next().value!)
  }

  private statusInfo(): ui.StatusInfo {
    return {
      running: this.o.store.running().map(job => {
        const info = this.o.runner.runtimeInfo(job.id)
        return { job, lastTool: info?.lastTool ? { tool: info.lastTool, at: info.lastActivity } : null }
      }),
      parallel: this.o.runner.parallel,
      approvals: this.o.store.pendingApprovals(),
      queued: this.o.store.queued(),
      paused: this.o.runner.paused,
      limits: this.o.runner.limits(),
    }
  }

  /** Status; `messageId` refreshes one already shown. */
  private async showStatus(chat: number, messageId?: number): Promise<void> {
    const view = ui.statusView(this.statusInfo(), this.noticeContext())
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.statusMessages.add(messageId)
    if (this.statusMessages.size > 50) this.statusMessages.delete(this.statusMessages.values().next().value!)
  }

  /** A running task's screen; `keys` with the keypad. With several running and none named, it asks which. */
  private async showPeek(chat: number, messageId?: number, jobId?: number, keys = false): Promise<void> {
    const running = this.o.store.running()
    if (jobId === undefined && running.length > 1) {
      await this.send(chat, ui.runningPickerView(running, keys ? 'keys' : 'peek', this.noticeContext()))
      return
    }
    const s = await this.o.runner.screen(30, false, jobId)
    const job = s ? this.o.store.getJob(s.jobId) : null
    const ctx = this.uiContext()
    const view = ui.screenView(job, s?.text ?? '', { keys, label: ctx.label })
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.peekMessages.set(messageId, keys)
    if (this.peekMessages.size > 50) this.peekMessages.delete(this.peekMessages.keys().next().value!)
  }

  /** How long a request still waits for you, in minutes. */
  private minutesLeft(a: Approval): number {
    const t = this.o.config().timeouts
    const seconds = a.kind === 'question' ? t.questionSec : a.kind === 'review' ? t.reviewSec : t.approvalSec
    return Math.max(1, Math.round((a.createdAt + seconds * 1000 - this.o.now()) / 60_000))
  }

  /** Folders suggested the last time Add a folder was shown (so a tap on a number means that folder). */
  private folderSuggestions: FolderSuggestion[] = []

  private folderName(path: string): string {
    return folderLabel(path, { wsl: isWsl() })
  }

  private projectFoldersView(note?: string): ui.View {
    return ui.projectFoldersView(this.roots().map(path => ({ path, label: this.folderName(path) })), note)
  }

  /** Adds a project folder (a folder inside one already used is covered by it). */
  private addRoot(path: string): { ok: boolean; text: string } {
    if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, text: `${this.folderName(path)} isn't a folder. Send another, or tap Back.` }
    const roots = this.roots()
    const covering = roots.find(r => inside(r, path))
    if (covering) return { ok: true, text: `${this.folderName(path)} is already covered by ${this.folderName(covering)}.` }
    const config = this.o.config()
    config.folders.roots = [...roots.filter(r => !inside(path, r) && !inside(r, path)), path]
    this.o.saveConfig(config)
    // The folder map follows the new roots; reading a big folder can take a while.
    void this.o.folders.rebuild().catch(err => this.o.log(`telegram: rebuilding the folder map failed: ${errorText(err)}`))
    return { ok: true, text: `Added ${this.folderName(path)}.` }
  }

  /** Stops using the n-th project folder (never the last one). */
  private removeRoot(n: number): string {
    const roots = this.roots()
    const gone = roots[n]
    if (gone === undefined) return 'That folder is already gone from the list.'
    if (roots.length === 1) return 'Keep at least one folder. Add another first.'
    const config = this.o.config()
    config.folders.roots = roots.filter((_, i) => i !== n)
    this.o.saveConfig(config)
    return `Stopped using ${this.folderName(gone)}.`
  }

  private settingsView(): ui.View {
    const config = this.o.config()
    return ui.settingsView({
      notify: config.notify,
      folders: this.o.folders.size,
      builtAt: this.o.folders.builtAt,
      roots: this.roots(),
      models: config.models,
      watch: config.watchSessions,
      autoContinue: config.autoContinueChats,
      parallel: this.o.runner.parallel,
      now: this.o.now(),
    })
  }

  // --- this computer ------------------------------------------------------------------

  /** This computer: staying awake and sleeping. */
  private async showMac(chat: number, messageId?: number): Promise<void> {
    const mac = this.o.mac
    if (!mac) return void (await this.sendText(chat, NO_POWER))
    const view = ui.macView(await mac.status(), this.o.now())
    if (messageId) await this.edit(chat, messageId, view)
    else await this.send(chat, view)
  }

  /**
   * m:k awake while tasks run, on/off · m:l with the lid closed too, on/off · m:a:<hours> awake for
   * that long (0: stop) · m:s sleep now (asks twice; m:S already asked) · m:d sleep when done, on/off
   * (m:D on) · m:r refresh.
   */
  private async onMacButton(chat: number, message: TgMessage | undefined, op: string, arg?: string): Promise<string | undefined> {
    const mac = this.o.mac
    if (!mac) return NO_POWER
    const at = message?.message_id
    const refresh = async () => {
      if (at) await this.showMac(chat, at).catch(() => {})
    }
    switch (op) {
      case 'k': {
        const r = mac.keepAwake(!(await mac.status()).keepAwake)
        await refresh()
        return r.text
      }
      case 'l': {
        const r = await mac.lidClosed(!(await mac.status()).lidClosed.on)
        await refresh()
        return r.text
      }
      case 'a': {
        const hours = Number(arg)
        const r = mac.stayAwake({ hours: hours > 0 ? hours : null, by: 'Telegram' })
        await refresh()
        return r.text
      }
      case 'r':
        await refresh()
        return 'Up to date.'
      case 's':
      case 'S': {
        if (op === 's' && !(await this.secondTap(chat, message, 'Yes, sleep now'))) return `Tap again to put the ${mac.word} to sleep.`
        const r = await mac.sleepNow({ by: 'Telegram' })
        await refresh()
        if (!r.ok) await this.sendText(chat, r.text)
        return r.ok ? 'Going to sleep.' : "It didn't sleep."
      }
      case 'd':
      case 'D': {
        const on = op === 'D' || !(await mac.status()).sleepWhenDone.on
        const r = await mac.sleepWhenDone({ on, by: 'Telegram' })
        await refresh()
        return r.text
      }
    }
    return undefined
  }

  // --- buttons ----------------------------------------------------------------------

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    if (this.owner === null || q.from.id !== this.owner) {
      await this.o.api.answerCallbackQuery(q.id).catch(() => {})
      return
    }
    const chat = q.message?.chat.id ?? this.owner
    const raw = q.data ?? ''
    const confirmed = raw.endsWith('!')
    const data = confirmed ? raw.slice(0, -1) : raw
    this.tapping = { data, confirmed }
    const [kind, ...parts] = data.split(':')
    let toast: string | undefined
    try {
      switch (kind) {
        case 'd':
          toast = await this.onDraftButton(chat, q.message, Number(parts[0]), parts.slice(1))
          break
        case 'a':
          toast = await this.onApprovalButton(chat, q.message, parts[0]!, parts[1]!)
          break
        case 'o':
          toast = await this.onQuestionButton(chat, q.message, parts[0]!, parts[1]!)
          break
        case 'j':
          toast = await this.onJobButton(chat, q.message, Number(parts[0]), parts[1]!)
          break
        case 'g':
          toast = await this.onGlobalButton(chat, q.message, parts)
          break
        case 'w':
          toast = await this.onChatButton(chat, q.message, parts[0]!, parts[1]!)
          break
        case 'c':
          toast = await this.onChatsButton(chat, q.message, parts[0]!, parts[1])
          break
        case 'm':
          toast = await this.onMacButton(chat, q.message, parts[0]!, parts[1])
          break
      }
    } catch (err) {
      toast = 'Something went wrong.'
      this.o.log(`telegram: button ${q.data} failed: ${errorText(err)}`)
    } finally {
      this.tapping = null
    }
    await this.o.api.answerCallbackQuery(q.id, toast ? toast.slice(0, 190) : undefined).catch(() => {})
  }

  private async onApprovalButton(chat: number, message: TgMessage | undefined, code: string, op: string): Promise<string> {
    const approval = this.o.store.getApproval(code)
    // From Status: the status refreshes rather than losing its buttons.
    const status = message && this.statusMessages.has(message.message_id) ? message.message_id : null
    if (!approval || approval.status !== 'pending') {
      const line = approval ? `Already ${approval.status}.` : 'Already handled.'
      if (status !== null) await this.showStatus(chat, status)
      else await this.settle(chat, message, line)
      return line
    }
    if (op === 'show') return this.showRequest(chat, approval)
    if (op === 'c') {
      this.setPending({ kind: 'changes', code })
      await this.ask(chat, 'What should Claude change in the plan? Send it as your next message.', 'What to change in the plan')
      return 'Waiting for your changes.'
    }
    // y/n; r<n>: allow and apply Claude Code's n-th suggested rule; me/my: approve the plan, then accept edits / skip prompts.
    const rule = /^r(\d)$/.exec(op)
    const mode = op === 'me' ? 'acceptEdits' : op === 'my' ? 'bypassPermissions' : undefined
    if (op !== 'y' && op !== 'n' && !rule && !mode) return 'Not a choice here.'
    const reply = this.o.runner.answer(code, op === 'n' ? 'deny' : 'allow', null, { ...(rule ? { rule: Number(rule[1]) } : {}), ...(mode ? { mode } : {}) })
    await this.settleRequest(chat, code, reply, status === null ? message : undefined)
    if (status !== null) await this.showStatus(chat, status)
    return reply
  }

  /** A waiting question or plan, sent again (from Status); its buttons move to the new message. */
  private async showRequest(chat: number, a: Approval): Promise<string> {
    const job = this.o.store.getJob(a.jobId)
    if (!job) return 'That task is gone.'
    const before = this.requests.get(a.code)
    let msg: TgMessage
    if (a.kind === 'question') {
      const state = this.questions.get(a.code) ?? { ...ui.newQuestionState(), messageId: 0 }
      msg = await this.send(chat, ui.questionView(job, a.code, questionsOf(a), state, this.minutesLeft(a)))
      this.questions.set(a.code, { ...state, messageId: msg.message_id })
    } else if (a.kind === 'review') {
      msg = await this.send(chat, ui.noticeView({ type: 'plan_review', job, code: a.code }, this.noticeContext()))
    } else {
      return 'Answer it with the buttons on the status.'
    }
    this.requests.set(a.code, msg.message_id)
    if (before !== undefined) await this.settleMessage(chat, before, 'Moved further down.').catch(() => {})
    return 'Sent again below.'
  }

  private async onQuestionButton(chat: number, message: TgMessage | undefined, code: string, arg: string): Promise<string> {
    const approval = this.o.store.getApproval(code)
    const job = approval ? this.o.store.getJob(approval.jobId) : null
    if (!approval || approval.status !== 'pending' || !job) {
      const line = approval ? `Already ${approval.status}.` : 'Already handled.'
      await this.settle(chat, message, line)
      return line
    }
    const questions = questionsOf(approval)
    const state = this.questions.get(code) ?? { ...ui.newQuestionState(), messageId: message?.message_id ?? 0 }
    if (message) state.messageId = message.message_id
    this.questions.set(code, state)
    const [stepText, op] = arg.split('.') as [string, string | undefined]
    // A tap on a screen that has moved on (or an old message): show where you are.
    if (Number(stepText) !== state.step || op === undefined) {
      await this.showQuestion(chat, job, approval, state)
      return 'That question has moved on.'
    }
    const q = questions[state.step]
    if (!q) return 'That question is gone.'
    switch (op) {
      case 't':
        this.setPending({ kind: 'answer', code, step: state.step })
        await this.ask(chat, `Type your answer to “${ui.clip(q.question, 200)}” as your next message.`, 'Your answer')
        return 'Waiting for your answer.'
      case 'b': {
        if (state.step > 0) state.step--
        const earlier = state.answers[state.step]
        state.ticked = earlier && 'picks' in earlier ? [...earlier.picks] : []
        await this.showQuestion(chat, job, approval, state)
        return 'Back.'
      }
      case 'd':
        if (state.ticked.length === 0) return 'Tick at least one, or type your own answer.'
        return this.answerStep(chat, code, job, questions, state, { picks: [...state.ticked].sort((a, b) => a - b) })
      default: {
        const option = Number(op)
        const label = q.options?.[option]?.label
        if (label === undefined) return 'That option is gone.'
        if (!q.multiSelect) return this.answerStep(chat, code, job, questions, state, { picks: [option] })
        const ticked = state.ticked.includes(option)
        state.ticked = ticked ? state.ticked.filter(i => i !== option) : [...state.ticked, option]
        await this.showQuestion(chat, job, approval, state)
        return ticked ? `Unticked ${label}` : `Ticked ${label}`
      }
    }
  }

  /** Keeps the answer to the current question, then shows the next one, or sends them all to Claude. */
  private async answerStep(
    chat: number,
    code: string,
    job: Job,
    questions: Question[],
    state: ui.QuestionState & { messageId: number },
    answer: QuestionAnswer,
    o: { below?: boolean } = {},
  ): Promise<string> {
    state.answers[state.step] = answer
    state.step++
    if (state.step < questions.length) {
      const next = state.answers[state.step]
      state.ticked = next && 'picks' in next ? [...next.picks] : []
      const approval = this.o.store.getApproval(code)
      if (approval && o.below) {
        // The next question, with its buttons, where you are; the old message loses its buttons.
        const before = state.messageId
        const msg = await this.send(chat, ui.questionView(job, code, questions, state, this.minutesLeft(approval)))
        state.messageId = msg.message_id
        this.requests.set(code, msg.message_id)
        if (before) await this.settleMessage(chat, before, '↓ Continues below.').catch(() => {})
        return `Got it. Question ${state.step + 1} of ${questions.length} is below.`
      }
      if (approval) await this.showQuestion(chat, job, approval, state)
      return `Got it. Question ${state.step + 1} of ${questions.length}.`
    }
    this.questions.delete(code)
    this.requests.delete(code)
    const reply = this.o.runner.answer(code, 'answer', describeAnswers(questions, state.answers))
    if (state.messageId) await this.edit(chat, state.messageId, ui.answeredView(job, questions, state.answers))
    return reply
  }

  private async showQuestion(chat: number, job: Job, approval: Approval, state: ui.QuestionState & { messageId: number }): Promise<void> {
    if (!state.messageId) return
    await this.edit(chat, state.messageId, ui.questionView(job, approval.code, questionsOf(approval), state, this.minutesLeft(approval)))
  }

  /** After a task's button: the card, list or status it was on shows again; elsewhere, `line` closes the message. */
  private async afterJobTap(chat: number, message: TgMessage | undefined, line: string | null): Promise<void> {
    const at = message?.message_id
    const card = at !== undefined ? [...this.cards].find(([, c]) => c.messageId === at) : undefined
    const cardJob = card ? this.o.store.getJob(card[0]) : null
    if (at !== undefined && this.queueMessages.has(at)) await this.showQueue(chat, at)
    else if (at !== undefined && this.statusMessages.has(at)) await this.showStatus(chat, at)
    else if (at !== undefined && this.peekMessages.has(at)) await this.showPeek(chat, at, undefined, this.peekMessages.get(at))
    else if (at !== undefined && card && cardJob) await this.edit(chat, at, ui.taskCard(cardJob, card[1].card, this.uiContext()))
    else if (line !== null) await this.settle(chat, message, line)
  }

  private async onJobButton(chat: number, message: TgMessage | undefined, id: number, op: string): Promise<string | undefined> {
    const job = this.o.store.getJob(id)
    if (!job) return `No task #${id}.`
    const active = this.o.store.running().some(j => j.id === id)
    let reply: string
    switch (op) {
      case 'open': {
        // From Tasks: what that task did, with its buttons (follow up, link, branch).
        const view =
          job.status === 'done'
            ? ui.noticeView({ type: 'done', job, diff: null, next: null }, this.noticeContext())
            : job.status === 'failed'
              ? ui.noticeView({ type: 'failed', job, reason: job.error ?? 'It failed.' }, this.noticeContext())
              : { html: `<b>#${id}</b> was ${ui.esc(job.status)} · ${ui.esc(this.uiContext().label(job.projectDir))}${job.prompt ? `\n“${ui.esc(ui.clip(job.prompt, 500))}”` : ''}` }
        await this.send(chat, view)
        return
      }
      case 'peek':
        await this.showPeek(chat, undefined, id)
        return
      case 'stop':
        if (!active) return `#${id} isn't running.`
        reply = await this.o.runner.stop(id)
        await this.afterJobTap(chat, message, null)
        return reply
      case 'link': {
        const asked = this.o.runner.requestLink(id, 'telegram')
        if (asked.ok && message) await this.settle(chat, message, asked.text)
        return asked.text
      }
      case 'kill': {
        if (job.status !== 'running' && job.status !== 'held' && job.status !== 'queued') return `#${id} has already ended.`
        if (!(await this.secondTap(chat, message, `Yes, kill #${id}`))) return `Tap again to end #${id} now: Claude and everything it started stop.`
        reply = await this.o.runner.kill(id, { by: 'Telegram' })
        await this.afterJobTap(chat, message, reply)
        return reply
      }
      case 'go':
        if (!active) return `#${id} isn't running.`
        reply = await this.o.runner.go(id)
        await this.afterJobTap(chat, message, null)
        return reply
      case 'now':
        return active ? this.o.runner.continueNow() : `#${id} isn't waiting for a usage limit any more.`
      case 'fork':
        return active ? this.o.runner.fork(id) : `#${id} isn't waiting any more.`
      case 'take':
        if (!active) return `#${id} isn't waiting any more.`
        reply = await this.o.runner.takeover(id)
        await this.settle(chat, message, reply)
        return reply
      case 'skip':
        if (active) reply = await this.o.runner.skip(undefined, id)
        else if (job.status === 'queued') reply = await this.o.runner.remove(id)
        else return `#${id} is already ${job.status}.`
        await this.settle(chat, message, reply)
        return reply
      case 'top':
        reply = this.o.runner.top(id)
        break
      case 'up':
      case 'down': {
        const at = this.o.store.queued().findIndex(j => j.id === id)
        if (at < 0) return `#${id} isn't waiting in the queue.`
        this.o.store.moveTo(id, Math.max(0, at + (op === 'up' ? -1 : 1)))
        reply = `#${id} moved ${op}.`
        break
      }
      case 'hold':
      case 'rel':
        reply = this.o.runner.holdQueued(id, op === 'hold')
        break
      case 'rm': {
        if (job.status !== 'queued') return `#${id} isn't waiting in the queue any more.`
        if (!(await this.secondTap(chat, message, 'Yes, remove'))) return `Tap again to take #${id} off the queue.`
        reply = await this.o.runner.remove(id)
        const at = message?.message_id
        if (at !== undefined && this.queueMessages.has(at)) await this.showQueue(chat, at, null)
        else await this.settle(chat, message, reply)
        return reply
      }
      case 'plan':
        if (!job.planText) return 'No plan yet.'
        await this.send(chat, ui.planView(job, this.uiContext()))
        return
      case 'fu':
        if (!job.sessionId) return 'That task has no conversation to continue.'
        this.setPending({ kind: 'followup', jobId: id })
        await this.ask(chat, `What should Claude do next in #${id}'s conversation? Send it as your next message.`, `Next, in #${id}'s conversation`)
        return 'Waiting for the follow-up.'
      case 'new': {
        // New task here: a fresh conversation in that task's folder.
        if (!existsSync(job.projectDir)) return 'That folder is gone.'
        const d = this.state.addDraft({ ...this.choices(), folder: job.projectDir, prompt: '', newChat: true }, this.o.now())
        await this.showDraft(chat, d)
        this.setPending({ kind: 'prompt', draftId: d.id })
        return 'Send what Claude should do there.'
      }
      case 'edit': {
        // Change: a card with the task's choices; Save puts them on the task.
        if (job.status !== 'queued') return `#${id} isn't waiting in the queue any more.`
        const d = this.state.addDraft(
          {
            prompt: job.prompt,
            folder: job.projectDir,
            plan: job.plan,
            review: job.review,
            execMode: job.execMode,
            model: job.model,
            workModel: job.workModel,
            effort: job.effort,
            workEffort: job.workEffort,
            isolate: job.isolate,
          },
          this.o.now(),
        )
        await this.showDraft(
          chat,
          this.state.updateDraft(d.id, { editJob: id, wantLink: job.wantLink, notBefore: job.repeatDaily !== null ? null : job.notBefore, repeatDaily: job.repeatDaily, afterJob: job.afterJob, maxMinutes: job.maxMinutes }),
        )
        return `Changing #${id}.`
      }
      case 'merge':
      case 'pr':
      case 'discard': {
        const git = this.o.git
        if (!git) return `Not here: settle the branch on the ${this.word}.`
        // Throwing a branch away, and a pull request (which pushes it out of this computer), ask twice.
        if (op === 'discard' && !(await this.secondTap(chat, message, 'Yes, discard'))) return `Tap again to throw away #${id}'s branch.`
        if (op === 'pr' && !(await this.secondTap(chat, message, 'Yes, push it'))) return `Tap again to push #${id}'s branch and open a pull request.`
        const r = await settleBranch(this.o.store, git, id, op)
        await this.sendText(chat, r.text)
        return r.ok ? (op === 'merge' ? 'Merged.' : op === 'pr' ? 'Pull request opened.' : 'Thrown away.') : "It didn't work."
      }
      default:
        return
    }
    // Move, hold, run next: the queue they were tapped on shows again.
    await this.afterJobTap(chat, message, null)
    return reply
  }

  // --- your chats -------------------------------------------------------------------

  private focus(): Focus | null {
    return this.o.store.kvGet<Focus | null>('telegram.focus') ?? null
  }

  private setFocus(f: Focus | null): void {
    this.o.store.kvSet('telegram.focus', f)
  }

  private noticeContext(): ui.NoticeContext {
    return { ...this.uiContext(), now: this.o.now() }
  }

  private async showChats(chat: number, page: number, messageId?: number): Promise<void> {
    const { chats, more } = this.o.chats.recent(page, ui.CHATS_PER_PAGE)
    const view = ui.recentChatsView(chats, page, more, this.noticeContext())
    if (messageId) await this.edit(chat, messageId, view)
    else await this.send(chat, view)
  }

  /** Leaves the chat you're in. `quiet`: only if you were in one, and with no reply (another action follows). */
  private async leaveChat(chat: number, quiet = false): Promise<void> {
    const f = this.focus()
    if (!f && quiet) return
    this.setFocus(null)
    if (quiet) return
    await this.send(chat, { html: f ? `Left “${ui.esc(ui.clip(f.title, 80))}”. New messages make new tasks again.` : "You're not in a chat." }, this.keys())
  }

  /** c:… buttons: Chats pages, a chat's view, Write here, Full reply, Leave. */
  private async onChatsButton(chat: number, message: TgMessage | undefined, op: string, arg?: string): Promise<string | undefined> {
    const at = message?.message_id
    if (op === 'l') {
      await this.showChats(chat, Math.max(0, Number(arg) || 0), at)
      return
    }
    if (op === 'x') {
      await this.leaveChat(chat)
      return 'Left the chat.'
    }
    const c = arg ? this.o.chats.get(arg) : null
    if (!c?.cwd) return 'That chat is gone.'
    switch (op) {
      case 'o': {
        const view = ui.chatView(c, this.noticeContext(), this.focus()?.sessionId === c.sessionId)
        if (at) await this.edit(chat, at, view)
        else await this.send(chat, view)
        return
      }
      case 'w':
        this.setFocus({ sessionId: c.sessionId, title: c.title })
        this.setPending(null)
        await this.send(chat, { html: ui.enteredChatHtml(c, this.noticeContext()) }, this.keys())
        return `In “${ui.clip(c.title, 60)}”`
      case 'r':
        await this.send(
          chat,
          ui.longView(`<b>${ui.esc(ui.clip(c.title, 120))}</b> · Claude's last reply`, c.lastReply ?? '(no reply yet)', undefined, {
            name: `reply-${c.sessionId.slice(0, 8)}.md`,
            caption: "Claude's full reply",
          }, { silent: true }),
        )
        return
      default:
        return
    }
  }

  /** What you type inside a chat: typed into it if the queue is running it, else a task that continues it. */
  private async sendToChat(chat: number, f: Focus, text: string, files: string[] = []): Promise<void> {
    const c = this.o.chats.get(f.sessionId)
    if (!c?.cwd || !existsSync(c.cwd)) {
      this.setFocus(null)
      await this.send(chat, { html: "That chat is gone, so you've left it. New messages make new tasks again." }, this.keys())
      return
    }
    const name = `“${ui.clip(c.title, 60)}”`
    // Files: Claude is told where they are and to read them (the uploads folder is readable to it).
    if (!text) text = files.length === 1 ? 'Have a look at this.' : 'Have a look at these.'
    const typed = await this.o.runner.typeIfFree(c.sessionId, files.length ? withAttachments(text, files) : text)
    if (typed !== null) {
      await this.sendText(chat, `Typed into ${name} (#${typed}). Claude reads it when its current step ends.`)
      return
    }
    const choices = this.choices()
    const job = this.o.runner.enqueue({
      ...continueSpec({ ...c, cwd: c.cwd }, { model: choices.model, effort: choices.effort, takeover: c.where !== null, source: 'telegram', prompt: text }),
      ...(files.length ? { attachments: files } : {}),
    })
    const take = c.where && !c.running ? ` It's open in ${c.where}: it closes there first.` : ''
    await this.sendText(chat, `Sent to ${name} as #${job.id}. ${this.whenText(job)}${take}`)
  }

  /** Buttons on "your chat in VS Code hit a usage limit". */
  private async onChatButton(chat: number, message: TgMessage | undefined, sessionId: string, op: string): Promise<string | undefined> {
    if (op === 'x') {
      const w = this.o.store.getWatch(sessionId)
      const waiting = w && (w.state === 'waiting' || w.state === 'sent')
      if (waiting) this.o.store.setWatchState(sessionId, 'cancelled', this.o.now())
      const line = waiting ? "OK, it won't be continued." : 'Ignored.'
      await this.settle(chat, message, line)
      return line
    }
    const c = this.o.chats.get(sessionId)
    if (!c?.cwd || !existsSync(c.cwd)) {
      await this.settle(chat, message, 'That chat is gone.')
      return 'That chat is gone.'
    }
    const choices = this.choices()
    if (op === 'f') {
      const draft = this.state.addDraft({ ...choices, folder: c.cwd, prompt: '', sessionId, takeover: c.where !== null, isolate: false }, this.o.now())
      await this.showDraft(chat, draft)
      this.setPending({ kind: 'prompt', draftId: draft.id })
      return 'Send what Claude should do next.'
    }
    if (op !== 'c') return
    const pending = this.o.store.pendingForSession(sessionId)
    if (pending) return `Already queued as #${pending.id}.`
    const job = this.o.runner.enqueue(continueSpec({ ...c, cwd: c.cwd }, { model: choices.model, effort: choices.effort, takeover: true, source: 'telegram' }))
    // It continues here now, so the automatic continue at the reset isn't needed.
    if (this.o.store.getWatch(sessionId)) this.o.store.setWatchState(sessionId, 'handed', this.o.now(), { jobId: job.id })
    await this.settle(chat, message, `Queued #${job.id}. ${this.whenText(job)}`)
    return `Queued #${job.id}.`
  }

  private async onGlobalButton(chat: number, message: TgMessage | undefined, parts: string[]): Promise<string | undefined> {
    const at = message?.message_id
    const refresh = async () => {
      if (at && this.queueMessages.has(at)) await this.showQueue(chat, at)
      else await this.showStatus(chat, at)
    }
    switch (parts[0]) {
      case 'st':
        await this.showStatus(chat, at)
        return 'Up to date.'
      case 'q':
        await this.showQueue(chat, at && this.queueMessages.has(at) ? at : undefined)
        return 'Up to date.'
      case 'qs': {
        // A task picked in the queue (0: none): its buttons show under the numbers.
        const id = Number(parts[1]) || null
        await this.showQueue(chat, at && this.queueMessages.has(at) ? at : undefined, id)
        return
      }
      case 'peek':
      case 'pk': {
        const id = parts[1] ? Number(parts[1]) : undefined
        await this.showPeek(chat, at && this.peekMessages.has(at) ? at : undefined, id, parts[0] === 'pk')
        return
      }
      case 'pause':
        this.o.runner.setPaused(true)
        await refresh()
        return 'Paused.'
      case 'resume': {
        const reply = await this.o.runner.go()
        await refresh()
        return reply
      }
      case 'notify': {
        const level = parts[1]
        if (level !== 'all' && level !== 'important' && level !== 'off') return
        const config = this.o.config()
        config.notify = level
        this.o.saveConfig(config)
        if (at) await this.edit(chat, at, this.settingsView())
        return `Notifications: ${level}`
      }
      case 'clear': {
        if (this.o.store.queued().length === 0) return 'The queue is already empty.'
        if (!(await this.secondTap(chat, message, 'Yes, clear'))) return 'Tap again to take every task off the queue.'
        const removed = this.o.runner.clear()
        await this.showQueue(chat, at && this.queueMessages.has(at) ? at : undefined, null)
        return removed.length === 0 ? 'The queue is already empty.' : `Took ${removed.length} off the queue.`
      }
      case 'tasks':
        await this.showTasks(chat, undefined, undefined, Number(parts[1]) || undefined)
        return
      case 'tsearch':
        this.setPending({ kind: 'tasksearch' })
        await this.ask(chat, 'Type words from the prompt or the answer.', 'Words to find')
        return 'Waiting for the words.'
      case 'par': {
        const n = Number(parts[1])
        if (!Number.isInteger(n) || n < 1 || n > 3) return
        this.o.saveConfig({ ...this.o.config(), parallel: n })
        if (at) await this.edit(chat, at, this.settingsView())
        return n === 1 ? 'One task at a time.' : `Up to ${n} tasks at once.`
      }
      case 'set':
        if (at) await this.edit(chat, at, this.settingsView())
        return
      case 'pf': {
        const sub = parts[1]
        if (sub === 'ok') {
          await this.settle(chat, message, 'Good. You can change this any time in Settings → Project folders.')
          return 'Saved.'
        }
        if (sub === 'a') {
          this.folderSuggestions = suggestProjectFolders({ have: this.roots(), wsl: isWsl() })
          const view = ui.addFolderView(this.folderSuggestions.map(f => ({ ...f, label: this.folderName(f.path) })))
          if (at) await this.edit(chat, at, view)
          else await this.send(chat, view)
          return
        }
        if (sub === 't') {
          this.setPending({ kind: 'rootpath' })
          await this.ask(chat, 'Send the folder, like D:\\Projects or ~/code.', 'A folder')
          return 'Waiting for the folder.'
        }
        let note: string | undefined
        if (sub === 's') {
          const found = this.folderSuggestions[Number(parts[2])]
          if (!found) return 'Those suggestions are out of date. Tap Add a folder again.'
          note = this.addRoot(found.path).text
        } else if (sub === 'r') {
          note = this.removeRoot(Number(parts[2]))
        }
        const view = this.projectFoldersView(note)
        if (at) await this.edit(chat, at, view)
        else await this.send(chat, view)
        return note
      }
      case 'rescan':
        await this.o.folders.rebuild()
        if (at) await this.edit(chat, at, this.settingsView())
        return `Folder map rebuilt: ${this.o.folders.size} folders.`
      case 'type': {
        const running = this.o.store.running()
        const id = parts[1] ? Number(parts[1]) : undefined
        if (id === undefined && running.length > 1) {
          await this.send(chat, ui.runningPickerView(running, 'type', this.noticeContext()))
          return
        }
        const job = id !== undefined ? running.find(j => j.id === id) : running[0]
        if (!job) return 'Nothing is running.'
        this.setPending({ kind: 'say', job: job.id })
        await this.ask(chat, `Send what to type into #${job.id}. It's typed as you write it, then Enter.`, `Typed into #${job.id}`)
        return 'Waiting for what to type.'
      }
      case 'keys': {
        // The keypad, on a task's screen (from older messages' Keys button).
        const id = parts[1] ? Number(parts[1]) : undefined
        await this.showPeek(chat, undefined, id, true)
        return
      }
      case 'k': {
        if (!parts[1]) return
        const id = parts[2] ? Number(parts[2]) : undefined
        const reply = await this.o.runner.keys([parts[1]], id)
        // On a screen: it shows again, a moment later, with what the key did.
        if (at && this.peekMessages.has(at)) {
          await (this.o.pause ?? Bun.sleep)(400)
          await this.showPeek(chat, at, id, true)
        }
        return reply
      }
      case 'watch': {
        const config = this.o.config()
        config.watchSessions = !config.watchSessions
        // Without watching there is nothing to continue: it goes with it.
        if (!config.watchSessions) config.autoContinueChats = false
        this.o.saveConfig(config)
        if (at) await this.edit(chat, at, this.settingsView())
        return config.watchSessions ? 'Watching your other chats.' : 'Not watching your other chats.'
      }
      case 'auto': {
        const config = this.o.config()
        // Off while chats aren't watched, so a tap turns it on, and watching with it.
        config.autoContinueChats = !(config.autoContinueChats && config.watchSessions)
        if (config.autoContinueChats) config.watchSessions = true
        this.o.saveConfig(config)
        if (at) await this.edit(chat, at, this.settingsView())
        return config.autoContinueChats ? 'Your chats continue by themselves after a usage limit.' : "I'll only tell you when a chat hits a usage limit."
      }
      default:
        return
    }
  }
}
