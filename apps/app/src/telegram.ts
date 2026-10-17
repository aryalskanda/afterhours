// Inside Telegram: the app opened from the bot as a Mini App. Telegram's launch data comes in the
// address (#tgWebAppData=…); telegram-web-app.js, loaded only then, adds Telegram's Back button,
// its light or dark, haptics, its QR scanner and storage that outlives the web view's. Elsewhere
// (phones, a browser, the desktop app) there is no Telegram and none of this runs.

import { Linking, Platform } from 'react-native'
import { readLaunch, telegramStorage as storageChain, type KeyValue, type TelegramLaunch } from './lib/telegram'

export { telegramDevice, type TelegramLaunch } from './lib/telegram'

type Callback = (...args: never[]) => void

/** The slice of Telegram.WebApp the app uses (https://core.telegram.org/bots/webapps). */
export interface TelegramWebApp {
  initData: string
  version: string
  platform: string
  colorScheme: 'light' | 'dark'
  isVersionAtLeast(version: string): boolean
  ready(): void
  expand(): void
  disableVerticalSwipes?(): void
  setHeaderColor(color: string): void
  setBackgroundColor(color: string): void
  setBottomBarColor?(color: string): void
  enableClosingConfirmation(): void
  disableClosingConfirmation(): void
  onEvent(event: string, cb: Callback): void
  offEvent(event: string, cb: Callback): void
  openLink(url: string): void
  openTelegramLink(url: string): void
  showScanQrPopup(params: { text?: string }, cb?: (text: string) => boolean | void): void
  closeScanQrPopup(): void
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void }
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void
    notificationOccurred(type: 'error' | 'success' | 'warning'): void
    selectionChanged(): void
  }
  SecureStorage?: NativeStore
  DeviceStorage?: NativeStore
}

interface NativeStore {
  setItem(key: string, value: string, cb?: (error: unknown, ok?: boolean) => void): void
  getItem(key: string, cb: (error: unknown, value?: string | null) => void): void
  removeItem(key: string, cb?: (error: unknown, ok?: boolean) => void): void
}

const LAUNCH_KEY = 'afterhours.telegramLaunch'
const BOT_KEY = 'afterhours.telegramBot'

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function detect(): TelegramLaunch | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.location) return null
  const launch = readLaunch(window.location.hash ?? '', window.location.search ?? '', session()?.getItem(LAUNCH_KEY) ?? null, local()?.getItem(BOT_KEY) ?? null)
  if (!launch) return null
  if (window.location.hash.includes('tgWebApp')) {
    try {
      session()?.setItem(LAUNCH_KEY, window.location.hash.slice(1))
    } catch {
      // Private mode: the launch data lives for this page only.
    }
  }
  if (launch.bot) {
    try {
      local()?.setItem(BOT_KEY, launch.bot)
    } catch {
      // Not kept; the menu button gives it again next time.
    }
  }
  return launch
}

/** Set when the app runs inside Telegram. */
export const telegramLaunch: TelegramLaunch | null = detect()
export const inTelegram = telegramLaunch !== null

let webApp: TelegramWebApp | null = null

function loadScript(): Promise<TelegramWebApp | null> {
  const existing = (globalThis as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp
  if (existing) return Promise.resolve(existing)
  return new Promise(resolve => {
    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-web-app.js'
    script.async = true
    script.onload = () => resolve((globalThis as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null)
    script.onerror = () => resolve(null)
    document.head.appendChild(script)
  })
}

/** Telegram.WebApp once its script has loaded; null outside Telegram (or if it didn't load). */
export const telegramReady: Promise<TelegramWebApp | null> = inTelegram
  ? loadScript().then(w => {
      webApp = w
      if (w) {
        w.ready()
        w.expand()
        // Scrolling a long list shouldn't close the app.
        if (w.isVersionAtLeast('7.7')) w.disableVerticalSwipes?.()
      }
      return w
    })
  : Promise.resolve(null)

/** Telegram.WebApp, when it's loaded. */
export function telegram(): TelegramWebApp | null {
  return webApp
}

const supports = (version: string) => webApp?.isVersionAtLeast(version) === true

// --- light or dark --------------------------------------------------------------------------

let dark: boolean | null = telegramLaunch?.dark ?? null
const schemeListeners = new Set<() => void>()

void telegramReady.then(w => {
  if (!w) return
  const update = () => {
    dark = w.colorScheme === 'dark'
    for (const l of schemeListeners) l()
  }
  update()
  w.onEvent('themeChanged', update)
})

/** Telegram's light or dark (null outside Telegram): Appearance "System" follows it there. */
export function telegramDark(): boolean | null {
  return dark
}

export function onTelegramScheme(listener: () => void): () => void {
  schemeListeners.add(listener)
  return () => schemeListeners.delete(listener)
}

/** Telegram's own bars in the page's colour. */
export function setTelegramColors(page: string): void {
  if (!webApp || !supports('6.1')) return
  try {
    webApp.setHeaderColor(page)
    webApp.setBackgroundColor(page)
    if (supports('7.10')) webApp.setBottomBarColor?.(page)
  } catch {
    // An older Telegram: its own colours stay.
  }
}

// --- what Telegram does for the app ---------------------------------------------------------

/** Telegram's Back button, in its header: shown while there's somewhere to go back to. */
export function setTelegramBack(visible: boolean, onBack: () => void): () => void {
  const w = webApp
  if (!w || !supports('6.1')) return () => {}
  if (!visible) {
    w.BackButton.hide()
    return () => {}
  }
  w.BackButton.show()
  w.BackButton.onClick(onBack)
  return () => w.BackButton.offClick(onBack)
}

export function telegramHaptic(kind: 'success' | 'warning' | 'error' | 'tap'): boolean {
  if (!webApp || !supports('6.1')) return false
  if (kind === 'tap') webApp.HapticFeedback.impactOccurred('light')
  else webApp.HapticFeedback.notificationOccurred(kind)
  return true
}

/** Opens a link outside the app: in Telegram's browser, or (t.me) in Telegram itself. */
export function telegramOpen(url: string): boolean {
  if (!webApp) return false
  if (/^https:\/\/t\.me\//.test(url)) webApp.openTelegramLink(url)
  else webApp.openLink(url)
  return true
}

/** Opens a link outside the app: through Telegram inside it, else as usual. */
export function openLink(url: string): void {
  if (!telegramOpen(url)) void Linking.openURL(url)
}

/** Telegram's QR scanner, when this Telegram has one; resolves with what it read, or null. */
export function telegramScanner(): ((text: string) => Promise<string | null>) | null {
  const w = webApp
  if (!w || !supports('6.4') || !['ios', 'android', 'android_x'].includes(w.platform)) return null
  return text =>
    new Promise(resolve => {
      let done = false
      const closed = () => {
        if (!done) resolve(null)
        w.offEvent('scanQrPopupClosed', closed)
      }
      w.onEvent('scanQrPopupClosed', closed)
      w.showScanQrPopup({ text }, data => {
        done = true
        resolve(data)
        return true
      })
    })
}

/** While a prompt is being written, closing the app asks first. */
export function telegramConfirmClose(on: boolean): void {
  if (!webApp || !supports('6.2')) return
  if (on) webApp.enableClosingConfirmation()
  else webApp.disableClosingConfirmation()
}

// --- storage --------------------------------------------------------------------------------

/** One of Telegram's stores, as promises; a store that doesn't answer is skipped from then on. */
function store(pick: (w: TelegramWebApp) => NativeStore | undefined, version: string) {
  let dead = false
  const call = <T>(run: (s: NativeStore, done: (v: T) => void) => void, fallback: T): Promise<T> =>
    telegramReady.then(
      w =>
        new Promise<T>(resolve => {
          const s = w && !dead && w.isVersionAtLeast(version) ? pick(w) : undefined
          if (!s) return resolve(fallback)
          const timer = setTimeout(() => {
            dead = true
            resolve(fallback)
          }, 2500)
          const done = (v: T) => {
            clearTimeout(timer)
            resolve(v)
          }
          try {
            run(s, done)
          } catch {
            dead = true
            done(fallback)
          }
        }),
    )
  return {
    get: (key: string) => call<string | null>((s, done) => s.getItem(key, (err, value) => done(err ? null : (value ?? null))), null),
    set: (key: string, value: string) => call<boolean>((s, done) => s.setItem(key, value, (err, ok) => done(!err && ok !== false)), false),
    remove: (key: string) => call<boolean>((s, done) => s.removeItem(key, err => done(!err)), false),
  }
}


/** Storage inside Telegram: see telegramStorage in lib/telegram. */
export function telegramStorage(web: KeyValue) {
  return storageChain(web, { secure: store(w => w.SecureStorage, '9.0'), device: store(w => w.DeviceStorage, '9.0') })
}
