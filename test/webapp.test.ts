// Telegram's launch data: only genuine, recent data from the bot's owner pairs the app inside Telegram.

import { describe, expect, test } from 'bun:test'
import { checkInitData, INIT_DATA_MAX_AGE_MS, signInitData } from '../src/telegram/webapp'

const TOKEN = '123456:test-token-for-signing-only'
const OWNER = 7001
const now = Date.UTC(2026, 9, 17, 12, 0)

function launch(o: { user?: number; at?: number; token?: string } = {}): string {
  return signInitData(
    {
      query_id: 'AAE',
      user: JSON.stringify({ id: o.user ?? OWNER, first_name: 'Skanda', username: 'skanda' }),
      auth_date: String(Math.floor((o.at ?? now - 5_000) / 1000)),
      signature: 'ed25519-signature-telegram-adds',
    },
    o.token ?? TOKEN,
  )
}

describe('Telegram launch data', () => {
  test("the owner's, signed with this bot's token and recent: accepted", () => {
    expect(checkInitData(launch(), { token: TOKEN, ownerId: OWNER, now })).toEqual({ ok: true, userId: OWNER })
  })

  test('tampered with, or signed for another bot: refused', () => {
    const data = new URLSearchParams(launch())
    data.set('user', JSON.stringify({ id: OWNER, first_name: 'Mallory' }))
    expect(checkInitData(data.toString(), { token: TOKEN, ownerId: OWNER, now })).toMatchObject({ ok: false, reason: 'the signature does not match this bot' })
    expect(checkInitData(launch({ token: '999:another-bot' }), { token: TOKEN, ownerId: OWNER, now }).ok).toBe(false)
    const unsigned = new URLSearchParams(launch())
    unsigned.delete('hash')
    expect(checkInitData(unsigned.toString(), { token: TOKEN, ownerId: OWNER, now })).toMatchObject({ ok: false, reason: 'unsigned' })
  })

  test("someone else's, too old, from the future, or with no owner yet: refused", () => {
    expect(checkInitData(launch({ user: 9009 }), { token: TOKEN, ownerId: OWNER, now })).toMatchObject({ ok: false, userId: 9009 })
    expect(checkInitData(launch({ at: now - INIT_DATA_MAX_AGE_MS - 60_000 }), { token: TOKEN, ownerId: OWNER, now })).toMatchObject({ ok: false, reason: 'opened 11 minutes ago' })
    expect(checkInitData(launch({ at: now + 5 * 60_000 }), { token: TOKEN, ownerId: OWNER, now }).ok).toBe(false)
    expect(checkInitData(launch(), { token: TOKEN, ownerId: null, now }).ok).toBe(false)
    expect(checkInitData(undefined, { token: TOKEN, ownerId: OWNER, now }).ok).toBe(false)
    expect(checkInitData('not=launch&data=1', { token: TOKEN, ownerId: OWNER, now }).ok).toBe(false)
  })
})
