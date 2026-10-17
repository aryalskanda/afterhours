import { describe, expect, test } from 'bun:test'
import { isDarkColor, readLaunch, telegramDevice, telegramStorage, type TelegramStore } from './telegram'

const initData = 'query_id=AAE&user=%7B%22id%22%3A7001%7D&auth_date=1792238400&hash=abc'
const hash = `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=9.1&tgWebAppPlatform=ios&tgWebAppThemeParams=${encodeURIComponent(JSON.stringify({ bg_color: '#17212b' }))}`

describe('the launch inside Telegram', () => {
  test('read from the address: the signed data as Telegram gave it, the platform, its dark, and the bot', () => {
    expect(readLaunch(hash, '?bot=afterhours_bot', null, null)).toEqual({ initData, platform: 'ios', version: '9.1', dark: true, bot: 'afterhours_bot' })
  })

  test('once the app moved on to other addresses, from what this tab kept; outside Telegram, nothing', () => {
    expect(readLaunch('', '', hash.slice(1), 'kept_bot')).toMatchObject({ initData, bot: 'kept_bot' })
    expect(readLaunch('#section', '?bot=x', null, null)).toBeNull()
    // Only a bot's name goes in a t.me link.
    expect(readLaunch(hash, '?bot=../evil', null, null)?.bot).toBeNull()
  })

  test("light or dark from Telegram's background", () => {
    expect(isDarkColor('#ffffff')).toBe(false)
    expect(isDarkColor('#17212b')).toBe(true)
    expect(isDarkColor(undefined)).toBeNull()
  })

  test('what machines call it', () => {
    const launch = readLaunch(hash, '', null, null)!
    expect(telegramDevice(launch, 'Mozilla/5.0 (iPhone)')).toEqual({ platform: 'telegram-ios', name: 'Telegram on iPhone' })
    expect(telegramDevice(launch, 'Mozilla/5.0 (iPad)').name).toBe('Telegram on iPad')
    expect(telegramDevice({ ...launch, platform: 'android' }).platform).toBe('telegram-android')
    expect(telegramDevice({ ...launch, platform: 'tdesktop' }).name).toBe('Telegram Desktop')
    expect(telegramDevice({ ...launch, platform: 'weba' }).platform).toBe('telegram-web')
  })
})

function memory(works = true): TelegramStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async k => (works ? (data.get(k) ?? null) : null),
    set: async (k, v) => (works ? (data.set(k, v), true) : false),
    remove: async k => (works ? data.delete(k) : false),
  }
}

describe('storage inside Telegram', () => {
  test("the key goes in Telegram's secure storage; the rest in its device storage", async () => {
    const secure = memory()
    const device = memory()
    const web = memory()
    const s = telegramStorage(web, { secure, device })
    await s.setSecret('key', 'k1')
    await s.set('machines', '[]')
    expect([secure.data.get('key'), device.data.get('key'), web.data.get('key')]).toEqual(['k1', undefined, undefined])
    expect(device.data.get('machines')).toBe('[]')
    expect(await s.getSecret('key')).toBe('k1')
  })

  test('a Telegram without them keeps everything in the web view, as a browser does', async () => {
    const web = memory()
    const s = telegramStorage(web, { secure: memory(false), device: memory(false) })
    await s.setSecret('key', 'k1')
    expect(web.data.get('key')).toBe('k1')
    expect(await s.getSecret('key')).toBe('k1')
  })

  test('a key kept by an older Telegram is found, and moves into secure storage', async () => {
    const secure = memory()
    const web = memory()
    web.data.set('key', 'old')
    const s = telegramStorage(web, { secure, device: memory(false) })
    expect(await s.getSecret('key')).toBe('old')
    expect(secure.data.get('key')).toBe('old')
    expect(web.data.get('key')).toBe('')
    expect(await s.getSecret('key')).toBe('old')
  })
})
