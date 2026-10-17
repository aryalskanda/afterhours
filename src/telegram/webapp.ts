// The app inside Telegram (a Mini App) proves who opened it with Telegram's launch data: fields
// signed with a key made from the bot's token (https://core.telegram.org/bots/webapps). Pairing from
// Telegram is approved only when that data is genuine, recent, and from the bot's owner.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Launch data older than this doesn't pair: open the app again from the bot. */
export const INIT_DATA_MAX_AGE_MS = 10 * 60_000

export interface InitDataCheck {
  ok: boolean
  /** Why not, for the log (never the data itself). */
  reason?: string
  userId?: number
}

/** Checks Telegram's launch data (`initData`, as the app received it) for this bot's owner. */
export function checkInitData(initData: string | undefined, o: { token: string; ownerId: number | null; now: number; maxAgeMs?: number }): InitDataCheck {
  if (!initData) return { ok: false, reason: 'no Telegram launch data' }
  if (o.ownerId === null) return { ok: false, reason: 'the bot has no owner yet' }
  const fields = new URLSearchParams(initData)
  const hash = fields.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'unsigned' }
  // Every field but the hash, sorted, one `key=value` a line.
  const check = [...fields.entries()]
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(o.token).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'the signature does not match this bot' }
  const signedAt = Number(fields.get('auth_date')) * 1000
  if (!Number.isFinite(signedAt) || signedAt <= 0) return { ok: false, reason: 'no signing time' }
  const age = o.now - signedAt
  if (age > (o.maxAgeMs ?? INIT_DATA_MAX_AGE_MS)) return { ok: false, reason: `opened ${Math.round(age / 60_000)} minutes ago` }
  if (age < -60_000) return { ok: false, reason: 'signed in the future' }
  let userId: number | undefined
  try {
    userId = (JSON.parse(fields.get('user') ?? '{}') as { id?: unknown }).id as number | undefined
  } catch {
    return { ok: false, reason: 'unreadable user' }
  }
  if (typeof userId !== 'number') return { ok: false, reason: 'no user' }
  if (userId !== o.ownerId) return { ok: false, reason: 'someone other than the bot’s owner', userId }
  return { ok: true, userId }
}

/** Signs launch data the way Telegram does: for tests, and for trying the app locally. */
export function signInitData(fields: Record<string, string>, token: string): string {
  const check = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}
