import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { codeRoots, type Config } from '../shared/config'
import type { Job, JobSpec } from '../shared/types'
import { CONTINUE_PROMPT, modeFor, modelAlias, type ChatSource } from '../daemon/chats'
import { parseQueueText, runCommand, type CommandContext } from '../daemon/commands'
import { listChildren, parentWithin, relativeToRoots, type FolderMap } from '../daemon/folders'
import { formatClock } from '../daemon/limits'
import type { Notice, Question } from '../daemon/notify'
import type { Runner } from '../daemon/runner'
import type { Store } from '../daemon/store'
import type { BotApi, Markup, TgCallbackQuery, TgMessage, TgUpdate } from './api'
import { TelegramState, type Choices, type Draft } from './state'
import * as ui from './ui'

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
  now: () => number
  log: (line: string) => void
}

/** Something the bot asked you to type next. */
type Pending =
  | { kind: 'prompt'; draftId: number }
  | { kind: 'search'; draftId: number }
  | { kind: 'answer'; code: string }
  | { kind: 'changes'; code: string }
  | { kind: 'followup'; jobId: number }

export interface TelegramStatus {
  ok: boolean
  bot: string | null
  paired: boolean
  owner: string | null
  pairCode: string | null
  error: string | null
}

const COMMANDS = [
  { command: 'new', description: 'Pick a folder, then send the prompt' },
  { command: 'queue', description: 'Waiting and running jobs' },
  { command: 'status', description: 'Current job and usage limits' },
  { command: 'peek', description: "The running job's screen" },
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
}

const PENDING_TTL = 30 * 60_000
const MAX_PAIR_ATTEMPTS = 5

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  /** Option picks for questions with several parts. */
  private picks = new Map<string, Map<number, number>>()
  private pairAttempts = new Map<number, number>()

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
      this.error = null
    } catch (err) {
      this.error = errorText(err)
      this.o.log(`telegram: can't reach the bot (${this.error})`)
    }
    if (this.owner === null) this.pairCode()
    this.o.api.setMyCommands(COMMANDS).catch(err => this.o.log(`telegram: setMyCommands failed: ${errorText(err)}`))
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

  private async send(chat: number, view: ui.View, markup?: Markup): Promise<TgMessage> {
    const msg = await this.o.api.sendMessage(chat, view.html, view.keyboard ? { inline_keyboard: view.keyboard } : markup)
    if (view.keyboard) this.remember(msg.message_id, view.html)
    return msg
  }

  private async edit(chat: number, messageId: number, view: ui.View): Promise<void> {
    await this.o.api.editMessageText(chat, messageId, view.html, view.keyboard)
    this.remember(messageId, view.html)
  }

  private sendText(chat: number, text: string): Promise<TgMessage> {
    return this.send(chat, { html: ui.esc(text) })
  }

  /** Adds a closing line to a message and removes its buttons. */
  private async settle(chat: number, message: TgMessage | undefined, line: string): Promise<void> {
    if (!message) return
    const html = this.sent.get(message.message_id) ?? ui.esc(message.text ?? '')
    this.sent.delete(message.message_id)
    await this.o.api.editMessageText(chat, message.message_id, `${html}\n\n<b>${ui.esc(line)}</b>`)
  }

  /** Called by the notifier for every notice. */
  async notify(notice: Notice): Promise<void> {
    const chat = this.owner
    if (chat === null || !this.running) return
    await this.send(chat, ui.noticeView(notice, { ...this.uiContext(), now: this.o.now() }))
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

  // --- messages ---------------------------------------------------------------------

  private async onMessage(m: TgMessage): Promise<void> {
    if (m.chat.type !== 'private' || !m.from) return
    const text = (m.text ?? '').trim()
    if (this.owner === null) return this.tryPair(m, text)
    if (m.from.id !== this.owner || !text) return // only you; strangers get no reply
    const chat = m.chat.id

    if (text === ui.KEYS.newTask) return this.newTask(chat)
    if (text === ui.KEYS.queue) return this.showQueue(chat)
    if (text === ui.KEYS.status) return this.showStatus(chat)
    if (text === ui.KEYS.peek) return this.showPeek(chat)
    if (text.startsWith('/')) return this.onCommand(chat, text)

    const pending = this.takePending()
    if (pending) return this.onPendingText(chat, pending, text)

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
    await this.send(m.chat.id, { html: `✅ <b>Paired.</b> Only you can use this bot now.\n\n${ui.HELP_HTML}` }, ui.MAIN_KEYBOARD)
  }

  private async onCommand(chat: number, text: string): Promise<void> {
    const name = text.slice(1).split(/[\s@]/)[0]!.toLowerCase()
    switch (name) {
      case 'start':
      case 'help':
        await this.send(chat, { html: ui.HELP_HTML }, ui.MAIN_KEYBOARD)
        return
      case 'new':
        return this.newTask(chat)
      case 'queue':
        return this.showQueue(chat)
      case 'status':
        return this.showStatus(chat)
      case 'peek':
        return this.showPeek(chat)
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
      case 'search': {
        const d = this.state.getDraft(p.draftId)
        if (!d || d.status !== 'open') return this.newDraft(chat, text)
        const hits = await this.o.folders.search(text, this.recent(), 8)
        if (d.messageId) await this.edit(chat, d.messageId, { html: '🔍 Search results below.' })
        await this.showDraft(chat, d, ui.searchView(d, text, hits, this.uiContext()))
        this.setPending({ kind: 'search', draftId: d.id }) // typing again refines the search
        return
      }
      case 'answer':
        await this.sendText(chat, this.o.runner.answer(p.code, 'answer', text))
        return
      case 'changes':
        await this.sendText(chat, this.o.runner.answer(p.code, 'deny', text))
        return
      case 'followup': {
        const job = this.o.store.getJob(p.jobId)
        if (!job?.sessionId) return this.newDraft(chat, text)
        const draft = this.state.addDraft(
          { ...this.choices(), folder: job.projectDir, prompt: text, sessionId: job.sessionId, followJob: job.id },
          this.o.now(),
        )
        return this.showDraft(chat, draft)
      }
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
    const view = ui.queueView(this.o.store.active(), this.o.store.queued(), this.uiContext(), this.o.runner.paused)
    if (messageId) await this.edit(chat, messageId, view)
    else messageId = (await this.send(chat, view)).message_id
    this.queueMessages.add(messageId)
  }

  private async statusView(): Promise<ui.View> {
    const text = (await runCommand('st', this.o.commandContext())) ?? ''
    return ui.statusView(text, this.o.runner.paused)
  }

  private async showStatus(chat: number, messageId?: number): Promise<void> {
    const view = await this.statusView()
    if (messageId) await this.edit(chat, messageId, view)
    else await this.send(chat, view)
  }

  private async showPeek(chat: number, messageId?: number): Promise<void> {
    const s = await this.o.runner.screen(30)
    const view = ui.peekView(s?.jobId ?? null, s?.text ?? '')
    if (messageId) await this.edit(chat, messageId, view)
    else await this.send(chat, view)
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
        d = this.state.updateDraft(d.id, { model: a })
        await show(ui.draftCard(d, ctx))
        return `Model: ${a}`
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
      case 'i':
        d = this.state.updateDraft(d.id, { isolate: !d.isolate })
        await show(ui.draftCard(d, ctx))
        return d.isolate ? 'Runs on its own git branch.' : 'Runs in your checkout.'
      case 'q':
        return this.queueDraft(chat, at, d)
      case 'x':
        this.state.updateDraft(d.id, { status: 'discarded' })
        if (this.pending && 'draftId' in this.pending && this.pending.draftId === d.id) this.setPending(null)
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
      effort: d.effort,
      sessionPolicy: d.sessionId ? 'session' : d.newChat ? 'new' : 'continue',
      sessionId: d.sessionId ?? undefined,
      takeover: d.sessionId !== null && d.takeover,
      isolate: d.isolate,
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
      effort: d.effort,
      isolate: d.isolate,
    }
    this.o.store.kvSet('telegram.last', last)
    this.o.store.kvSet('lastProject', d.folder)
    await this.edit(chat, messageId, ui.queuedView(job, this.whenText(job), this.uiContext()))
    return `Queued #${job.id}.`
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
    if (!approval || approval.status !== 'pending') {
      const line = approval ? `Already ${approval.status}.` : 'Already handled.'
      await this.settle(chat, message, line)
      return line
    }
    if (op === 'c') {
      this.setPending({ kind: 'changes', code })
      await this.sendText(chat, '✏️ What should Claude change in the plan? Send it as your next message.')
      return 'Waiting for your changes.'
    }
    const reply = this.o.runner.answer(code, op === 'y' ? 'allow' : 'deny', null)
    await this.settle(chat, message, reply)
    return reply
  }

  private async onQuestionButton(chat: number, message: TgMessage | undefined, code: string, arg: string): Promise<string> {
    const approval = this.o.store.getApproval(code)
    if (!approval || approval.status !== 'pending') {
      const line = approval ? `Already ${approval.status}.` : 'Already handled.'
      await this.settle(chat, message, line)
      return line
    }
    if (arg === 't') {
      this.setPending({ kind: 'answer', code })
      await this.sendText(chat, '✍️ Type your answer as your next message.')
      return 'Waiting for your answer.'
    }
    const questions = ((approval.payload as { questions?: Question[] } | null)?.questions ?? []) as Question[]
    const [qi, oi] = arg.split('.').map(Number) as [number, number]
    const picks = this.picks.get(code) ?? new Map<number, number>()
    picks.set(qi, oi)
    this.picks.set(code, picks)
    if (picks.size < questions.length && message) {
      const html = this.sent.get(message.message_id) ?? ui.esc(message.text ?? '')
      await this.edit(chat, message.message_id, { html, keyboard: ui.questionKeyboard(code, questions, picks) })
      return 'Got it. Now answer the other question.'
    }
    this.picks.delete(code)
    const letter = (n: number) => String.fromCharCode(97 + n)
    const answer =
      questions.length <= 1
        ? letter(oi)
        : [...picks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([q, o]) => `${q + 1}${letter(o)}`)
            .join(' ')
    const chosen = [...picks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([q, o]) => questions[q]?.options?.[o]?.label ?? '?')
      .join(', ')
    const reply = this.o.runner.answer(code, 'answer', answer)
    await this.settle(chat, message, `Answered: ${chosen}`)
    return reply
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
      case 'go':
        return active ? this.o.runner.go() : `#${id} isn't the current job.`
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
      case 'rm':
        reply = await this.o.runner.remove(id)
        break
      case 'fu':
        if (!job.sessionId) return 'That job has no conversation to continue.'
        this.setPending({ kind: 'followup', jobId: id })
        await this.sendText(chat, `➕ What should Claude do next in #${id}'s conversation? Send it as your next message.`)
        return 'Waiting for the follow-up.'
      default:
        return
    }
    // ⬆️/🗑 from the queue list refresh it; from a "Queued" card, they settle the card.
    if (message && this.queueMessages.has(message.message_id)) await this.showQueue(chat, message.message_id)
    else if (op === 'rm') await this.settle(chat, message, reply)
    return reply
  }

  /** Buttons on "your chat in VS Code hit a usage limit". */
  private async onChatButton(chat: number, message: TgMessage | undefined, sessionId: string, op: string): Promise<string | undefined> {
    if (op === 'x') {
      await this.settle(chat, message, 'Ignored.')
      return 'Ignored.'
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
    const job = this.o.runner.enqueue({
      projectDir: c.cwd,
      prompt: CONTINUE_PROMPT,
      ...modeFor(c.permissionMode),
      model: modelAlias(c.model) ?? choices.model,
      effort: choices.effort,
      sessionPolicy: 'session',
      sessionId,
      isolate: false,
      takeover: true,
      front: true,
      source: 'telegram',
    })
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
        await this.showQueue(chat, at)
        return 'Updated.'
      case 'peek':
        await this.showPeek(chat, at)
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
      case 'rescan':
        await this.o.folders.rebuild()
        if (at) await this.edit(chat, at, this.settingsView())
        return `Folder map rebuilt: ${this.o.folders.size} folders.`
      case 'watch': {
        const config = this.o.config()
        config.watchSessions = !config.watchSessions
        this.o.saveConfig(config)
        if (at) await this.edit(chat, at, this.settingsView())
        return config.watchSessions ? 'Watching your other chats.' : 'Not watching your other chats.'
      }
      default:
        return
    }
  }
}
