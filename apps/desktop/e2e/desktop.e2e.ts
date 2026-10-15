// The desktop app, end to end. Electron runs in test mode: its own data folder, and notifications,
// links to the browser and login items are recorded instead of done. It's driven through its
// debugging port with the web runs' helpers, against scripted machines through a real relay.
//   npm run build && bun e2e/desktop.e2e.ts             the app built in this folder, every step
//   ELECTRON_APP=<executable> bun e2e/desktop.e2e.ts    an installed build: the steps without test hooks
// ELECTRON_EXTRA_ARGS adds switches (--no-sandbox in a container); E2E_OUT moves the screenshots.

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Request } from '@afterhours/protocol'
import { startRelay } from '../../../relay/src/server'
import { connect, until, type Driver } from '../../app/e2e/browser'
import { askSamples, fakeMachine } from '../../app/e2e/fake-machine'

const appDir = join(import.meta.dir, '..')
const packaged = process.env.ELECTRON_APP
const executable = packaged ?? (createRequire(import.meta.url)('electron') as string)
const extra = (process.env.ELECTRON_EXTRA_ARGS ?? '').split(' ').filter(Boolean)
// An installed build is the real app: on a Mac its Keychain entry is the real one, and a new build
// (another ad-hoc signature) would make macOS ask before reading it. Chromium's test keychain keeps
// the run away from yours. (In test mode the app has an entry of its own, and the Electron binary's
// signature doesn't change, so that run uses the real Keychain.)
if (packaged && process.platform === 'darwin' && process.env.E2E_REAL_KEYCHAIN !== '1') extra.push('--use-mock-keychain')
const out = process.env.E2E_OUT ?? join(import.meta.dir, 'out')
mkdirSync(out, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'afterhours-desktop-e2e-'))
const env = { ...process.env, AFTERHOURS_USER_DATA: userData, ...(packaged ? {} : { AFTERHOURS_TEST: '1' }) }

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

function launch(args: string[]): ChildProcess {
  const child = spawn(executable, [...(packaged ? [] : [appDir]), ...extra, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(out, 'electron.log'), { flags: 'a' })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  return child
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(i => i && i.family === 'IPv4' && !i.internal)?.address

// One relay for everything, listening on every interface so the local network can reach it too.
const relay = startRelay({ port: 0, hostname: '0.0.0.0' })
const machine = fakeMachine({ relay: relay.url })
const port = await freePort()
const app = launch([`--remote-debugging-port=${port}`])
let d: Driver | null = null
let failures = 0
let mark = 0

type TestState = { notifications: { title: string; body: string; route: string }[]; external: string[]; loginItem: boolean; needsYou: number; tray: { title: string; tooltip: string }; visible: boolean }
const state = () => d!.page.evaluate(() => (window as unknown as { afterhoursDesktop: { test: { state(): Promise<unknown> } } }).afterhoursDesktop.test.state()) as Promise<TestState>
const sent = <T extends Request['type']>(m: ReturnType<typeof fakeMachine>, type: T, match: (r: Extract<Request, { type: T }>) => boolean = () => true) =>
  m.requests.find((r): r is Extract<Request, { type: T }> => r.type === type && match(r as Extract<Request, { type: T }>))

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await d!.check(name, run)
  } catch {
    failures++
  }
}

try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok, 'the app to start', 30_000)
  d = await connect(`http://127.0.0.1:${port}`, u => u.startsWith('app://afterhours/'), out)
  const driver = d
  const { page, tap, typeInto, see, visible, shot } = driver

  // Every file the app asks its own scheme for must be there (fonts and images included).
  const missing: string[] = []
  page.on('response', r => {
    if (r.url().startsWith('app://') && r.status() >= 400) missing.push(`${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', r => {
    if (r.url().startsWith('app://')) missing.push(`failed ${r.url()}`)
  })

  await check('the app loads from inside itself, with no Node in the page', async () => {
    await page.reload()
    await see('Welcome to Afterhours', 20_000)
    if (!page.url().startsWith('app://afterhours/')) throw new Error(`loaded ${page.url()}`)
    // (The web build has a `process` of its own, for its settings; Node's would have versions.node.)
    const exposed = await page.evaluate(() => {
      const w = window as unknown as { require?: unknown; process?: { versions?: { node?: string } } }
      return { bridge: 'afterhoursDesktop' in window, require: typeof w.require, node: w.process?.versions?.node ?? null }
    })
    if (!exposed.bridge || exposed.require !== 'undefined' || exposed.node !== null) throw new Error(JSON.stringify(exposed))
    await shot('01-welcome')
  })

  await check('pairing by pasting the link; the machine is online', async () => {
    await tap('pair-first')
    await typeInto('pair-link', machine.offer())
    await tap('pair-go')
    await see('Paired with build-box')
    await tap('pair-open')
    await see('Online')
    await see('#14 Add a dark mode toggle')
    await shot('02-machine')
  })

  await check('the key is in the encrypted secrets file, not in the page’s storage', async () => {
    const inPage = await page.evaluate(() => localStorage.getItem('afterhours.identity'))
    if (inPage !== null) throw new Error('the key is in localStorage')
    const file = JSON.parse(readFileSync(join(userData, 'secrets.json'), 'utf8')) as { items: Record<string, { protected: boolean; data: string }> }
    const item = file.items['afterhours.identity']
    if (!item) throw new Error('no key in secrets.json')
    // What the OS encrypts (Chromium's OSCrypt) starts with its version: v10, or v11 with a keyring.
    const stored = Buffer.from(item.data, 'base64')
    if (item.protected && !/^v1\d/.test(stored.subarray(0, 3).toString('latin1'))) throw new Error('the key is not encrypted by the OS')
    console.log(`   the key is ${item.protected ? 'encrypted by the OS' : 'stored without a keyring (no keyring here)'}`)
  })

  if (!packaged) {
    await check('closed to the tray: still connected, and new requests become notifications', async () => {
      await page.evaluate(() => (window as unknown as { afterhoursDesktop: { test: { closeWindow(): Promise<void> } } }).afterhoursDesktop.test.closeWindow())
      await until(async () => !(await state()).visible, 'the window to hide')
      askSamples(machine)
      const s = await until(async () => {
        const s = await state()
        return s.needsYou === 3 && s.notifications.length > 0 ? s : null
      }, 'a notification', 15_000)
      const n = s.notifications.at(-1)!
      if (n.title !== 'build-box' || n.route !== '/inbox') throw new Error(`notification: ${JSON.stringify(n)}`)
      if (s.tray.title !== '3' || !s.tray.tooltip.includes('3 need you')) throw new Error(`tray: ${JSON.stringify(s.tray)}`)
    })

    await check('clicking the notification opens Needs you; Allow reaches the machine', async () => {
      await page.evaluate(n => (window as unknown as { afterhoursDesktop: { test: { clickNotification(i: number): Promise<void> } } }).afterhoursDesktop.test.clickNotification(n), (await state()).notifications.length - 1)
      await until(async () => (await state()).visible, 'the window to show')
      await visible('request-perma')
      await shot('03-inbox')
      await tap('allow-perma')
      await until(() => sent(machine, 'answer', r => r.code === 'perma' && r.decision === 'allow'), 'the allow')
      await until(async () => (await state()).needsYou === 2, 'the count to drop')
    })

    await check('a link from a second launch hands over pairing with another machine', async () => {
      const second = fakeMachine({ relay: relay.url, name: 'second-box', sample: false })
      try {
        await Bun.sleep(300)
        const handover = launch([second.offer()])
        const code = await new Promise<number | null>(resolve => handover.on('exit', resolve))
        if (code !== 0) throw new Error(`the second launch exited with ${code}`)
        await see('Paired with second-box', 20_000)
        await shot('04-link')
      } finally {
        second.stop()
      }
    })
  }

  await check('the page can’t run injected code, fetch the web, or leave the app', async () => {
    mark = driver.errors().length
    // Code that arrives the way an attack would: script elements, inline and from a data: URL (code
    // sent over the debugging port bypasses the policy, so it can't stand in for that).
    const blocked = await page.evaluate(async () => {
      const w = window as unknown as Record<string, unknown>
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective))
      const inline = document.createElement('script')
      inline.textContent = 'window.__inline = true'
      document.head.appendChild(inline)
      const fromData = document.createElement('script')
      fromData.src = 'data:text/javascript,window.__fromData = eval("true")'
      document.head.appendChild(fromData)
      let fetched = true
      try {
        await fetch('https://example.com/')
      } catch {
        fetched = false
      }
      // An installed build really opens web links in the browser: there, use links it refuses.
      const away = (window as unknown as { afterhoursDesktop: { info: { test: boolean } } }).afterhoursDesktop.info.test ? 'https://example.com' : 'file:///etc'
      const opened = window.open(`${away}/window`) !== null
      await new Promise(resolve => setTimeout(resolve, 300))
      const policy = (await fetch('app://afterhours/')).headers.get('content-security-policy')
      return { ran: Boolean(w.__inline || w.__fromData), violations, fetched, opened, policy, away }
    })
    if (blocked.ran || blocked.violations.length < 2 || blocked.fetched || blocked.opened || !blocked.policy?.includes("script-src 'self'")) throw new Error(JSON.stringify(blocked))
    await page.evaluate(away => {
      location.href = `${away}/away`
    }, blocked.away)
    await Bun.sleep(500)
    if (!page.url().startsWith('app://afterhours/')) throw new Error(`navigated to ${page.url()}`)
    if (!packaged) {
      const external = (await state()).external
      if (!external.includes('https://example.com/away') || !external.includes('https://example.com/window')) throw new Error(`opened: ${external.join(', ')}`)
    }
  })

  if (!packaged) {
    await check('start at login, from Settings', async () => {
      await page.goto('app://afterhours/settings')
      await see('Start at login', 15_000)
      await see('Online')
      await tap('start-at-login')
      await until(async () => (await state()).loginItem, 'the login item')
      await shot('05-settings')
    })
  }

  if (lanAddress) {
    await check(`a relay on the local network (ws://${lanAddress})`, async () => {
      const lan = fakeMachine({ relay: `ws://${lanAddress}:${relay.port}/v1`, name: 'lan-box', sample: false })
      try {
        await Bun.sleep(500)
        await page.goto('app://afterhours/pair')
        await typeInto('pair-link', lan.offer())
        await tap('pair-go')
        await see('Paired with lan-box', 20_000)
        await tap('pair-open')
        await see('Online', 15_000)
      } finally {
        lan.stop()
      }
    })
  } else console.log('   (no local network address: the LAN relay step is skipped)')

  await check('light and dark', async () => {
    await page.goto('app://afterhours/')
    await see('build-box', 15_000)
    await shot('06-home')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await Bun.sleep(300)
    await shot('07-home-dark')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  })

  if (missing.length > 0) {
    failures++
    console.log(`✗ files the app couldn’t load:\n  ${missing.join('\n  ')}`)
  }

  // Page errors: none before the policy step; after it, only the ones it caused on purpose.
  const errors = driver.errors()
  const unexpected = [...errors.slice(0, mark), ...errors.slice(mark).filter(e => !/unsafe-eval|example\.com|file:\/\/\/etc|Content Security Policy/i.test(e))]
  if (unexpected.length > 0) {
    failures++
    console.log(`✗ errors in the page:\n  ${unexpected.join('\n  ')}`)
  }
} catch (err) {
  failures++
  console.log(`✗ ${err instanceof Error ? err.message : err}`)
} finally {
  await d?.browser.disconnect().catch(() => {})
  app.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 500))
  if (app.exitCode === null) app.kill('SIGKILL')
  machine.stop()
  await relay.stop()
  rmSync(userData, { recursive: true, force: true })
}

console.log(failures ? `\nFAILED (${failures})` : `\nAll passed. Screenshots: ${out}`)
process.exit(failures ? 1 : 0)
