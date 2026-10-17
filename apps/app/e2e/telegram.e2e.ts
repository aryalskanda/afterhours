// The app inside Telegram, end to end: the relay serves the exported app (as a machine running its
// own relay does, behind Tailscale Funnel), headless Chrome opens it with Telegram's launch data and
// a stand-in for Telegram.WebApp, and it pairs with a scripted machine that checks the launch data
// the way the engine does. Screenshots land in e2e/out-telegram/.
//   npm run export:web && bun e2e/telegram.e2e.ts

import type { Hello } from '@afterhours/protocol'
import { join } from 'node:path'
import { startRelay } from '../../../relay/src/server'
import { checkInitData, signInitData } from '../../../src/telegram/webapp'
import { drive, until } from './browser'
import { askSamples, fakeMachine } from './fake-machine'
import { installTelegram, launchHash, telegramCalls } from './telegram-stub'

const TOKEN = '123456:e2e-bot-token'
const OWNER = 7001
const BOT = 'afterhours_test_bot'

const out = join(import.meta.dir, 'out-telegram')
const relay = startRelay({ port: 0, hostname: '127.0.0.1', appDir: join(import.meta.dir, '..', 'dist-web') })
const m = fakeMachine({ relay: relay.url })
const hellos: Hello[] = []
const verify = (hello: Hello) => {
  hellos.push(hello)
  return checkInitData(hello.telegram, { token: TOKEN, ownerId: OWNER, now: Date.now() }).ok
}
const d = await drive(out)
const { page, tap, see, visible, gone, shot, check } = d
const base = `http://127.0.0.1:${relay.port}`

const initData = signInitData({ query_id: 'AAE', user: JSON.stringify({ id: OWNER, first_name: 'Skanda' }), auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN)
const hash = launchHash(initData)

const calls = () => telegramCalls(page)
await installTelegram(page)

const backState = () => page.evaluate(() => (window as unknown as { __tg: { back: { visible: boolean; cb: unknown } } }).__tg.back.visible)
const pressBack = () => page.evaluate(() => (window as unknown as { __tg: { back: { cb: (() => void) | null } } }).__tg.back.cb?.())

try {
  await Bun.sleep(300)

  await check('the relay serves the app, with its rules for pages', async () => {
    const res = await fetch(`${base}/machine/anything`)
    if (!(await res.text()).includes('<div id="root">')) throw new Error('not the app')
    if (!res.headers.get('content-security-policy')?.includes('https://telegram.org')) throw new Error('no CSP')
  })

  await check('opened from the menu button before pairing: Telegram’s frame, its dark, and Set up goes to the bot', async () => {
    await page.goto(`${base}/?bot=${BOT}${hash}`)
    await visible('welcome')
    await see('Set up pairs this with your Mac')
    await until(async () => (await calls()).includes('header:#0e1320'), 'the header in the page’s dark')
    const c = await calls()
    for (const want of ['ready', 'expand', 'noSwipes']) if (!c.includes(want)) throw new Error(`never called ${want}`)
    await shot('01-welcome')
    await tap('telegram-setup')
    await until(async () => (await calls()).includes(`telegram:https://t.me/${BOT}?start=app`), 'the bot opened with /start app')
  })

  await check('Finish setup: the bot’s link pairs, and the machine gets Telegram’s proof', async () => {
    const link = m.offerChecked(verify)
    await page.goto(`${base}/pair?${link.slice(link.indexOf('?') + 1)}&bot=${BOT}${hash}`)
    await see('Paired with build-box')
    await shot('02-paired')
    const hello = hellos.at(-1)!
    if (hello.telegram !== initData) throw new Error('the launch data never reached the machine')
    if (hello.platform !== 'telegram-ios' || hello.name !== 'Telegram on iPhone') throw new Error(`seen as ${hello.name} (${hello.platform})`)
    const key = await page.evaluate(() => (window as unknown as { Telegram: { WebApp: { SecureStorage: { data: Map<string, string> } } } }).Telegram.WebApp.SecureStorage.data.has('afterhours.identity'))
    if (!key) throw new Error("the key isn't in Telegram's secure storage")
  })

  await check('Telegram’s Back button goes back; the app shows no back arrows of its own', async () => {
    await tap('pair-open')
    await see('Online')
    await tap('job-12')
    await see('Add CSV export to reports')
    await until(backState, 'the Back button shown')
    const arrows = await page.evaluate(() => [...document.querySelectorAll('[aria-label$=", back"], [aria-label="Go back"]')].filter(el => el.getClientRects().length > 0).length)
    if (arrows > 0) throw new Error(`${arrows} back arrows on the page`)
    await shot('03-task')
    await pressBack()
    await visible('job-12')
  })

  await check('a link from the bot opens the task on its answer', async () => {
    // Telegram opens each link fresh; the launch data stays with the tab.
    await page.goto(`${base}/machine/${m.id}/task/12?view=answer`)
    await visible('task-answer')
    await until(
      () => page.evaluate(() => [...document.querySelectorAll('[data-testid="task-view"]')].some(el => (r => r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight)(el.getBoundingClientRect()))),
      'scrolled to the answer',
    )
    await shot('04-answer')
  })

  await check('Allow from the inbox is felt', async () => {
    askSamples(m)
    await page.goto(`${base}/inbox`)
    await tap('allow-perma')
    await gone('allow-perma')
    await until(async () => (await calls()).includes('haptic:success'), 'a success haptic')
  })

  await check('a prompt from the bot opens in New task to change; closing asks first', async () => {
    await page.goto(`${base}/new?machine=${m.id}&prompt=${encodeURIComponent('Fix the login page')}`)
    const field = await visible('new-prompt')
    const value = await field.evaluate(el => (el as HTMLTextAreaElement).value)
    if (value !== 'Fix the login page') throw new Error(`the prompt is "${value}"`)
    await until(async () => (await calls()).includes('confirmClose:on'), 'closing confirmation on')
    await shot('05-new')
  })

  await check('Notifications says the bot does it', async () => {
    await page.goto(`${base}/notifications`)
    await visible('notify-telegram')
    await see('Your bot messages you')
  })

  if (d.errors().length > 0) console.log(`✗ errors in the page:\n  ${d.errors().join('\n  ')}`)
} catch {
  // Reported above.
} finally {
  await d.browser.close()
  m.stop()
  await relay.stop()
}

console.log(d.failed() ? '\nFAILED' : `\nAll passed. Screenshots: ${out}`)
process.exit(d.failed() ? 1 : 0)
