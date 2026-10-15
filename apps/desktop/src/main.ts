// The desktop app: the app's web build in a locked-down window, plus what a browser tab can't do.
// It keeps running in the tray, shows system notifications and the needs-you count, starts at
// login, opens afterhours:// links, and keeps the device's key in the OS keychain.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { autostartEntry, autostartPath } from './autostart'
import { checkCount, checkNotice, checkSecretKey, checkSecretValue, type Notice } from './inputs'
import { cleanLink, findLink } from './links'
import { SecretStore, type Cipher } from './secrets'
import { allowPermission, APP_SCHEME, APP_URL, CONTENT_SECURITY_POLICY, contentType, fileFor, isAppUrl, isSafeExternal } from './security'

/** Never in an installed build: side effects (notifications, the browser, login items) are recorded instead. */
const TEST = !app.isPackaged && process.env.AFTERHOURS_TEST === '1'
const isMac = process.platform === 'darwin'
const APP_ID = 'dev.afterhours.app'

// Before anything else: the data folder decides the single-instance lock and the keychain entry.
if (TEST) app.setName('Afterhours Test')
if (process.env.AFTERHOURS_USER_DATA) app.setPath('userData', process.env.AFTERHOURS_USER_DATA)

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])

// The app's folder (its archive, once installed). Not __dirname: the bundler fixes that at build time.
const root = () => app.getAppPath()
const webRoot = () => join(root(), 'web')
const asset = (name: string) => join(root(), 'assets', name)

let win: BrowserWindow | null = null
let tray: Tray | null = null
let secrets: SecretStore | null = null
let quitting = false
let needsYou = 0
type Kind = 'link' | 'route'
/** Links and routes for the window, held until its page asks for them (it may still be loading). */
const pending: Record<Kind, string[]> = { link: [], route: [] }
const listening: Record<Kind, boolean> = { link: false, route: false }
/** Shown notifications, kept so their click handlers live as long as they do. */
const shown = new Set<Notification>()
const recorded = { notifications: [] as Notice[], external: [] as string[], loginItem: false }
const trayShows = { title: '', tooltip: 'Afterhours' }

function log(line: string): void {
  console.log(`afterhours: ${line}`)
}

function deviceName(): string {
  if (isMac) {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim()
      if (name) return name.slice(0, 80)
    } catch {
      // Fall back to the host name.
    }
  }
  return (hostname().split('.')[0] || 'Computer').slice(0, 80)
}

/** safeStorage, when the OS really keeps the key (Linux without a keyring falls back to a fixed one). */
function cipher(): Cipher {
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
  return {
    protected: safeStorage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown',
    encrypt: text => safeStorage.encryptString(text),
    decrypt: data => safeStorage.decryptString(data),
  }
}

function info() {
  return { version: app.getVersion(), platform: process.platform, deviceName: deviceName(), keyProtected: secrets?.protected ?? false, test: TEST }
}

// --- the window ----------------------------------------------------------------------------------

async function serve(request: Request): Promise<Response> {
  const file = fileFor(request.url, webRoot(), sep)
  if (!file) return new Response('Not found', { status: 404 })
  const headers = { 'content-security-policy': CONTENT_SECURITY_POLICY, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' }
  try {
    const body = await readFile(file)
    return new Response(body, { headers: { ...headers, 'content-type': contentType(file) } })
  } catch {
    // A file that isn't there is missing; any other path is one of the app's pages (/inbox, /machine/…).
    if (/\.[A-Za-z0-9]+$/.test(file)) return new Response('Not found', { status: 404, headers })
    return new Response(await readFile(join(webRoot(), 'index.html')), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
  }
}

function createWindow(hidden: boolean): BrowserWindow {
  const w = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'Afterhours',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1320' : '#f2f2f7',
    icon: isMac ? undefined : asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(root(), 'dist', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // It keeps hearing from machines while it's hidden in the tray: no throttled timers.
      backgroundThrottling: false,
      spellcheck: true,
      devTools: !app.isPackaged,
      additionalArguments: [`--afterhours=${Buffer.from(JSON.stringify(info()), 'utf8').toString('base64')}`],
    },
  })
  w.on('close', event => {
    if (quitting) return
    // Closing the window keeps the app (and its connections) running in the tray.
    event.preventDefault()
    w.hide()
    stillRunningHint()
  })
  w.once('ready-to-show', () => {
    if (!hidden) w.show()
  })
  w.webContents.on('did-start-navigation', details => {
    // A reload: the page asks again for what's waiting once it's listening.
    if (details.isMainFrame && !details.isSameDocument) listening.link = listening.route = false
  })
  w.webContents.on('render-process-gone', (_event, details) => {
    log(`the window's page stopped (${details.reason}); reloading`)
    if (!quitting) setTimeout(() => !w.isDestroyed() && w.reload(), 1000)
  })
  void w.loadURL(APP_URL)
  return w
}

function showWindow(): void {
  if (!app.isReady()) return
  if (!win || win.isDestroyed()) win = createWindow(false)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function deliver(kind: Kind, value: string): void {
  if (win && !win.isDestroyed() && listening[kind]) win.webContents.send('open', { kind, value })
  else pending[kind].push(value)
}

function openLink(link: string): void {
  showWindow()
  deliver('link', link)
}

function openRoute(route: string): void {
  showWindow()
  deliver('route', route)
}

function openExternal(url: string): void {
  if (!isSafeExternal(url)) return
  if (TEST) recorded.external.push(url)
  else void shell.openExternal(url)
}

/** Windows and Linux: the first time the window is closed, say the app is still there. */
function stillRunningHint(): void {
  if (isMac) return
  const file = join(app.getPath('userData'), 'desktop.json')
  let state: { trayHint?: boolean } = {}
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as typeof state
  } catch {
    // First run.
  }
  if (state.trayHint) return
  writeFileSync(file, JSON.stringify({ ...state, trayHint: true }))
  notify({ title: 'Afterhours is still running', body: 'It keeps hearing from your machines from the tray. Quit it from there.', route: '/' }, true)
}

// --- tray, badge, notifications, login item -------------------------------------------------

function trayMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: 'Open Afterhours', click: () => showWindow() },
    { label: needsYou ? `Needs you (${needsYou})` : 'Nothing needs you', enabled: needsYou > 0, click: () => openRoute('/inbox') },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: loginItem(), click: item => setLoginItem(item.checked) },
    { type: 'separator' },
    { label: 'Quit Afterhours', click: () => app.quit() },
  ]
  return Menu.buildFromTemplate(template)
}

function updateTray(): void {
  if (!tray) return
  trayShows.tooltip = needsYou ? `Afterhours: ${needsYou} need${needsYou === 1 ? 's' : ''} you` : 'Afterhours'
  trayShows.title = needsYou ? String(needsYou) : ''
  tray.setToolTip(trayShows.tooltip)
  if (isMac) tray.setTitle(trayShows.title, { fontType: 'monospacedDigit' })
  tray.setContextMenu(trayMenu())
}

function createTray(): void {
  const image = nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray.png'))
  if (isMac) image.setTemplateImage(true)
  tray = new Tray(image)
  // Windows: a click opens the window (the menu is on right-click). Mac and Linux show the menu.
  if (process.platform === 'win32') tray.on('click', () => showWindow())
  updateTray()
}

function setNeedsYou(count: number): void {
  if (count === needsYou) return
  needsYou = count
  if (isMac) app.dock?.setBadge(count ? String(count) : '')
  else if (process.platform === 'linux') app.setBadgeCount(count)
  else win?.setOverlayIcon(count ? nativeImage.createFromPath(asset('overlay.png')) : null, count ? `${count} need you` : '')
  updateTray()
}

/** A system notification, unless the window is in front (the page shows its own banner then). */
function notify(n: Notice, always = false): void {
  if (!always && win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return
  if (TEST) {
    recorded.notifications.push(n)
    return
  }
  if (!Notification.isSupported()) return
  const note = new Notification({ title: n.title, body: n.body, icon: isMac ? undefined : asset('icon.png') })
  note.on('click', () => openRoute(n.route))
  note.on('close', () => shown.delete(note))
  shown.add(note)
  note.show()
}

function loginItem(): boolean {
  if (TEST) return recorded.loginItem
  if (!app.isPackaged) return false
  if (process.platform === 'linux') return existsSync(autostartPath(homedir()))
  return app.getLoginItemSettings().openAtLogin
}

function setLoginItem(on: boolean): void {
  if (TEST) recorded.loginItem = on
  else if (!app.isPackaged) log('start at login works in the installed app only')
  else if (process.platform === 'linux') {
    const file = autostartPath(homedir())
    if (on) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, autostartEntry(process.env.APPIMAGE || process.execPath))
    } else rmSync(file, { force: true })
  } else app.setLoginItemSettings({ openAtLogin: on, ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}) })
  updateTray()
}

// --- what the page may ask -----------------------------------------------------------------------

/** Only the app's own page, in its own window. */
function fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return win !== null && !win.isDestroyed() && event.sender === win.webContents && frame !== null && isAppUrl(frame.url)
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('Not allowed.')
    return fn(...args)
  })
}

function on(channel: string, fn: (...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!fromApp(event)) return
    try {
      fn(...args)
    } catch (err) {
      log(`${channel}: ${err instanceof Error ? err.message : err}`)
    }
  })
}

function listen(): void {
  handle('secrets:get', key => secrets!.get(checkSecretKey(key)))
  handle('secrets:set', (key, value) => secrets!.set(checkSecretKey(key), checkSecretValue(value)))
  on('notify', n => notify(checkNotice(n)))
  on('needs-you', count => setNeedsYou(checkCount(count)))
  handle('login-item:get', () => loginItem())
  handle('login-item:set', value => {
    if (typeof value !== 'boolean') throw new Error('Not a yes or no.')
    setLoginItem(value)
  })
  handle('open:pending', kind => {
    if (kind !== 'link' && kind !== 'route') throw new Error('Unknown kind.')
    listening[kind] = true
    return pending[kind].splice(0)
  })
  if (TEST) {
    handle('test:state', () => ({ ...recorded, needsYou, tray: trayShows, visible: win?.isVisible() ?? false }))
    // As the window's close button does.
    handle('test:close-window', () => win?.close())
    handle('test:click-notification', index => {
      const n = typeof index === 'number' ? recorded.notifications[index] : undefined
      if (n) openRoute(n.route)
    })
  }
}

function lockDown(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', event => {
      if (isAppUrl(event.url)) return
      event.preventDefault()
      openExternal(event.url)
    })
    contents.on('will-redirect', event => {
      if (!isAppUrl(event.url)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
  })
}

function appMenu(): void {
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }
  // The Mac needs an Edit menu for copy and paste to work in text fields.
  const view: MenuItemConstructorOptions[] = [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }]))
}

async function ready(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  if (app.isPackaged && !TEST) app.setAsDefaultProtocolClient('afterhours')
  secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'), cipher(), log)
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowPermission(permission, details.requestingUrl)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => allowPermission(permission, origin))
  protocol.handle(APP_SCHEME, serve)
  appMenu()
  listen()
  createTray()
  const link = findLink(process.argv)
  if (link) pending.link.push(link)
  const atLogin = process.argv.includes('--hidden') || (isMac && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin)
  win = createWindow(atLogin && pending.link.length === 0)
}

function start(): void {
  lockDown()
  app.on('second-instance', (_event, argv) => {
    const link = findLink(argv)
    if (link) openLink(link)
    else showWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const link = cleanLink(url)
    if (!link) return
    if (app.isReady() && win) openLink(link)
    else pending.link.push(link)
  })
  app.on('activate', () => showWindow())
  app.on('before-quit', () => {
    quitting = true
  })
  // Stays in the tray with no window open.
  app.on('window-all-closed', () => {})
  void app.whenReady().then(ready)
}

if (app.requestSingleInstanceLock()) start()
else app.quit()
