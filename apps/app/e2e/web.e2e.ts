// The web build, end to end: headless Chrome drives the exported app, which talks to a scripted
// machine (a real protocol Host) through a real relay. Every step checks what the machine
// received, not just what the screen shows. Screenshots land in e2e/out/.
//   npm run export:web && bun e2e/web.e2e.ts

import { describeAnswers, type QuestionAnswer, type Request } from '@afterhours/protocol'
import { join } from 'node:path'
import { startRelay } from '../../../relay/src/server'
import { drive, serveWeb, until } from './browser'
import { askSamples, fakeMachine } from './fake-machine'

const out = join(import.meta.dir, 'out')
const web = serveWeb()
const relay = startRelay({ port: 0, hostname: '127.0.0.1' })
const m = fakeMachine({ relay: relay.url })
const d = await drive(out)
const { page, tap, typeInto, replace, see, gone, visible, shot, check } = d
const base = `http://127.0.0.1:${web.port}`

const sent = <T extends Request['type']>(type: T, match: (r: Extract<Request, { type: T }>) => boolean = () => true) =>
  m.requests.find((r): r is Extract<Request, { type: T }> => r.type === type && match(r as Extract<Request, { type: T }>))

try {
  await Bun.sleep(300)

  await check('a new device shows how to pair', async () => {
    await page.goto(base)
    await see('No machines yet')
    await see('cq pair')
    await shot('01-welcome')
  })

  await check('pairing by pasting the link, then the machine is online', async () => {
    await tap('pair-first')
    await see('Paste the link')
    await typeInto('pair-link', m.offer())
    await shot('02-pair')
    await tap('pair-go')
    await see('Paired with build-box')
    await see('As an owner')
    await shot('03-paired')
    await tap('pair-open')
    await see('Online')
    await see('Add a dark mode toggle')
    await until(() => sent('sync'), 'a sync')
    await shot('04-machine')
  })

  await check('requests arrive live: the badge, the banner and the cards', async () => {
    askSamples(m)
    // The banner shows the newest: the plan.
    await visible('attention')
    await see('#15 plan ready for your review')
    await shot('05-banner')
    await tap('attention')
    await visible('request-perma')
    await see('npm test -- --watch=false')
    await shot('06-inbox')
  })

  await check('allowing a permission; an answer that fails can be sent again', async () => {
    m.failAnswers(1)
    await tap('allow-perma')
    await see('the queue is busy')
    await tap('allow-perma')
    await until(() => m.requests.filter(r => r.type === 'answer' && r.code === 'perma' && r.decision === 'allow').length === 2, 'the second allow')
    await gone('request-perma')
    await see('Just answered')
  })

  await check('three questions, one at a time: a pick, several ticks, a typed answer', async () => {
    const questions = m.state.approvals.find(a => a.code === 'quest')!.questions!
    await see('How should the engine run on Windows?')
    await see('The Linux build runs inside WSL2 unchanged')
    await shot('07-question')
    await tap('option-quest-0-0')
    await see('2 of 3')
    await tap('option-quest-1-0')
    await tap('option-quest-1-2')
    await see('Done (2)')
    await tap('done-quest')
    await see('3 of 3')
    await tap('type-quest')
    await typeInto('typed-quest', 'Call it relay')
    await tap('send-typed-quest')
    const answers: QuestionAnswer[] = [{ picks: [0] }, { picks: [0, 2] }, { text: 'Call it relay' }]
    const answer = await until(() => sent('answer', r => r.code === 'quest'), 'the answers')
    if (answer.decision !== 'answer' || answer.text !== describeAnswers(questions, answers)) throw new Error(`wrong answer: ${JSON.stringify(answer)}`)
    await gone('request-quest')
  })

  await check('reviewing a plan, rendered, and approving it', async () => {
    await see('Review the plan')
    await see('src/settings/Appearance.tsx')
    await shot('08-review')
    await tap('approve-revie')
    await until(() => sent('answer', r => r.code === 'revie' && r.decision === 'allow'), 'the approval')
    await gone('request-revie')
    await see('Nothing needs you')
  })

  await check('a new task goes to the machine exactly as chosen', async () => {
    // The Machines tab keeps its place (the machine), as tabs do on a phone.
    await tap('tab-machines')
    await tap('machine-new')
    await tap('folder-web')
    await typeInto('new-prompt', 'Add a CSV export to the orders page')
    await tap('new-how-none')
    await tap('new-mode-acceptEdits')
    await tap('new-model-opus')
    await tap('new-effort-max')
    await see('doesn’t allow No prompts')
    await shot('09-new')
    await tap('new-submit')
    await see('Queued #21.')
    const q = await until(() => sent('queue'), 'the task')
    const want = { folder: '/home/me/code/shop/web', prompt: 'Add a CSV export to the orders page', options: { plan: false, review: false, mode: 'acceptEdits', model: 'opus', effort: 'max', isolate: true, front: false } }
    const got = { folder: q.folder, prompt: q.prompt, options: q.options }
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`sent ${JSON.stringify(got)}`)
    await tap('new-open')
    await see('Add a CSV export to the orders page')
  })

  await check('a finished task: its answer and plan, rendered', async () => {
    // Back from the new task: its machine, with its recent tasks.
    await d.back()
    await tap('job-12')
    await see('Claude’s answer')
    await see('The toggle is in')
    await see("export type Theme = 'light' | 'dark' | 'system'")
    await shot('10-task')
    await until(() => sent('task', r => r.job === 12), 'the task request')
  })

  await check('the running task’s screen, and pressing a key', async () => {
    await d.back()
    await tap('open-screen')
    await see('Editing src/theme.ts')
    await until(() => sent('peek', r => r.ansi === true), 'colours asked for')
    await typeInto('screen-find', 'theme')
    await see('1 found')
    await tap('screen-bigger')
    await tap('key-Escape')
    await until(() => sent('keys', r => r.keys.join() === 'Escape' && r.job === 14), 'the key')
    await shot('11-screen')
  })

  await check('a running task: what Claude did and is doing, and the files it changed', async () => {
    await page.goto(`${base}/machine/${m.id}/task/14`)
    await see('I’ll look at how the settings page is built first.')
    await see('npm test -- --watch=false')
    await see('38% used')
    await tap('tool-3')
    await see('src/app.tsx')
    m.activity({ job: 14, at: Date.now(), phase: 'start', tool: 'Bash', detail: 'npm run lint' })
    await see('npm run lint')
    await until(() => sent('transcript', r => r.job === 14), 'the transcript request')
    await shot('10b-activity')
    await tap('task-view-changes')
    await see('Appearance.tsx')
    await see('src/settings')
    await tap('change-src/settings/index.tsx')
    await see("import { Appearance } from './Appearance'")
    await shot('10c-diff')
    await tap('diff-whole-file')
    await see('export function Settings()')
    await until(() => sent('files', r => r.read === true && r.path === 'src/settings/index.tsx' && r.job === 14), 'the file request')
  })

  await check('chats: the list, one chat rendered, writing into it', async () => {
    await page.goto(`${base}/chats`)
    await see('Refactor the checkout')
    await tap('chat-3f0c2a9e')
    await see('price lookup')
    await see('src/checkout.ts')
    await until(() => sent('transcript', r => r.session === '3f0c2a9e-0000-4000-8000-000000000001'), 'the conversation request')
    await typeInto('chat-text', 'Also cache the result')
    await tap('chat-send')
    await until(() => sent('chat.write', r => r.text === 'Also cache the result'), 'the message')
    await shot('12-chat')
  })

  await check('after a reload the machine is still paired and comes back online', async () => {
    await page.goto(base)
    await see('build-box')
    await see('Working')
    await shot('13-home')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await Bun.sleep(300)
    await shot('14-home-dark')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  })

  await check('the queue: run one next, remove another (asking once more first)', async () => {
    await tap('machine-build-box')
    await shot('15-queue')
    await tap('job-21')
    await tap('task-top')
    await until(() => sent('job', r => r.action === 'top' && r.job === 21), 'the run-next')
    await d.back()
    await tap('job-15')
    await tap('task-remove')
    await see('Tap again to remove')
    if (sent('job', r => r.action === 'remove')) throw new Error('removed on the first tap')
    await tap('task-remove')
    await until(() => sent('job', r => r.action === 'remove' && r.job === 15), 'the removal')
    await visible('task-prompt')
  })

  await check('settings show this device’s key; a new name reaches the machine', async () => {
    await page.goto(`${base}/settings`)
    // Ready once the key is loaded: its fingerprint shows.
    await page.waitForFunction((s: string) => /\w{4}/.test(document.querySelector(s)?.textContent ?? ''), {}, '[data-testid="fingerprint"]')
    await see('Online')
    await replace('device-name', 'Test browser')
    await tap('save-name')
    await until(() => sent('devices.rename', r => r.name === 'Test browser'), 'the new name')
    await shot('16-settings')
  })

  await check('browser notifications: switched on in Settings; a request while the tab is hidden shows one', async () => {
    await d.browser.defaultBrowserContext().overridePermissions(base, ['notifications'])
    await tap('browser-notifications')
    await until(async () => (await page.evaluate(() => localStorage.getItem('afterhours.prefs')))?.includes('"browserNotifications":true'), 'the setting')
    // A hidden tab, and a record of the notifications it shows.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      const w = window as unknown as { shown: string[]; Notification: typeof Notification }
      w.shown = []
      const Real = w.Notification
      w.Notification = class extends Real {
        constructor(title: string, options?: NotificationOptions) {
          super(title, options)
          w.shown.push(`${title}: ${options?.body ?? ''}`)
        }
      } as typeof Notification
    })
    const active = m.state.active!
    m.ask(
      { code: 'perm2', job: active.id, kind: 'permission', tool: 'Edit', detail: 'src/theme.ts', payload: null, createdAt: Date.now(), expiresAt: Date.now() + 900_000 },
      { type: 'permission', job: active, code: 'perm2', tool: 'Edit', detail: 'src/theme.ts', minutes: 15 },
      `🔐 #${active.id} wants to use Edit`,
    )
    const shown = await until(async () => {
      const list = await page.evaluate(() => (window as unknown as { shown: string[] }).shown)
      return list.length > 0 ? list : null
    }, 'a notification')
    if (shown[0] !== `build-box: #${active.id} wants to use Edit`) throw new Error(`showed ${JSON.stringify(shown)}`)
  })

  await check('a device the machine removed says so', async () => {
    m.removeDevice(m.devices()[0]!)
    await page.goto(base)
    await see('Removed this device', 15_000)
    await shot('17-removed')
  })

  if (d.errors().length > 0) console.log(`✗ errors in the page:\n  ${d.errors().join('\n  ')}`)
} catch {
  // Reported above.
} finally {
  await d.browser.close()
  m.stop()
  await relay.stop()
  web.stop(true)
}

console.log(d.failed() ? '\nFAILED' : `\nAll passed. Screenshots: ${out}`)
process.exit(d.failed() ? 1 : 0)
