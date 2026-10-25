import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Hello } from '@afterhours/protocol'
import { BRAND } from '../shared/brand'
import { codeRoots, type Config } from '../shared/config'
import type { Approval, Job, JobSpec } from '../shared/types'
import { continueSpec, type Chat, type ChatSource } from '../daemon/chats'
import { parseQueueText, type CommandContext } from '../daemon/commands'
import { listChildren, parentWithin, relativeToRoots, type FolderMap } from '../daemon/folders'
import { formatClock } from '../daemon/limits'
import { settleBranch, type BranchGit } from '../daemon/branches'
import type { MacControl } from '../daemon/mac'
import { describeAnswers, type Notice, type Question, type QuestionAnswer } from '../daemon/notify'
import type { Runner } from '../daemon/runner'
import type { Store } from '../daemon/store'
import { refusedButtons, refusedFormatting, type BotApi, type InlineKeyboard, type Markup, type TgCallbackQuery, type TgMessage, type TgUpdate } from './api'
import { htmlToText, telegramHtmlProblem } from './markdown'
import { LATER, parseWhen } from './when'
import { TelegramState, type Choices, type Draft } from './state'
import * as ui from './ui'
import { checkInitData } from './webapp'

/** The app inside Telegram (a Mini App), which this machine serves once `cq app setup` ran. */
export interface TelegramAppLink {
  /** Its public address (https://…), or null while it isn't set up. */
  url(): string | null
  /** This machine's id in the app's addresses, and its name. */
  machine(): { id: string; name: string } | null
  /** Whether a device paired from inside Telegram can reach this machine. */
  paired(): boolean
  /** A one-time pairing link for the bot's owner; `verify` approves the app's Hello, or refuses it. */
  offer(verify: (hello: Hello) => boolean): { link: string; expires: number } | string
}

export interface TelegramOptions {
  api: BotApi
  store: Store
  runner: Runner
  folders: FolderMap
  /** Your Claude Code conversations, for 💬 Chat… and the usage-limit hand-off. */
  chats: ChatSource
  config: () => Config
  saveConfig: (config: Config) => void
  /** For reusing the text commands' status output. */
  commandContext: () => CommandContext
  /** The app inside Telegram: short messages with Open ↗, the menu button, /app. */
  app?: TelegramAppLink
  /** Quitting apps and sleeping the Mac; null or missing on other systems. */
  mac?: MacControl | null
  /** For 🌿 Merge and 🗑 Discard on a task that ran on its own branch. */
  git?: BranchGit
  now: () => number
  log: (line: string) => void
}

/** Something the bot asked you to type next. */
type Pending =
  | { kind: 'prompt'; draftId: number }
  /** ⏰ Later: a time you type for a card. */
  | { kind: 'later'; draftId: number }
  | { kind: 'search'; draftId: number }
  /** An answer you type: to one question of a set (`step`), or to all of them. */
  | { kind: 'answer'; code: string; step?: number }
  | { kind: 'changes'; code: string }
  | { kind: 'followup'; jobId: number }
  | { kind: 'say' }

/** The chat you're inside (💬 Chats → ✍️ Write here): what you type goes into it. */
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
  { command: 'app', description: 'Open Afterhours here, or set it up' },
  { command: 'new', description: 'Pick a folder, then send the prompt' },
  { command: 'chats', description: 'Your recent chats, from any project' },
  { command: 'leave', description: 'Leave the chat you are in' },
  { command: 'queue', description: 'Waiting and running jobs' },
  { command: 'status', description: 'Current job and usage limits' },
  { command: 'peek', description: "The running job's screen" },
  { command: 'kill', description: 'End the running task now, and what it started' },
  { command: 'mac', description: "What's open on the Mac: quit an app, or sleep" },
  { command: 'sleep', description: 'Put the Mac to sleep' },
  { command: 'pause', description: 'Stop starting new jobs' },
  { command: 'resume', description: 'Resume the queue or a paused job' },
  { command: 'settings', description: 'Notifications and the folder map' },
  { command: 'cancel', description: 'Never mind what you asked me to type' },
  { command: 'help', description: 'How this works' },
]

/** Plain words that act as commands rather than becoming a prompt. */
const WORDS: Record<string, string> = {
  status: 'status',
  st: 'status',
  queue: 'queue',
  ls: 'queue',
  peek: 'peek',
  pause: 'pause',
  resume: 'resume',
  go: 'resume',
  help: 'help',
  mac: 'mac',
  apps: 'mac',
  sleep: 'sleep',
}

const PENDING_TTL = 30 * 60_000
const KILL_CONFIRM_MS = 15_000
const MAX_PAIR_ATTEMPTS = 5

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A message's text without formatting, within Telegram's limit: what's sent when formatting fails. */
function plain(html: string): string {
  return ui.esc(ui.clip(htmlToText(html), 4000))
}

/** A keyboard without its app buttons (Open ↗), for when Telegram won't take them. */
function withoutAppButtons(keyboard: InlineKeyboard | undefined): InlineKeyboard | undefined {
  return keyboard?.map(row => row.filter(b => !b.web_app)).filter(row => row.length > 0)
}

/** The line added to a request's message once it was settled somewhere else. */
function settledLine(a: Approval | null): string {
  switch (a?.status) {
    case 'allowed':
      return '✅ Allowed elsewhere.'
    case 'denied':
      return '❌ Declined elsewhere.'
    case 'answered':
      return '✅ Answered elsewhere.'
    case 'expired':
      return "⏱ Expired: Claude was told you're away."
    default:
      return 'No longer waiting.'
  }
}

function questionsOf(a: Approval): Question[] {
  return ((a.payload as { questions?: Question[] } | null)?.questions ?? []) as Question[]
}

export class TelegramBridge {
  private state: TelegramState
  private running = false
  private abort = new AbortController()
  private botName: string | null = null
  private error: string | null = null
  private pending: (Pending & { at: number }) | null = null
  /** HTML of recent messages with buttons, so a tap can update them in place. */
  private sent = new Map<number, string>()
  /** Messages showing the queue, refreshed after ⬆️/🗑 taps. */
  private queueMessages = new Set<number>()
  /** Where you are in answering each set of Claude's questions, by request code. */
  private questions = new Map<string, ui.QuestionState & { messageId: number }>()
  /** Each running task's card (its "started" message), edited as the task goes on. */
  private cards = new Map<number, { messageId: number; card: ui.Card }>()
  /** The message holding each request's buttons, by code, to tidy up once it's settled anywhere. */
  private requests = new Map<string, number>()
  /** Messages showing 📊 Status or 👀 Peek, refreshed in place. */
  private statusMessages = new Set<number>()
  private peekMessages = new Set<number>()
  private ticking = false
  private pairAttempts = new Map<number, number>()
  /** 🛑 Kill tapped once, by task: a second tap within KILL_CONFIRM_MS kills it. */
  private killArmed = new Map<number, number>()
  /** 🧹 Clear tapped once: when. */
  private clearArmed = 0
  /** A Mac button tapped once (quit an app, sleep): the second tap within KILL_CONFIRM_MS does it. */
  private macArmed: { what: string; at: number } | null = null
  /** Other buttons that take a second tap (🗑 a branch), by what they do. */
  private armed = new Map<string, number>()
  private username: string | null = null
  /** The menu button last set, and when setting it last failed (tried again after a while). */
  private menuFailedAt = 0

  constructor(private o: TelegramOptions) {
    this.state = new TelegramState(o.store.db)
  }

  private get owner(): number | null {
    return this.o.config().telegram.ownerId
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
    await this.syncApp().catch(err => this.o.log(`telegram: ${errorText(err)}`))
    void this.loop()
    this.o.log(`telegram: ${this.botName ?? 'bot'} ${this.owner === null ? 'waiting to pair' : 'ready'}`)
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

  private remember(messageId: number, html: string): void {
    this.sent.set(messageId, html)
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
    let reply = view.keyboard ? { inline_keyboard: view.keyboard } : markup
    let html = this.checked(view.html)
    let msg: TgMessage
    try {
      msg = await this.o.api.sendMessage(chat, html, reply, { silent: view.silent })
    } catch (err) {
      if (refusedButtons(err) && view.keyboard) {
        this.o.log(`telegram: ${errorText(err)}; sending it without its app buttons`)
        reply = { inline_keyboard: withoutAppButtons(view.keyboard) ?? [] }
      } else if (refusedFormatting(err)) {
        this.o.log(`telegram: ${errorText(err)}; sending it as plain text`)
        html = plain(html)
      } else throw err
      msg = await this.o.api.sendMessage(chat, html, reply, { silent: view.silent })
    }
    if (view.keyboard) this.remember(msg.message_id, html)
    return msg
  }

  private async edit(chat: number, messageId: number, view: ui.View): Promise<void> {
    let html = this.checked(view.html)
    let keyboard = view.keyboard
    try {
      await this.o.api.editMessageText(chat, messageId, html, keyboard)
    } catch (err) {
      if (refusedButtons(err) && keyboard) keyboard = withoutAppButtons(keyboard)
      else if (refusedFormatting(err)) html = plain(html)
      else throw err
      await this.o.api.editMessageText(chat, messageId, html, keyboard)
    }
    this.remember(messageId, html)
  }

  private sendText(chat: number, text: string): Promise<TgMessage> {
    return this.send(chat, { html: ui.esc(text) })
  }

  /** Adds a closing line to a message and removes its buttons. */
  private async settle(chat: number, message: TgMessage | undefined, line: string): Promise<void> {
    if (message) await this.settleMessage(chat, message.message_id, line, message.text)
  }

  private async settleMessage(chat: number, messageId: number, line: string, text?: string): Promise<void> {
    const html = this.sent.get(messageId) ?? ui.esc(text ?? '')
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
      await this.syncApp().catch(err => this.o.log(`telegram: ${errorText(err)}`))
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
    return this.roots().some(r => path === r || path.startsWith(r + '/'))
  }

  private recent(): string[] {
    return this.o.store.recentFolders(8).filter(p => existsSync(p))
  }

  private uiContext(): ui.UiContext {
    const roots = this.roots()
    return {
      links: this.links(),
      now: this.o.now(),
      models: this.o.config().models,
      folderId: path => this.state.folderId(path),
      label: path => relativeToRoots(path, roots),
      hasConversation: folder => this.o.store.getThread(folder) !== null,
      chat: sessionId => this.o.chats.get(sessionId),
    }
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

  // --- the app inside Telegram -----------------------------------------------------------

  /** The app's address with the bot's name, so the app can send you back here to set it up. */
  private appHome(): string | null {
    const url = this.o.app?.url() ?? null
    return url ? `${url}/${this.username ? `?bot=${encodeURIComponent(this.username)}` : ''}` : null
  }

  /** Whether you turned the app inside Telegram on (/settings): off by default, so the bot does everything itself. */
  private appOn(): boolean {
    return this.o.store.kvGet<string>('telegram.messages') === 'short'
  }

  /** Short messages with Open ↗: the app is set up, paired from Telegram, and you turned it on. */
  private links(): ui.AppLinks | null {
    const base = this.o.app?.url() ?? null
    const machine = this.o.app?.machine() ?? null
    if (!base || !machine || !this.o.app!.paired() || !this.appOn()) return null
    return { base, machine: machine.id }
  }

  /** The buttons under the text box: none once the app has them all. */
  private mainKeyboard(): Markup {
    return this.links() ? { remove_keyboard: true } : ui.MAIN_KEYBOARD
  }

  /**
   * Keeps Telegram in step with the app inside it. While it's on, the menu button opens it and the
   * buttons under the text box go; otherwise the menu button shows the commands, and the buttons
   * come back (said once).
   */
  private async syncApp(): Promise<void> {
    const chat = this.owner
    if (chat === null) return
    const home = this.links() ? this.appHome() : null
    const set = this.o.store.kvGet<string>('telegram.menu') ?? ''
    if ((home ?? '') !== set && this.o.now() - this.menuFailedAt > 10 * 60_000) {
      try {
        await this.o.api.setChatMenuButton(chat, home ? { type: 'web_app', text: BRAND.name, web_app: { url: home } } : { type: 'commands' })
        this.o.store.kvSet('telegram.menu', home ?? '')
        this.o.log(home ? `telegram: the menu button opens ${home}` : 'telegram: the menu button shows the commands again')
      } catch (err) {
        this.menuFailedAt = this.o.now()
        throw new Error(`couldn't set the menu button: ${errorText(err)}`)
      }
    }
    const intro = this.o.store.kvGet<boolean>('telegram.appIntro') ?? false
    if (this.links() && !intro) {
      this.o.store.kvSet('telegram.appIntro', true)
      await this.send(
        chat,
        { html: `📱 <b>${ui.esc(BRAND.name)} now opens right here:</b> tap the ${ui.esc(BRAND.name)} button next to the text box.\nMessages from now on are a line or two; Open ↗ shows the rest. /settings turns this off.` },
        { remove_keyboard: true },
      )
    } else if (!this.links() && intro) {
      this.o.store.kvSet('telegram.appIntro', false)
      await this.send(
        chat,
        { html: '📋 <b>Messages are in full again</b>, with every button, and the buttons under the text box are back. The app inside Telegram is off; /settings turns it on.' },
        ui.MAIN_KEYBOARD,
      )
    }
  }

  /** /app: opens the app, or pairs this Telegram with the machine first. */
  private async showApp(chat: number, again = false): Promise<void> {
    const app = this.o.app
    const home = this.appHome()
    if (!app || !home) {
      await this.send(chat, {
        html: `📱 <b>The app inside Telegram isn't set up.</b>\nOn the Mac, run <code>cq app setup</code>: it shows each step. Until then, everything works here as it does now.`,
      })
      return
    }
    const machine = app.machine()
    if (app.paired() && !again) {
      await this.send(chat, {
        html: `📱 <b>${ui.esc(BRAND.name)}</b> opens from the button next to the text box, or here.`,
        keyboard: [[{ text: `Open ${BRAND.name}`, web_app: { url: home } }], [ui.btn('Pair it again', 'g:app')]],
      })
      return
    }
    const token = this.o.config().telegram.token ?? ''
    const offer = app.offer(hello => {
      const check = checkInitData(hello.telegram, { token, ownerId: this.owner, now: this.o.now() })
      if (!check.ok) this.o.log(`telegram: refused pairing "${hello.name}" from Telegram: ${check.reason}`)
      return check.ok
    })
    if (typeof offer === 'string') {
      await this.sendText(chat, `Couldn't start pairing: ${offer}`)
      return
    }
    const q = offer.link.indexOf('?')
    const url = `${app.url()}/pair?${offer.link.slice(q + 1)}${this.username ? `&bot=${encodeURIComponent(this.username)}` : ''}`
    await this.send(chat, ui.appSetupView({ url, machineName: machine?.name ?? 'this Mac', minutes: Math.max(1, Math.round((offer.expires - this.o.now()) / 60_000)) }))
  }

  /** A device was paired with this machine: you hear about every one. */
  async devicePaired(device: { name: string; platform: string }, role: string): Promise<void> {
    const chat = this.owner
    if (chat === null || !this.running) return
    const where = device.platform.startsWith('telegram') ? ' from Telegram' : ''
    await this.send(chat, { html: `📱 <b>${ui.esc(device.name)}</b> paired with this machine${where}, as ${ui.esc(role)}. Not you? Remove it in the app, or with <code>cq devices remove</code> on the Mac.` }).catch(err =>
      this.o.log(`telegram: couldn't say a device paired: ${errorText(err)}`),
    )
    await this.syncApp().catch(err => this.o.log(`telegram: ${errorText(err)}`))
  }

  // --- messages ---------------------------------------------------------------------

  private async onMessage(m: TgMessage): Promise<void> {
    if (m.chat.type !== 'private' || !m.from) return
    const text = (m.text ?? '').trim()
    if (this.owner === null) return this.tryPair(m, text)
    if (m.from.id !== this.owner || !text) return // only you; strangers get no reply
    const chat = m.chat.id

    if (text === ui.KEYS.newTask) {
      await this.leaveChat(chat, true)
      return this.newTask(chat)
    }
    if (text === ui.KEYS.queue) return this.showQueue(chat)
    if (text === ui.KEYS.status) return this.showStatus(chat)
    if (text === ui.KEYS.peek) return this.showPeek(chat)
    if (text === ui.KEYS.chats) return this.showChats(chat, 0)
    if (text === ui.KEYS.leave) return this.leaveChat(chat)
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

  private async tryPair(m: TgMessage, text: string): Promise<void> {
    const from = m.from!
    const tries = this.pairAttempts.get(from.id) ?? 0
    if (tries >= MAX_PAIR_ATTEMPTS) return
    const typed = (/^\/start\s+(\d{6})$/.exec(text) ?? /^(\d{6})$/.exec(text))?.[1]
    if (!typed) {
      if (text.startsWith('/start')) await this.sendText(m.chat.id, 'Send /start followed by the pairing code that `cq telegram` printed on your Mac.')
      return
    }
    if (typed !== this.pairCode()) {
      this.pairAttempts.set(from.id, tries + 1)
      await this.sendText(m.chat.id, "That code doesn't match. Use the one `cq telegram` printed on your Mac.")
      return
    }
    const config = this.o.config()
    config.telegram.ownerId = from.id
    config.telegram.ownerName = from.username ? `@${from.username}` : from.first_name
    this.o.saveConfig(config)
    this.o.store.kvSet('telegram.pairCode', '')
    this.o.log(`telegram: paired with ${config.telegram.ownerName} (${from.id})`)
    await this.send(m.chat.id, { html: `✅ <b>Paired.</b> Only you can use this bot now.\n\n${ui.HELP_HTML}` }, this.mainKeyboard())
  }

  private async onCommand(chat: number, text: string): Promise<void> {
    const name = text.slice(1).split(/[\s@]/)[0]!.toLowerCase()
    switch (name) {
      case 'start':
        if (/^\/start\s+app$/.test(text)) return this.showApp(chat)
        await this.send(chat, { html: this.links() ? ui.HELP_SHORT_HTML : ui.HELP_HTML }, this.mainKeyboard())
        return
      case 'help':
        await this.send(chat, { html: this.links() ? ui.HELP_SHORT_HTML : ui.HELP_HTML }, this.mainKeyboard())
        return
      case 'app':
        return this.showApp(chat)
      case 'new':
        await this.leaveChat(chat, true)
        return this.newTask(chat)
      case 'chats':
        return this.showChats(chat, 0)
      case 'leave':
        return this.leaveChat(chat)
      case 'queue':
        return this.showQueue(chat)
      case 'status':
        return this.showStatus(chat)
      case 'peek':
        return this.showPeek(chat)
      case 'mac':
        return this.showMac(chat)
      case 'sleep': {
        const mac = this.o.mac
        if (!mac) return void (await this.sendText(chat, 'Only a Mac can do that.'))
        await this.send(chat, ui.sleepView(await mac.status()))
        return
      }
      case 'kill': {
        // /kill ends the running task; /kill 14 ends #14 (a queued one comes off the queue).
        const arg = /^\/kill(?:@\S+)?\s+#?(\d+)\s*$/.exec(text)?.[1]
        const id = arg ? Number(arg) : this.o.store.active()?.id
        await this.sendText(chat, id === undefined ? 'Nothing is running.' : await this.o.runner.kill(id, { by: 'Telegram' }))
        return
      }
      case 'pause':
        this.o.runner.setPaused(true)
        await this.sendText(chat, '⏸ Paused. The current job keeps going; nothing new starts until /resume.')
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
        if (d.messageId) await this.edit(chat, d.messageId, { html: d.folder ? `📁 <b>${ui.esc(this.uiContext().label(d.folder))}</b>` : '📝' })
        await this.showDraft(chat, this.state.updateDraft(d.id, { prompt: text }))
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
        await this.showDraft(chat, this.state.updateDraft(d.id, { notBefore: at }))
        return
      }
      case 'search': {
        const d = this.state.getDraft(p.draftId)
        if (!d || d.status !== 'open') return this.newDraft(chat, text)
        const hits = await this.o.folders.search(text, this.recent(), 8)
        if (d.messageId) await this.edit(chat, d.messageId, { html: '🔍 Search results below.' })
        await this.showDraft(chat, d, ui.searchView(d, text, hits, this.uiContext()))
        this.setPending({ kind: 'search', draftId: d.id }) // typing again refines the search
        return
      }
      case 'answer': {
        const state = this.questions.get(p.code)
        const approval = this.o.store.getApproval(p.code)
        const job = approval ? this.o.store.getJob(approval.jobId) : null
        // One question of a set: that question gets your text, then the next one shows.
        if (p.step !== undefined && state && job && approval?.status === 'pending' && state.step === p.step) {
          await this.sendText(chat, await this.answerStep(chat, p.code, job, questionsOf(approval), state, { text }))
          return
        }
        const reply = this.o.runner.answer(p.code, 'answer', text)
        await this.settleRequest(chat, p.code, `✍️ Answered: “${ui.clip(text, 200)}”`)
        await this.sendText(chat, reply)
        return
      }
      case 'changes': {
        const reply = this.o.runner.answer(p.code, 'deny', text)
        await this.settleRequest(chat, p.code, '✏️ You asked for changes.')
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
        await this.sendText(chat, await this.o.runner.say(text))
        return
    }
  }

  private async showDraft(chat: number, draft: Draft, view?: ui.View): Promise<void> {
    const msg = await this.send(chat, view ?? ui.draftCard(draft, this.uiContext()))
    this.state.updateDraft(draft.id, { messageId: msg.message_id })
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

  /** ➕ New task: pick the folder first, then send the prompt. */
  private async newTask(chat: number): Promise<void> {
    const draft = this.state.addDraft({ ...this.choices(), prompt: '' }, this.o.now())
    const start = draft.folder && this.within(draft.folder) ? draft.folder : this.roots()[0]!
    const msg = await this.send(chat, this.folderPage(draft, start, 0))
    this.state.updateDraft(draft.id, { messageId: msg.message_id, browse: start })
  }

  private folderPage(d: Draft, dir: string, page: number): ui.View {
    return ui.folderView(d, { dir, parent: parentWithin(dir, this.roots()), children: listChildren(dir), page }, this.uiContext())
  }

  private async showQueue(chat: number, messageId?: number): Promise<void> {
    const view = this.withOpen(ui.queueView(this.o.store.active(), this.o.store.queued(), this.uiContext(), this.o.runner.paused))
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.queueMessages.add(messageId)
  }

  private statusInfo(): ui.StatusInfo {
    const active = this.o.store.active()
    const info = active ? this.o.runner.runtimeInfo(active.id) : null
    return {
      active,
      lastTool: info?.lastTool ? { tool: info.lastTool, at: info.lastActivity } : null,
      approvals: this.o.store.pendingApprovals(),
      queued: this.o.store.queued(),
      paused: this.o.runner.paused,
      limits: this.o.runner.limits(),
    }
  }

  /** 📊 Status; `messageId` refreshes one already shown. */
  /** Whether this is the second tap on `what` within KILL_CONFIRM_MS (the first one only arms it). */
  private tappedTwice(what: string): boolean {
    const at = this.armed.get(what)
    const now = this.o.now()
    if (at !== undefined && now - at <= KILL_CONFIRM_MS) {
      this.armed.delete(what)
      return true
    }
    this.armed.set(what, now)
    return false
  }

  /** 🖥 /mac: what's open and what keeps the Mac awake, with buttons to quit an app or sleep. */
  private async showMac(chat: number, messageId?: number): Promise<void> {
    const mac = this.o.mac
    if (!mac) return void (await this.sendText(chat, 'Only a Mac can do that.'))
    const view = ui.macView(await mac.status())
    if (messageId) await this.edit(chat, messageId, view)
    else await this.send(chat, view)
  }

  /**
   * m:q:<pid> quit an app · m:f:<pid> force quit it · m:s sleep · m:S sleep (already confirmed) ·
   * m:d sleep when done on/off · m:D sleep when done · m:r refresh. Quitting and sleeping take a
   * second tap, as Kill does.
   */
  private async onMacButton(chat: number, message: TgMessage | undefined, op: string, pid: number): Promise<string | undefined> {
    const mac = this.o.mac
    if (!mac) return 'Only a Mac can do that.'
    const at = message?.message_id
    const refresh = async () => {
      if (at) await this.showMac(chat, at).catch(() => {})
    }
    const armed = (what: string) => {
      const again = this.macArmed?.what === what && this.o.now() - this.macArmed.at <= KILL_CONFIRM_MS
      this.macArmed = again ? null : { what, at: this.o.now() }
      return again
    }
    switch (op) {
      case 'r':
        await refresh()
        return 'Up to date.'
      case 'q':
      case 'f': {
        const app = (await mac.apps()).find(a => a.pid === pid)
        if (!app) {
          await refresh()
          return "That app isn't open any more."
        }
        if (!armed(`${op}:${pid}`)) return `Tap again to ${op === 'f' ? 'force quit' : 'quit'} ${app.name}.`
        const r = await mac.quit(pid, { force: op === 'f' })
        if (r.open) {
          await this.send(chat, { html: `⚠️ ${ui.esc(r.text)}`, keyboard: [[ui.btn(`⚠️ Force quit ${ui.clip(app.name, 30)}`, `m:f:${pid}`)]] })
        }
        await refresh()
        return r.text
      }
      case 's':
      case 'S': {
        if (op === 's' && !armed('sleep')) return 'Tap 😴 Sleep now again to put the Mac to sleep.'
        const s = await mac.status()
        const r = await mac.sleepNow({ quit: s.quitFirst, by: 'Telegram' })
        if (!r.ok) await this.sendText(chat, `😴 ${r.text}`)
        return r.ok ? 'Going to sleep.' : "It didn't sleep."
      }
      case 'd':
      case 'D': {
        const on = op === 'D' || !(await mac.status()).sleepWhenDone.on
        const r = await mac.sleepWhenDone({ on, by: 'Telegram' })
        await this.sendText(chat, `${on ? '🌙' : '☀️'} ${r.text}`)
        await refresh()
        return on ? 'Sleeps when the queue is done.' : 'Stays awake.'
      }
    }
    return undefined
  }

  private async showStatus(chat: number, messageId?: number): Promise<void> {
    const view = this.withOpen(ui.statusView(this.statusInfo(), this.noticeContext()))
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.statusMessages.add(messageId)
    if (this.statusMessages.size > 50) this.statusMessages.delete(this.statusMessages.values().next().value!)
  }

  private async showPeek(chat: number, messageId?: number): Promise<void> {
    const s = await this.o.runner.screen(30)
    const links = this.links()
    const view = links ? ui.shortPeekView(s?.jobId ?? null, s?.text ?? '', links) : ui.peekView(s?.jobId ?? null, s?.text ?? '')
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.peekMessages.add(messageId)
    if (this.peekMessages.size > 50) this.peekMessages.delete(this.peekMessages.values().next().value!)
  }

  /** A view with Open ↗ (the machine in the app) as its first row, while messages are short. */
  private withOpen(view: ui.View): ui.View {
    const l = this.links()
    if (!l) return view
    return { ...view, keyboard: [[ui.openBtn(l, ui.appPath.machine(l), `Open ${BRAND.name} ↗`)], ...(view.keyboard ?? [])] }
  }

  /** How long a request still waits for you, in minutes. */
  private minutesLeft(a: Approval): number {
    const t = this.o.config().timeouts
    const seconds = a.kind === 'question' ? t.questionSec : a.kind === 'review' ? t.reviewSec : t.approvalSec
    return Math.max(1, Math.round((a.createdAt + seconds * 1000 - this.o.now()) / 60_000))
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
      messages: this.appHome() && this.o.app?.paired() ? (this.appOn() ? 'short' : 'full') : null,
      now: this.o.now(),
    })
  }

  // --- buttons ----------------------------------------------------------------------

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    if (this.owner === null || q.from.id !== this.owner) {
      await this.o.api.answerCallbackQuery(q.id).catch(() => {})
      return
    }
    const chat = q.message?.chat.id ?? this.owner
    const [kind, ...parts] = (q.data ?? '').split(':')
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
          toast = await this.onMacButton(chat, q.message, parts[0]!, Number(parts[1]))
          break
      }
    } catch (err) {
      toast = 'Something went wrong.'
      this.o.log(`telegram: button ${q.data} failed: ${errorText(err)}`)
    }
    await this.o.api.answerCallbackQuery(q.id, toast ? toast.slice(0, 190) : undefined).catch(() => {})
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
    const show = (view: ui.View) => this.edit(chat, at, view)
    const [op, a, b] = args
    // Any other tap ends a search, so your next message isn't taken as more search words.
    if (op !== 's' && this.pending?.kind === 'search' && this.pending.draftId === d.id) this.setPending(null)

    switch (op) {
      case 'k': // back to the card
        await show(ui.draftCard(d, ctx))
        if (!d.prompt && d.folder) this.setPending({ kind: 'prompt', draftId: d.id })
        return
      case 'f': {
        const dir = [d.browse, d.folder].find((p): p is string => !!p && existsSync(p) && this.within(p)) ?? this.roots()[0]!
        d = this.state.updateDraft(d.id, { browse: dir })
        await show(this.folderPage(d, dir, 0))
        return
      }
      case 'b': {
        const dir = this.state.folderPath(Number(a))
        if (!dir || !existsSync(dir)) return 'That folder is gone. Tap 🔄 Rescan.'
        d = this.state.updateDraft(d.id, { browse: dir })
        await show(this.folderPage(d, dir, Number(b) || 0))
        return
      }
      case 'u': {
        const dir = this.state.folderPath(Number(a))
        if (!dir || !existsSync(dir)) return 'That folder is gone. Tap 🔄 Rescan.'
        // A follow-up can only continue its conversation in the folder it ran in.
        const moved = d.sessionId && dir !== d.folder
        d = this.state.updateDraft(d.id, {
          folder: dir,
          browse: dir,
          ...(moved ? { sessionId: null, followJob: null, takeover: false } : {}),
        })
        await show(ui.draftCard(d, ctx))
        this.setPending(d.prompt ? null : { kind: 'prompt', draftId: d.id })
        return `📁 ${ctx.label(dir)}`
      }
      case 'r':
        await show(ui.recentView(d, this.recent(), ctx))
        return
      case 's':
        this.setPending({ kind: 'search', draftId: d.id })
        await show(ui.searchPromptView(d))
        return
      case 'rs': {
        await this.o.folders.rebuild()
        await show(this.folderPage(d, d.browse && existsSync(d.browse) ? d.browse : this.roots()[0]!, 0))
        return `Folder map rebuilt: ${this.o.folders.size} folders.`
      }
      case 'o': {
        if (!a) return void (await show(ui.modeView(d)))
        const mode = ui.MODES[a as ui.ModeKey]
        if (!mode) return
        d = this.state.updateDraft(d.id, { plan: mode.plan, review: mode.review, execMode: mode.execMode })
        await show(ui.draftCard(d, ctx))
        return `Mode: ${mode.label}`
      }
      case 'm': {
        if (!a) return void (await show(ui.modelView(d, ctx)))
        // Picking the planning model again leaves the work model as it was, unless it's now the same.
        d = this.state.updateDraft(d.id, { model: a, ...(d.workModel === a ? { workModel: null } : {}) })
        await show(ui.draftCard(d, ctx))
        return d.plan && d.workModel ? `Plans with ${a}` : `Model: ${a}`
      }
      case 'w': {
        if (!a) return
        d = this.state.updateDraft(d.id, { workModel: a === 'same' || a === d.model ? null : a })
        await show(ui.draftCard(d, ctx))
        return d.workModel ? `Works with ${d.workModel}` : `${d.model} does both`
      }
      case 'e': {
        if (!a) return void (await show(ui.effortView(d)))
        if (!ui.EFFORTS.includes(a as (typeof ui.EFFORTS)[number])) return
        d = this.state.updateDraft(d.id, { effort: a as (typeof ui.EFFORTS)[number] })
        await show(ui.draftCard(d, ctx))
        return `Effort: ${a}`
      }
      case 'c': // the new-chat toggle on cards from before 💬 Chat…
        d = d.sessionId
          ? this.state.updateDraft(d.id, { sessionId: null, followJob: null, takeover: false, newChat: true })
          : this.state.updateDraft(d.id, { newChat: !d.newChat })
        await show(ui.draftCard(d, ctx))
        return
      case 't': {
        if (!d.folder) return 'Pick a folder first.'
        if (!a) {
          const hasLast = this.o.store.getThread(d.folder) !== null
          await show(ui.chatsView(d, ctx.label(d.folder), this.o.chats.list(d.folder, 8), hasLast, this.o.now()))
          return
        }
        let toast: string
        if (a === 'new' || a === 'last') {
          d = this.state.updateDraft(d.id, { sessionId: null, followJob: null, takeover: false, newChat: a === 'new' })
          toast = a === 'new' ? 'New chat.' : 'Continues the last chat.'
        } else {
          const c = this.o.chats.get(a)
          if (!c) return 'That chat is gone.'
          // Open in VS Code or a terminal: taking it over is what continuing it from here means.
          d = this.state.updateDraft(d.id, { sessionId: c.sessionId, followJob: null, newChat: false, takeover: c.where !== null })
          toast = `💬 ${ui.clip(c.title, 60)}`
        }
        await show(ui.draftCard(d, ctx))
        if (!d.prompt) this.setPending({ kind: 'prompt', draftId: d.id })
        return toast
      }
      case 'h':
        d = this.state.updateDraft(d.id, { takeover: !d.takeover })
        await show(ui.draftCard(d, ctx))
        return d.takeover ? 'Takes it over when it starts.' : 'Waits until you close it there.'
      case 'l':
        d = this.state.updateDraft(d.id, { wantLink: !d.wantLink })
        await show(ui.draftCard(d, ctx))
        return d.wantLink ? 'Ends with a live link.' : 'No live link.'
      case 'i':
        d = this.state.updateDraft(d.id, { isolate: !d.isolate })
        await show(ui.draftCard(d, ctx))
        return d.isolate ? 'Runs on its own git branch.' : 'Runs in your checkout.'
      case 'p':
        this.setPending({ kind: 'prompt', draftId: d.id })
        await this.sendText(chat, `✍️ Send the new prompt${d.editJob ? ` for #${d.editJob}` : ''}.`)
        return 'Waiting for the prompt.'
      case 'a': {
        const now = this.o.now()
        const pick = { h: LATER.hour, n: LATER.tonight, m: LATER.morning }[a as 'h' | 'n' | 'm']
        if (pick) d = this.state.updateDraft(d.id, { notBefore: pick(now) })
        else if (a === 'c') d = this.state.updateDraft(d.id, { notBefore: null })
        else if (a === 't') {
          this.setPending({ kind: 'later', draftId: d.id })
          return 'Send the time, e.g. 23:00 or in 2h.'
        } else {
          await show(ui.laterView(d, now))
          return
        }
        await show(ui.draftCard(d, ctx))
        return d.notBefore ? `Starts at ${formatClock(d.notBefore, now)} at the earliest.` : 'Starts as soon as it can.'
      }
      case 'q':
        return d.editJob ? this.saveEdit(chat, at, d) : this.queueDraft(chat, at, d)
      case 'x':
        this.state.updateDraft(d.id, { status: 'discarded' })
        if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
        if (d.editJob) {
          await show({ html: `✏️ <i>#${d.editJob} stays as it was.</i>` })
          return 'Unchanged.'
        }
        await show({ html: `✖️ <s>${ui.esc(ui.clip(d.prompt, 200) || 'new task')}</s>` })
        return 'Discarded.'
    }
  }

  private async queueDraft(chat: number, messageId: number, d: Draft): Promise<string> {
    if (!d.folder) return 'Pick a folder first.'
    if (!d.prompt) return 'Send the prompt first.'
    if (!existsSync(d.folder)) return 'That folder is gone.'
    const spec: JobSpec = {
      projectDir: d.folder,
      prompt: d.prompt,
      plan: d.plan,
      review: d.review,
      execMode: d.execMode,
      model: d.model,
      workModel: d.plan ? d.workModel : null,
      wantLink: d.wantLink,
      effort: d.effort,
      sessionPolicy: d.sessionId ? 'session' : d.newChat ? 'new' : 'continue',
      sessionId: d.sessionId ?? undefined,
      takeover: d.sessionId !== null && d.takeover,
      isolate: d.isolate,
      notBefore: d.notBefore,
      source: 'telegram',
    }
    const job = this.o.runner.enqueue(spec)
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
      isolate: d.isolate,
    }
    this.o.store.kvSet('telegram.last', last)
    this.o.store.kvSet('lastProject', d.folder)
    await this.edit(chat, messageId, ui.queuedView(job, this.whenText(job), this.uiContext()))
    return `Queued #${job.id}.`
  }

  /** 💾 Save on a ✏️ Change card: the queued task takes what the card shows. */
  private async saveEdit(chat: number, messageId: number, d: Draft): Promise<string> {
    const job = d.editJob !== null ? this.o.store.getJob(d.editJob) : null
    if (!job || job.status !== 'queued') return `#${d.editJob} isn't waiting in the queue any more.`
    if (!d.prompt) return 'Send the prompt first.'
    this.o.store.updateJob(job.id, {
      prompt: d.prompt,
      plan: d.plan,
      review: d.review,
      execMode: d.execMode,
      model: d.model,
      workModel: d.plan && d.workModel && d.workModel !== d.model ? d.workModel : null,
      effort: d.effort,
      wantLink: d.wantLink,
      notBefore: d.notBefore,
      ...(job.sessionId ? {} : { isolate: d.isolate }),
    })
    this.state.updateDraft(d.id, { status: 'queued', jobId: job.id })
    if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
    await this.edit(chat, messageId, ui.queuedView(this.o.store.getJob(job.id)!, this.whenText(job), this.uiContext(), { changed: true }))
    return `Changed #${job.id}.`
  }

  private whenText(job: Job): string {
    const now = this.o.now()
    const ahead = this.o.store.queued().findIndex(j => j.id === job.id)
    const active = this.o.store.active()
    if (ahead === 0 && !active) {
      if (this.o.runner.paused) return 'The queue is paused: /resume to start it.'
      const until = this.o.runner.limits().blockedUntil
      if (until && until > now) return `Starts after the usage limit resets at ${formatClock(until, now)}.`
      return 'Starting now.'
    }
    const others = ahead > 0 ? ` and ${ahead} more` : ''
    return active ? `Runs after #${active.id}${others}.` : `${ahead} ahead of it.`
  }

  private async onApprovalButton(chat: number, message: TgMessage | undefined, code: string, op: string): Promise<string> {
    const approval = this.o.store.getApproval(code)
    // From 📊 Status: the status refreshes rather than losing its buttons.
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
      await this.sendText(chat, '✏️ What should Claude change in the plan? Send it as your next message.')
      return 'Waiting for your changes.'
    }
    const reply = this.o.runner.answer(code, op === 'y' ? 'allow' : 'deny', null)
    await this.settleRequest(chat, code, reply, status === null ? message : undefined)
    if (status !== null) await this.showStatus(chat, status)
    return reply
  }

  /** A waiting question or plan, sent again (from 📊 Status); its buttons move to the new message. */
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
    if (before !== undefined) await this.settleMessage(chat, before, '↓ Moved further down.').catch(() => {})
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
        await this.sendText(chat, `✍️ Type your answer to “${ui.clip(q.question, 200)}” as your next message.`)
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
  ): Promise<string> {
    state.answers[state.step] = answer
    state.step++
    if (state.step < questions.length) {
      const next = state.answers[state.step]
      state.ticked = next && 'picks' in next ? [...next.picks] : []
      const approval = this.o.store.getApproval(code)
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

  private async onJobButton(chat: number, message: TgMessage | undefined, id: number, op: string): Promise<string | undefined> {
    const job = this.o.store.getJob(id)
    if (!job) return `No job #${id}.`
    const active = this.o.store.active()?.id === id
    let reply: string
    switch (op) {
      case 'peek':
        await this.showPeek(chat)
        return
      case 'stop':
        return active ? this.o.runner.stop() : `#${id} isn't running.`
      case 'link': {
        const asked = this.o.runner.requestLink(id, 'telegram')
        if (asked.ok && message) await this.settle(chat, message, asked.text)
        return asked.text
      }
      case 'kill': {
        if (job.status !== 'running' && job.status !== 'held' && job.status !== 'queued') return `#${id} has already ended.`
        const armed = this.killArmed.get(id)
        if (!armed || this.o.now() - armed > KILL_CONFIRM_MS) {
          this.killArmed.set(id, this.o.now())
          return `Tap 🛑 Kill again to end #${id} now: Claude and everything it started stop.`
        }
        this.killArmed.delete(id)
        reply = await this.o.runner.kill(id, { by: 'Telegram' })
        await this.settle(chat, message, reply)
        return reply
      }
      case 'go':
        return active ? this.o.runner.go() : `#${id} isn't the current job.`
      case 'now':
        return active ? this.o.runner.continueNow() : `#${id} isn't waiting for a usage limit any more.`
      case 'fork':
        return active ? this.o.runner.fork() : `#${id} isn't waiting any more.`
      case 'take':
        if (!active) return `#${id} isn't waiting any more.`
        reply = await this.o.runner.takeover()
        await this.settle(chat, message, reply)
        return reply
      case 'skip':
        if (active) reply = await this.o.runner.skip()
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
      case 'rm':
        reply = await this.o.runner.remove(id)
        break
      case 'plan':
        if (!job.planText) return 'No plan yet.'
        await this.send(chat, ui.planView(job, this.uiContext()))
        return
      case 'fu':
        if (!job.sessionId) return 'That job has no conversation to continue.'
        this.setPending({ kind: 'followup', jobId: id })
        await this.sendText(chat, `➕ What should Claude do next in #${id}'s conversation? Send it as your next message.`)
        return 'Waiting for the follow-up.'
      case 'edit': {
        // ✏️ Change: a card with the task's choices; 💾 Save puts them on the task.
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
            isolate: job.isolate,
          },
          this.o.now(),
        )
        await this.showDraft(chat, this.state.updateDraft(d.id, { editJob: id, wantLink: job.wantLink, notBefore: job.notBefore }))
        return `Changing #${id}.`
      }
      case 'merge':
      case 'discard': {
        const git = this.o.git
        if (!git) return 'Not here: merge it on the Mac.'
        if (op === 'discard' && !this.tappedTwice(`discard:${id}`)) return `Tap again to throw away #${id}'s branch.`
        const r = await settleBranch(this.o.store, git, id, op)
        await this.sendText(chat, `🌿 ${r.text}`)
        return r.ok ? (op === 'merge' ? 'Merged.' : 'Thrown away.') : "It didn't work."
      }
      default:
        return
    }
    // ⬆️/🗑 from the queue list refresh it; from a "Queued" card, they settle the card.
    if (message && this.queueMessages.has(message.message_id)) await this.showQueue(chat, message.message_id)
    else if (op === 'rm') await this.settle(chat, message, reply)
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
    await this.send(chat, { html: f ? `⬅️ Left “${ui.esc(ui.clip(f.title, 80))}”. New messages make new tasks again.` : "You're not in a chat." }, this.mainKeyboard())
  }

  /** c:… buttons: 💬 Chats pages, a chat's view, ✍️ Write here, 📜 Full reply, ⬅️ Leave. */
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
        await this.send(chat, { html: ui.enteredChatHtml(c, this.noticeContext()) }, ui.CHAT_KEYBOARD)
        return `💬 ${ui.clip(c.title, 60)}`
      case 'r':
        await this.send(
          chat,
          ui.longView(`📜 <b>${ui.esc(ui.clip(c.title, 120))}</b> · Claude's last reply`, c.lastReply ?? '(no reply yet)', undefined, {
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
  private async sendToChat(chat: number, f: Focus, text: string): Promise<void> {
    const c = this.o.chats.get(f.sessionId)
    if (!c?.cwd || !existsSync(c.cwd)) {
      this.setFocus(null)
      await this.send(chat, { html: "That chat is gone, so you've left it. New messages make new tasks again." }, this.mainKeyboard())
      return
    }
    const name = `“${ui.clip(c.title, 60)}”`
    const typed = await this.o.runner.typeIfFree(c.sessionId, text)
    if (typed !== null) {
      await this.sendText(chat, `⌨️ Typed into ${name} (#${typed}). Claude reads it when its current step ends.`)
      return
    }
    const choices = this.choices()
    const job = this.o.runner.enqueue(
      continueSpec({ ...c, cwd: c.cwd }, { model: choices.model, effort: choices.effort, takeover: c.where !== null, source: 'telegram', prompt: text }),
    )
    const take = c.where && !c.running ? ` It's open in ${c.where}: it closes there first.` : ''
    await this.sendText(chat, `➕ Sent to ${name} as #${job.id}. ${this.whenText(job)}${take}`)
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
      const draft = this.state.addDraft(
        { ...choices, folder: c.cwd, prompt: '', sessionId, takeover: c.where !== null, isolate: false },
        this.o.now(),
      )
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
    await this.settle(chat, message, `✅ Queued #${job.id}. ${this.whenText(job)}`)
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
        return 'Updated.'
      case 'q':
        await this.showQueue(chat, at && this.queueMessages.has(at) ? at : undefined)
        return 'Updated.'
      case 'peek':
        await this.showPeek(chat, at && this.peekMessages.has(at) ? at : undefined)
        return 'Updated.'
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
      case 'msgs': {
        const on = !this.appOn()
        this.o.store.kvSet('telegram.messages', on ? 'short' : 'full')
        if (at) await this.edit(chat, at, this.settingsView())
        // The menu button, and a word about the buttons under the text box.
        await this.syncApp().catch(err => this.o.log(`telegram: ${errorText(err)}`))
        return on ? 'The app inside Telegram is on.' : 'Full messages, every button here.'
      }
      case 'app':
        await this.showApp(chat, true)
        return
      case 'clear': {
        if (this.o.now() - this.clearArmed > KILL_CONFIRM_MS) {
          this.clearArmed = this.o.now()
          return 'Tap 🧹 Clear again to take every task off the queue.'
        }
        this.clearArmed = 0
        const removed = this.o.runner.clear()
        await this.showQueue(chat, at && this.queueMessages.has(at) ? at : undefined)
        return removed.length === 0 ? 'The queue is already empty.' : `Took ${removed.length} off the queue.`
      }
      case 'rescan':
        await this.o.folders.rebuild()
        if (at) await this.edit(chat, at, this.settingsView())
        return `Folder map rebuilt: ${this.o.folders.size} folders.`
      case 'type': {
        const job = this.o.store.active()
        if (!job) return 'Nothing is running.'
        this.setPending({ kind: 'say' })
        await this.sendText(chat, `⌨️ Send what to type into #${job.id}. It's typed as you write it, then Enter.`)
        return 'Waiting for what to type.'
      }
      case 'keys': {
        const job = this.o.store.active()
        if (!job) return 'Nothing is running.'
        await this.send(chat, ui.keysView(job.id))
        return
      }
      case 'k':
        return parts[1] ? this.o.runner.keys([parts[1]]) : undefined
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
        config.autoContinueChats = !config.autoContinueChats
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
