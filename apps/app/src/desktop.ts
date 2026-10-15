// The desktop app (apps/desktop) runs this app's web build and adds a bridge to the computer: the
// OS keychain, system notifications, the tray, start at login and afterhours:// links. Elsewhere
// (phones, a plain browser) there is no bridge.

export interface DesktopBridge {
  info: {
    version: string
    platform: string
    deviceName: string
    /** The key is encrypted by the OS (on Linux, only with a keyring). */
    keyProtected: boolean
    test: boolean
  }
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
  /** A system notification; clicking it opens the window on `route`. */
  notify(n: { title: string; body: string; route: string }): void
  /** The tray's and the dock's count. */
  setNeedsYou(count: number): void
  onNavigate(cb: (route: string) => void): () => void
  onLink(cb: (link: string) => void): () => void
  loginItem: { get(): Promise<boolean>; set(on: boolean): Promise<void> }
}

export const desktop: DesktopBridge | undefined = (globalThis as { afterhoursDesktop?: DesktopBridge }).afterhoursDesktop

/** What machines see this device as. */
export const desktopPlatform: string | undefined = desktop
  ? ({ darwin: 'desktop-mac', win32: 'desktop-windows', linux: 'desktop-linux' } as Record<string, string>)[desktop.info.platform] ?? 'desktop'
  : undefined
