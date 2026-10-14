// Reading ~/Library/Messages/chat.db. Adapted from the iMessage channel plugin in
// anthropics/claude-plugins-official (Apache-2.0); see NOTICE.
import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CHAT_DB = process.env.CQ_CHAT_DB ?? join(homedir(), 'Library', 'Messages', 'chat.db')

/** Core Data epoch (2001-01-01 UTC); message.date is nanoseconds since then. */
const APPLE_EPOCH_MS = 978307200000

export function appleDateMs(ns: number): number {
  return ns / 1e6 + APPLE_EPOCH_MS
}

/**
 * Newer macOS stores message text in attributedBody (a typedstream NSAttributedString)
 * and leaves `text` null. This pulls out the NSString payload.
 */
export function parseAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob) return null
  const buf = Buffer.from(blob)
  let i = buf.indexOf('NSString')
  if (i < 0) return null
  i += 'NSString'.length
  // Skip class metadata up to the '+' that marks the inline string.
  while (i < buf.length && buf[i] !== 0x2b) i++
  if (i >= buf.length) return null
  i++
  // Length prefix: small lengths are one byte; 0x81/0x82/0x83 escape to 1/2/3-byte little-endian.
  let len: number
  const b = buf[i++]!
  if (b === 0x81) {
    len = buf[i]!
    i += 1
  } else if (b === 0x82) {
    len = buf.readUInt16LE(i)
    i += 2
  } else if (b === 0x83) {
    len = buf.readUIntLE(i, 3)
    i += 3
  } else {
    len = b
  }
  if (i + len > buf.length) return null
  return buf.toString('utf8', i, i + len)
}

export interface MessageRow {
  rowid: number
  guid: string
  text: string | null
  attributedBody: Uint8Array | null
  date: number
  is_from_me: number
  service: string | null
  handle_id: string | null
  chat_guid: string
  chat_style: number | null
}

export function messageText(r: Pick<MessageRow, 'text' | 'attributedBody'>): string {
  return r.text ?? parseAttributedBody(r.attributedBody) ?? ''
}

/** chat.style: 45 = one-to-one, 43 = group. */
export const DIRECT_CHAT = 45

export class ChatDb {
  private db: Database
  /** Your own addresses (phone numbers, Apple ID emails), lowercased. */
  readonly self: Set<string>

  constructor(path = CHAT_DB) {
    this.db = new Database(path, { readonly: true })
    // Throws "authorization denied" without Full Disk Access.
    this.db.query('SELECT ROWID FROM message LIMIT 1').get()
    this.self = this.selfAddresses()
  }

  close(): void {
    this.db.close()
  }

  private selfAddresses(): Set<string> {
    // message.account on rows you sent ("E:you@icloud.com", "p:+1555…"). chat.last_addressed_handle
    // is polluted with other people's numbers on machines with SMS history, so it isn't used.
    const rows = this.db
      .query<{ addr: string }, []>(
        `SELECT DISTINCT account AS addr FROM message WHERE is_from_me = 1 AND account IS NOT NULL AND account != '' LIMIT 50`,
      )
      .all()
    return new Set(rows.map(r => (/^[A-Za-z]:/.test(r.addr) ? r.addr.slice(2) : r.addr).toLowerCase()))
  }

  maxRowId(): number {
    return this.db.query<{ max: number | null }, []>('SELECT MAX(ROWID) AS max FROM message').get()?.max ?? 0
  }

  since(rowid: number): MessageRow[] {
    return this.db
      .query<MessageRow, [number]>(
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.service,
                h.id AS handle_id, c.guid AS chat_guid, c.style AS chat_style
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.ROWID > ?
         ORDER BY m.ROWID ASC`,
      )
      .all(rowid)
  }

  /** One-to-one chats with yourself, most recently active first; SMS-only chats last. */
  selfChats(): string[] {
    const self = [...this.self]
    if (self.length === 0) return []
    const placeholders = self.map(() => '?').join(', ')
    const rows = this.db
      .query<{ guid: string; last: number | null }, string[]>(
        `SELECT c.guid AS guid, MAX(m.date) AS last
         FROM chat c
         JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         JOIN handle h ON h.ROWID = chj.handle_id
         LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         LEFT JOIN message m ON m.ROWID = cmj.message_id
         WHERE c.style = ${DIRECT_CHAT} AND LOWER(h.id) IN (${placeholders})
         GROUP BY c.guid
         ORDER BY last DESC`,
      )
      .all(...self)
    const notSms = rows.filter(r => !r.guid.startsWith('SMS'))
    return [...notSms, ...rows.filter(r => r.guid.startsWith('SMS'))].map(r => r.guid)
  }
}
