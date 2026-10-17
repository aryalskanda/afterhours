// A stand-in for telegram-web-app.js, for the end-to-end runs: in the page before the app loads (so
// the real script never is), recording what the app asks Telegram to do.

import type { Page } from 'puppeteer-core'

/** Telegram's launch data in an address's hash, as Telegram adds it. */
export function launchHash(initData: string): string {
  return `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=9.1&tgWebAppPlatform=ios&tgWebAppThemeParams=${encodeURIComponent(JSON.stringify({ bg_color: '#17212b' }))}`
}

export async function installTelegram(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const calls: string[] = []
    const at = (v: string) => v.split('.').map(Number)
    const atLeast = (v: string) => {
      const [a, b] = [at('9.1'), at(v)]
      for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
      return true
    }
    const storage = (name: string) => {
      const data = new Map<string, string>(JSON.parse(sessionStorage.getItem(`__tg.${name}`) ?? '[]'))
      const keep = () => sessionStorage.setItem(`__tg.${name}`, JSON.stringify([...data]))
      return {
        data,
        setItem: (k: string, v: string, cb?: (e: unknown, ok?: boolean) => void) => (data.set(k, v), keep(), cb?.(null, true)),
        getItem: (k: string, cb: (e: unknown, v?: string | null) => void) => cb(null, data.get(k) ?? null),
        removeItem: (k: string, cb?: (e: unknown, ok?: boolean) => void) => (data.delete(k), keep(), cb?.(null, true)),
      }
    }
    const back = { visible: false, cb: null as null | (() => void) }
    ;(window as unknown as { __tg: unknown }).__tg = { calls, back }
    ;(window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        initData: '',
        version: '9.1',
        platform: 'ios',
        colorScheme: 'dark',
        isVersionAtLeast: atLeast,
        ready: () => calls.push('ready'),
        expand: () => calls.push('expand'),
        disableVerticalSwipes: () => calls.push('noSwipes'),
        setHeaderColor: (c: string) => calls.push(`header:${c}`),
        setBackgroundColor: (c: string) => calls.push(`background:${c}`),
        setBottomBarColor: (c: string) => calls.push(`bottom:${c}`),
        enableClosingConfirmation: () => calls.push('confirmClose:on'),
        disableClosingConfirmation: () => calls.push('confirmClose:off'),
        onEvent: () => {},
        offEvent: () => {},
        openLink: (u: string) => calls.push(`link:${u}`),
        openTelegramLink: (u: string) => calls.push(`telegram:${u}`),
        showScanQrPopup: () => calls.push('scan'),
        closeScanQrPopup: () => {},
        BackButton: {
          show: () => (back.visible = true),
          hide: () => (back.visible = false),
          onClick: (cb: () => void) => (back.cb = cb),
          offClick: (cb: () => void) => {
            if (back.cb === cb) back.cb = null
          },
        },
        HapticFeedback: { impactOccurred: (s: string) => calls.push(`impact:${s}`), notificationOccurred: (t: string) => calls.push(`haptic:${t}`), selectionChanged: () => {} },
        SecureStorage: storage('secure'),
        DeviceStorage: storage('device'),
      },
    }
  })
}

/** What Telegram.WebApp was asked to do. */
export const telegramCalls = (page: Page) => page.evaluate(() => (window as unknown as { __tg: { calls: string[] } }).__tg.calls)
