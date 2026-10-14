// iMessage in and out for cq: you text yourself, cq reads chat.db and answers via Messages.app.
// Self-chat echo handling and the osascript send follow the iMessage channel plugin in
// anthropics/claude-plugins-official (Apache-2.0); see NOTICE.
import { BRAND } from '../shared/brand'
import { appleDateMs, ChatDb, DIRECT_CHAT, messageText, type MessageRow } from './chatdb'

/** Marks cq's own messages so they're never read back as commands. */
export const BOT_PREFIX = '🤖'

const ECHO_WINDOW_MS = 30_000
/** Messages older than this when first seen were sent while cq was down; don't act on them. */
const STALE_MS = 10 * 60_000
const CHUNK = 1800

// Text and chat id travel as argv, so nothing typed in a message is ever spliced into the script.
const SEND_SCRIPT = ['on run argv', 'tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)', 'end run']

export interface BridgeOptions {
  chatDbPath?: string
  allowSms: boolean
  getWatermark: () => number | undefined
  setWatermark: (rowid: number) => void
  getReplyChat: () => string | undefined
  setReplyChat: (chatGuid: string) => void
  onCommand: (text: string) => Promise<string | null>
  now: () => number
  log: (line: string) => void
}

export interface BridgeStatus {
  ok: boolean
  error: string | null
  selfAddresses: number
  selfChats: number
}

/** chat.db and osascript can normalize whitespace and quotes differently; compare loosely. */
function echoKey(text: string): string {
  return text
    .replace(/[‍︀-️]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

export function chunkText(text: string, limit = CHUNK): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export class IMessageBridge {
  private db: ChatDb | null = null
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private echoes = new Map<string, number>()
  private polling = false
  private watermark = 0

  constructor(private o: BridgeOptions) {}

  start(): boolean {
    try {
      this.db = new ChatDb(this.o.chatDbPath)
    } catch (err) {
      this.error =
        `can't read chat.db (${err instanceof Error ? err.message : err}). ` +
        `Give ${BRAND.name} Full Disk Access: System Settings → Privacy & Security → Full Disk Access.`
      this.o.log(`imessage: ${this.error}`)
      return false
    }
    const stored = this.o.getWatermark()
    this.watermark = stored ?? this.db.maxRowId()
    if (stored === undefined) this.o.setWatermark(this.watermark)
    this.o.log(`imessage: watching chat.db from row ${this.watermark}; ${this.db.self.size} self addresses`)
    this.timer = setInterval(() => void this.poll(), 1000)
    return true
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.db?.close()
    this.db = null
  }

  status(): BridgeStatus {
    return {
      ok: this.db !== null,
      error: this.error,
      selfAddresses: this.db?.self.size ?? 0,
      selfChats: this.db?.selfChats().length ?? 0,
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.db) return
    this.polling = true
    try {
      for (const row of this.db.since(this.watermark)) {
        this.watermark = row.rowid
        this.o.setWatermark(row.rowid)
        await this.handle(row)
      }
    } catch (err) {
      this.o.log(`imessage: poll failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.polling = false
    }
  }

  private async handle(r: MessageRow): Promise<void> {
    if (!this.db || !r.chat_guid || r.chat_style !== DIRECT_CHAT) return
    // SMS sender ids can be spoofed; iMessage is tied to an Apple ID.
    if (!this.o.allowSms && r.service !== 'iMessage') return
    // In a chat with yourself, what you type arrives as is_from_me = 0 from your own address;
    // the is_from_me = 1 rows are empty sent-receipts.
    if (r.is_from_me || !r.handle_id || !this.db.self.has(r.handle_id.toLowerCase())) return
    const text = messageText(r).trim()
    if (!text || text.startsWith(BOT_PREFIX) || this.consumeEcho(r.chat_guid, text)) return
    if (this.o.now() - appleDateMs(r.date) > STALE_MS) return

    const reply = await this.o.onCommand(text)
    if (reply === null) return
    this.o.setReplyChat(r.chat_guid)
    await this.send(reply, r.chat_guid).catch(err => this.o.log(`imessage: reply failed: ${err}`))
  }

  /** Sends to the self-chat you last texted from (or your most recent one). */
  async notify(text: string): Promise<void> {
    if (!this.db) return
    const chat = this.o.getReplyChat() ?? this.db.selfChats()[0]
    if (!chat) {
      this.o.log('imessage: no chat with yourself yet; text yourself once so cq knows where to reply')
      return
    }
    await this.send(text, chat)
  }

  async send(text: string, chatGuid: string): Promise<void> {
    for (const part of chunkText(`${BOT_PREFIX} ${text}`)) {
      this.trackEcho(chatGuid, part)
      const proc = Bun.spawn(['osascript', ...SEND_SCRIPT.flatMap(line => ['-e', line]), part, chatGuid], {
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      if (code !== 0) throw new Error(err.trim() || `osascript exited ${code}`)
    }
  }

  private trackEcho(chatGuid: string, text: string): void {
    const now = this.o.now()
    for (const [key, at] of this.echoes) if (now - at > ECHO_WINDOW_MS) this.echoes.delete(key)
    this.echoes.set(`${chatGuid}\x00${echoKey(text)}`, now)
  }

  private consumeEcho(chatGuid: string, text: string): boolean {
    const key = `${chatGuid}\x00${echoKey(text)}`
    const at = this.echoes.get(key)
    if (at === undefined || this.o.now() - at > ECHO_WINDOW_MS) return false
    this.echoes.delete(key)
    return true
  }
}
