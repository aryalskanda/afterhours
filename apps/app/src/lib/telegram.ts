// Inside Telegram, the parts that don't need Telegram itself: reading the launch parameters,
// naming the device, and the storage chain (src/telegram.ts runs them with Telegram.WebApp).

export interface TelegramLaunch {
  /** Telegram's signed launch data: the machine checks it while pairing. */
  initData: string
  /** ios, android, tdesktop, macos, weba, webk… */
  platform: string
  version: string
  /** From Telegram's theme: its light or dark. */
  dark: boolean | null
  /** The bot that opened the app (the menu button says), to send you back to it to set up. */
  bot: string | null
}

/** Light or dark from a colour: Telegram's theme gives its background. */
export function isDarkColor(hex: string | undefined): boolean | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/**
 * Reads the launch parameters from the address's hash, or from this tab's storage once the app has
 * moved on to other addresses. Null outside Telegram.
 */
export function readLaunch(hash: string, search: string, kept: string | null, bot: string | null): TelegramLaunch | null {
  const raw = hash.replace(/^#/, '')
  const fresh = raw.includes('tgWebAppData=') || raw.includes('tgWebAppPlatform=')
  const source = fresh ? raw : kept
  if (!source) return null
  const p = new URLSearchParams(source)
  const initData = p.get('tgWebAppData') ?? ''
  const platform = p.get('tgWebAppPlatform') ?? 'unknown'
  let dark: boolean | null = null
  try {
    dark = isDarkColor((JSON.parse(p.get('tgWebAppThemeParams') ?? '{}') as { bg_color?: string }).bg_color)
  } catch {
    // No theme: follow the system.
  }
  const fromAddress = new URLSearchParams(search.replace(/^\?/, '')).get('bot')
  return { initData, platform, version: p.get('tgWebAppVersion') ?? '6.0', dark, bot: fromAddress && /^\w{3,64}$/.test(fromAddress) ? fromAddress : bot }
}

/** What machines see this device as, and its name until you change it. */
export function telegramDevice(launch: TelegramLaunch, ua = globalThis.navigator?.userAgent ?? ''): { platform: string; name: string } {
  switch (launch.platform) {
    case 'ios':
      return { platform: 'telegram-ios', name: /iPad/.test(ua) ? 'Telegram on iPad' : 'Telegram on iPhone' }
    case 'android':
    case 'android_x':
      return { platform: 'telegram-android', name: 'Telegram on Android' }
    case 'macos':
      return { platform: 'telegram-mac', name: 'Telegram on Mac' }
    case 'tdesktop':
      return { platform: 'telegram-desktop', name: 'Telegram Desktop' }
    case 'weba':
    case 'webk':
    case 'web':
      return { platform: 'telegram-web', name: 'Telegram Web' }
    default:
      return { platform: 'telegram', name: 'Telegram' }
  }
}

export interface TelegramStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<boolean>
  remove(key: string): Promise<boolean>
}

export interface KeyValue {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
}

/**
 * Storage inside Telegram. The device key goes in Telegram's secure storage (the Keychain or
 * Keystore) where this Telegram has it, else in its device storage, else the web view's; the rest
 * in device storage, which survives the web view's data being cleared. Reading looks in each, so
 * nothing kept by an older Telegram is lost, and a key found further down moves up.
 */
export function telegramStorage(web: KeyValue, stores: { secure: TelegramStore; device: TelegramStore }) {
  const webStore = { get: web.get, set: async (k: string, v: string) => (await web.set(k, v), true), remove: async (k: string) => (await web.set(k, ''), true) }
  const secretTiers = [stores.secure, stores.device, webStore]
  const plainTiers = [stores.device, webStore]
  const read = async (tiers: typeof secretTiers, key: string): Promise<{ value: string; tier: number } | null> => {
    for (let i = 0; i < tiers.length; i++) {
      const value = await tiers[i]!.get(key)
      if (value) return { value, tier: i }
    }
    return null
  }
  const write = async (tiers: typeof secretTiers, key: string, value: string): Promise<number> => {
    for (let i = 0; i < tiers.length; i++) if (await tiers[i]!.set(key, value)) return i
    return -1
  }
  return {
    getSecret: async (key: string) => {
      const found = await read(secretTiers, key)
      if (found && found.tier > 0) {
        const to = await write(secretTiers, key, found.value)
        if (to >= 0 && to < found.tier) await secretTiers[found.tier]!.remove(key)
      }
      return found?.value ?? null
    },
    setSecret: async (key: string, value: string) => {
      if ((await write(secretTiers, key, value)) < 0) throw new Error('Couldn’t keep this device’s key.')
    },
    get: async (key: string) => (await read(plainTiers, key))?.value ?? null,
    set: async (key: string, value: string) => {
      await write(plainTiers, key, value)
    },
  }
}
