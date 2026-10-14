import type { LimitState } from '../shared/types'
import { pickResetTime } from './limits'
import type { Notice } from './notify'
import { whereLabel, type Conversation, type LiveSession } from './sessions'

/** A limit stop older than this was seen by you already (or the daemon was off); stay quiet. */
const FRESH_MS = 30 * 60_000
const SEEN_KEY = 'watch.seen'
const SEEN_MAX = 100

export interface WatcherDeps {
  liveSessions: () => LiveSession[]
  /** The conversation a live session is running, read from its transcript. */
  conversation: (s: LiveSession) => Conversation | null
  /** The queue already runs or continues this conversation. */
  queued: (sessionId: string) => boolean
  limits: () => LimitState
  kvGet: <T>(key: string) => T | undefined
  kvSet: (key: string, value: unknown) => void
  notify: (notice: Notice) => void
  enabled: () => boolean
  now: () => number
}

/**
 * Watches your other Claude Code chats (VS Code, a terminal) and tells you when one stops on a
 * usage limit, so you can have the queue continue it after the reset.
 */
export class SessionWatcher {
  constructor(private d: WatcherDeps) {}

  check(): void {
    if (!this.d.enabled()) return
    const now = this.d.now()
    const seen = this.d.kvGet<string[]>(SEEN_KEY) ?? []
    const fresh: string[] = []
    for (const s of this.d.liveSessions()) {
      if ((s.kind ?? 'interactive') !== 'interactive' || this.d.queued(s.sessionId)) continue
      const chat = this.d.conversation(s)
      const limit = chat?.limit
      if (!chat || !limit || now - limit.at > FRESH_MS) continue
      const key = `${s.sessionId}@${limit.at}`
      if (seen.includes(key) || fresh.includes(key)) continue
      fresh.push(key)
      const pick = pickResetTime(this.d.limits(), limit.text, now)
      this.d.notify({ type: 'session_limit', chat, where: whereLabel(s), at: pick.at, window: pick.window })
    }
    if (fresh.length > 0) this.d.kvSet(SEEN_KEY, [...seen, ...fresh].slice(-SEEN_MAX))
  }
}
