import type { Job, LimitState } from '../shared/types'
import { CONTINUE_INBOX } from './chats'
import type { Delivery } from './inbox'
import { pickResetTime } from './limits'
import type { Notice } from './notify'
import { whereLabel, type Conversation, type LiveSession } from './sessions'
import type { Store, Watch } from './store'

/** A limit stop older than this was seen by you already (or the daemon was off); stay quiet. */
const FRESH_MS = 30 * 60_000
const SEEN_KEY = 'watch.seen'
const SEEN_MAX = 100
/** After posting continue, how long the chat has to start before it's taken over instead. */
export const SENT_WAIT_MS = 2 * 60_000
const DAY = 24 * 60 * 60_000

export interface WatcherDeps {
  liveSessions: () => LiveSession[]
  /** The conversation a live session is running, read from its transcript. */
  conversation: (s: LiveSession) => Conversation | null
  /** A conversation by id wherever it ran, for a chat that closed while it waited. */
  findConversation: (sessionId: string) => Conversation | null
  /** The queue already runs or continues this conversation. */
  queued: (sessionId: string) => boolean
  limits: () => LimitState
  store: Pick<Store, 'kvGet' | 'kvSet' | 'putWatch' | 'openWatches' | 'setWatchState' | 'pruneWatches'>
  notify: (notice: Notice) => void
  /** Watch your other chats at all. */
  enabled: () => boolean
  /** Continue them by themselves at the reset. */
  autoContinue: () => boolean
  graceMs: () => number
  deliver: (s: LiveSession, text: string) => Promise<Delivery>
  /** Queues a job that continues the chat here, taking it over first where it's open. */
  enqueue: (chat: Conversation & { cwd: string }, takeover: boolean) => Job
  log: (line: string) => void
  now: () => number
}

const interactive = (s: LiveSession) => (s.kind ?? 'interactive') === 'interactive'

/**
 * Watches your other Claude Code chats (VS Code, a terminal). When one stops on a usage limit it
 * tells you and, at the reset, continues it: inside the open chat through its inbox, so VS Code
 * stays live; if that doesn't take, or the chat was closed, the queue continues it.
 */
export class SessionWatcher {
  private running = false

  constructor(private d: WatcherDeps) {}

  async check(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      if (this.d.enabled()) this.spot()
      if (this.d.autoContinue()) await this.continueDue()
    } finally {
      this.running = false
    }
  }

  /** New usage-limit stops in open chats: tell you, and schedule the continue. */
  private spot(): void {
    const now = this.d.now()
    const seen = this.d.store.kvGet<string[]>(SEEN_KEY) ?? []
    const fresh: string[] = []
    for (const s of this.d.liveSessions()) {
      if (!interactive(s) || this.d.queued(s.sessionId)) continue
      const chat = this.d.conversation(s)
      const limit = chat?.limit
      if (!chat || !limit || now - limit.at > FRESH_MS) continue
      const key = `${s.sessionId}@${limit.at}`
      if (seen.includes(key) || fresh.includes(key)) continue
      fresh.push(key)
      const pick = pickResetTime(this.d.limits(), limit.text, now)
      let autoAt: number | null = null
      if (this.d.autoContinue() && chat.cwd) {
        autoAt = (pick.at ?? limit.at + 15 * 60_000) + this.d.graceMs()
        this.d.store.putWatch({
          sessionId: s.sessionId,
          cwd: chat.cwd,
          title: chat.title,
          where: whereLabel(s),
          stopAt: limit.at,
          dueAt: autoAt,
          state: 'waiting',
          sentAt: null,
          jobId: null,
          updatedAt: now,
        })
        this.d.log(`watch: chat ${s.sessionId} in ${whereLabel(s)} hit a usage limit; continuing it at ${new Date(autoAt).toISOString()}`)
      }
      this.d.notify({ type: 'session_limit', chat, where: whereLabel(s), at: pick.at, window: pick.window, autoAt })
    }
    if (fresh.length > 0) this.d.store.kvSet(SEEN_KEY, [...seen, ...fresh].slice(-SEEN_MAX))
  }

  /** Chats whose reset has come: continue them, and check that continue took. */
  private async continueDue(): Promise<void> {
    const now = this.d.now()
    for (const w of this.d.store.openWatches()) {
      if (w.state === 'waiting' && now < w.dueAt) continue
      if (this.d.queued(w.sessionId)) {
        this.d.store.setWatchState(w.sessionId, 'handed', now)
        continue
      }
      const holder = this.d.liveSessions().find(s => s.sessionId === w.sessionId && interactive(s))
      const chat = holder ? this.d.conversation(holder) : this.d.findConversation(w.sessionId)
      if (!chat?.cwd) {
        this.d.log(`watch: chat ${w.sessionId} is gone; not continuing it`)
        this.d.store.setWatchState(w.sessionId, 'cancelled', now)
        continue
      }
      // Anything after the stop (Claude Code's own continue, you typing, our message) means it runs again.
      const running = !chat.limit || chat.limit.at !== w.stopAt || holder?.status === 'busy'
      if (running) {
        this.d.log(`watch: chat ${w.sessionId} is running again (${w.state === 'sent' ? 'after the continue we sent' : 'by itself'})`)
        this.d.store.setWatchState(w.sessionId, 'done', now)
        continue
      }
      if (w.state === 'waiting') {
        if (!holder) {
          this.handOff(w, { ...chat, cwd: chat.cwd }, false, 'resume')
          continue
        }
        const d = await this.d.deliver(holder, CONTINUE_INBOX)
        if (d.ok) {
          this.d.log(`watch: posted continue into chat ${w.sessionId} in ${w.where}${d.reply ? ` (it answered: ${d.reply})` : ''}`)
          this.d.store.setWatchState(w.sessionId, 'sent', now, { sentAt: now })
          this.d.notify({ type: 'chat_continue', chat, where: w.where, how: 'inbox' })
        } else {
          this.d.log(`watch: couldn't post into chat ${w.sessionId} (${d.error}); taking it over`)
          this.handOff(w, { ...chat, cwd: chat.cwd }, true, 'takeover')
        }
        continue
      }
      if (now - (w.sentAt ?? now) > SENT_WAIT_MS) {
        this.d.log(`watch: chat ${w.sessionId} didn't start after continue was posted; ${holder ? 'taking it over' : 'resuming it here'}`)
        this.handOff(w, { ...chat, cwd: chat.cwd }, !!holder, holder ? 'takeover' : 'resume')
      }
    }
    this.d.store.pruneWatches(now - DAY)
  }

  private handOff(w: Watch, chat: Conversation & { cwd: string }, takeover: boolean, how: 'takeover' | 'resume'): void {
    const job = this.d.enqueue(chat, takeover)
    this.d.store.setWatchState(w.sessionId, 'handed', this.d.now(), { jobId: job.id })
    this.d.notify({ type: 'chat_continue', chat, where: w.where, how, jobId: job.id })
  }
}
