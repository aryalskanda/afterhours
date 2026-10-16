// The web build, end to end: headless Chrome drives the exported app, which talks to a scripted
// machine (a real protocol Host) through a real relay. Every step checks what the machine
// received, not just what the screen shows. Screenshots land in e2e/out/.
//   npm run export:web && bun e2e/web.e2e.ts

import { describeAnswers, parsePairingLink, type QuestionAnswer, type Request } from '@afterhours/protocol'
import { join } from 'node:path'
import { startRelay } from '../../../relay/src/server'
import { Hub } from '../src/lib/hub'
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
    // What it does, in words.
    await see('Runs the tests')
    await shot('06-inbox')
  })

  await check('allowing a permission; an answer that fails can be sent again', async () => {
    await see('You allowed this 14 times before.')
    await see('Always allow commands starting with npm test in this project')
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
    await tap('previous-revie')
    await see('Add a dark stylesheet')
    await tap('plan-mode-revie-auto')
    await tap('approve-revie')
    await until(() => sent('answer', r => r.code === 'revie' && r.decision === 'allow' && r.mode === 'auto'), 'the approval, in auto mode')
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

  await check('steering: a message to the running task, an edit, a rule, a quoted step, a branch merged', async () => {
    await page.goto(`${base}/machine/${m.id}/task/14`)
    await see('I’ll look at how the settings page is built first.')
    await typeInto('task-message', 'Also add a test')
    await tap('task-message-send')
    await until(() => sent('say', r => r.text === 'Also add a test' && r.job === 14), 'the message')
    await see('Claude reads it when its current step ends')
    await shot('12b-message')

    await page.goto(`${base}/machine/${m.id}/task/15`)
    await see('It starts when it’s its turn.')
    await tap('task-edit')
    await d.replace('task-edit-prompt', 'Fix the flaky checkout test, and the one in cart')
    await tap('task-edit-model-opus')
    await tap('task-edit-save')
    await until(() => sent('job', r => r.action === 'edit' && r.prompt === 'Fix the flaky checkout test, and the one in cart' && r.options?.model === 'opus'), 'the edit')

    // A permission allowed with Claude Code's own rule.
    m.ask(
      { code: 'permb', job: 14, kind: 'permission', tool: 'Bash', detail: 'npm test', payload: null, createdAt: Date.now(), expiresAt: Date.now() + 900_000, suggestions: [{ label: 'Always allow commands starting with npm test in this project' }] },
      { type: 'permission', job: m.state.active!, code: 'permb', tool: 'Bash', detail: 'npm test', minutes: 15, suggestions: ['Always allow commands starting with npm test in this project'] },
      '🔐 #14 wants to use Bash',
    )
    // A plan to change: a tapped step is quoted.
    m.ask(
      { code: 'reviq', job: 15, kind: 'review', plan: '1. Rewrite the checkout\n2. Ship it', payload: null, createdAt: Date.now() },
      { type: 'plan_review', job: m.state.queued.find(j => j.id === 15)!, code: 'reviq', plan: '1. Rewrite the checkout\n2. Ship it' },
      '📝 #15 plan ready for your review',
    )
    await page.goto(`${base}/inbox`)
    await tap('rule-permb-0')
    await until(() => sent('answer', r => r.code === 'permb' && r.decision === 'allow' && r.rule === 0), 'the rule')
    await tap('quote-0')
    await tap('send-changes-reviq')
    await until(() => sent('answer', r => r.code === 'reviq' && r.decision === 'deny' && (r.text ?? '').startsWith('> Rewrite the checkout')), 'the quoted change')

    await page.goto(`${base}/machine/${m.id}/task/12`)
    await see('afterhours/12-csv-export')
    await tap('branch-merge')
    await see('Tap again to merge')
    await tap('branch-merge')
    await until(() => sent('branch', r => r.job === 12 && r.action === 'merge'), 'the merge')
    await see('Merged afterhours/12-csv-export into main.')
    await tap('task-open')
    await until(() => sent('open', r => r.job === 12), 'open on the computer')
    await shot('12c-branch')
  })

  await check('a task for later, every day, with a time limit; the machine’s commands', async () => {
    await page.goto(`${base}/new?machine=${m.id}`)
    // The folder it used last time on this machine is already picked.
    await see('~/code/shop/web')
    await typeInto('new-prompt', 'Run the nightly checks')
    await tap('new-when-time')
    await typeInto('new-at', '2:30 am')
    await see('At ')
    await tap('new-daily')
    await see('Every day at 2:30 AM')
    await tap('new-limit-30')
    await shot('12d-later')
    await tap('new-submit')
    await until(() => sent('queue', r => r.prompt === 'Run the nightly checks' && r.options?.repeatDaily === 150 && r.options?.maxMinutes === 30), 'the scheduled task')

    await page.goto(`${base}/machine/${m.id}/console`)
    await see('Commands: status')
    await typeInto('console-input', 'status')
    await tap('console-send')
    await see('Did status.')
  })

  await check('prompts: a recent one, / and @ suggestions, a file attached, tried three ways', async () => {
    await page.goto(`${base}/new?machine=${m.id}`)
    await see('Saved and recent')
    await tap('recent-0')
    await d.replace('new-prompt', '/rev')
    await tap('suggest-/review')
    await typeInto('new-prompt', 'the checkout in @appear')
    await tap('suggest-@src/settings/Appearance.tsx')
    await tap('new-save-prompt')
    const file = join(out, 'crash.log')
    await Bun.write(file, 'TypeError: cannot read properties of undefined\n  at Checkout (checkout.tsx:42)\n')
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), tap('attach-file')])
    await chooser.accept([file])
    await see('crash.log')
    await tap('new-three')
    await see('Opus, Sonnet, Haiku')
    await shot('12e-prompt')
    await tap('new-submit')
    await until(() => sent('upload', r => r.name === 'crash.log' && atob(r.data).startsWith('TypeError')), 'the upload')
    const queued = () => m.requests.filter((r): r is Extract<Request, { type: 'queue' }> => r.type === 'queue' && r.prompt === '/review the checkout in @src/settings/Appearance.tsx')
    await until(() => queued().length === 3, 'three tasks')
    const [a, b, c] = queued()
    if (new Set([a!.options?.model, b!.options?.model, c!.options?.model]).size !== 3) throw new Error('not three models')
    if (!a!.options?.group || a!.options.group !== c!.options?.group || !a!.options.attachments?.[0]?.endsWith('crash.log')) throw new Error(`sent ${JSON.stringify(a!.options)}`)
    await see('to compare')
    await tap('new-compare')
    await see('Compare')
    await see('Opus')
    await shot('12f-compare')
  })

  await check('a comment on a diff line goes back as a follow-up; an answer read aloud', async () => {
    await page.goto(`${base}/machine/${m.id}/task/12`)
    await tap('read-answer')
    await see('Stop')
    await tap('read-answer')
    await see('Read aloud')
    await tap('task-view-changes')
    await tap('change-src/settings/index.tsx')
    await see("import { Appearance } from './Appearance'")
    await tap('line-2')
    await typeInto('comment-2', 'Import it next to Group')
    await tap('send-comments')
    await until(
      () => sent('queue', r => r.options?.session === '3f0c2a9e-0000-4000-8000-000000000012' && r.prompt.includes('About your changes in src/settings/index.tsx') && r.prompt.includes('Import it next to Group')),
      'the follow-up',
    )
    await see('in the same conversation')
    await shot('12g-comment')
  })

  await check('history: all tasks, older pages, a filter, words; search across machines', async () => {
    await page.goto(base)
    await tap('machine-build-box')
    await tap('open-all-tasks')
    await see('Add CSV export to reports')
    // A page at a time (this machine answers eight), then the older ones.
    await tap('tasks-more')
    await see('Set up the project')
    if (!sent('jobs', r => r.before === 5)) throw new Error('the second page wasn’t asked from #5 back')
    await tap('tasks-status-failed')
    await see('Fix the 50% off coupon bug')
    await gone('job-12')
    await tap('tasks-status-all')
    await typeInto('tasks-search', 'appearance')
    // Words in Claude's answers find them: neither prompt says it.
    await until(() => sent('jobs', r => r.query === 'appearance'), 'the search')
    await gone('job-11')
    await visible('job-12')
    await visible('job-9')
    await shot('18-all-tasks')
    await page.goto(base)
    await tap('header-search')
    await typeInto('search-field', 'checkout')
    await see('Refactor the checkout')
    await until(() => sent('chats', r => r.query === 'checkout'), 'the chats search')
    await shot('19-search')
  })

  await check('the machine: health and Claude Code, CLAUDE.md edited, usage and its forecast, what devices did', async () => {
    await page.goto(base)
    await tap('machine-build-box')
    await tap('open-about')
    await see('112 GB free of 466 GB')
    await see('2.1.301')
    await see('github')
    await see('me@example.com')
    await see('#14: started')
    await shot('20-about')
    await tap('restart')
    await see('Tap again to restart')
    if (sent('restart')) throw new Error('restarted on the first tap')
    await tap('restart')
    await until(() => sent('restart'), 'the restart')
    await see('Restarting Afterhours on build-box')
    await tap('open-instructions')
    await see('Use pnpm, not npm.')
    await tap('instructions-edit')
    await replace('instructions-field', '# Shop web\n\n- Use pnpm.\n- Ask before adding a dependency.\n')
    await tap('instructions-save')
    await until(() => sent('claude.md', r => r.folder === '/home/me/code/shop/web' && r.text.includes('Ask before adding a dependency.')), 'the new CLAUDE.md')
    await see('Saved CLAUDE.md.')
    await see('Ask before adding a dependency.')
    await shot('21-claude-md')
    await page.goto(base)
    await tap('machine-build-box')
    await tap('open-usage')
    // 30 points in the last hour, 62% used, the reset 90 minutes away: it runs out first.
    await see('At this rate you reach it at')
    await visible('usage-chart')
    await shot('22-usage')
    await tap('usage-window-sevenDay')
    await see('At this rate it lasts until it resets')
    await tap('hold-until-reset')
    await until(() => sent('job', r => r.action === 'edit' && r.job === 15 && r.options?.atReset === true), 'the hold')
    await see('wait until')
    await page.goto(base)
    await tap('machine-build-box')
    await tap('open-audit')
    await see('Queued a task')
    await see('Restarted Afterhours')
    await shot('23-activity')
  })

  await check('a risky command says why; a device invited by QR code pairs; a lost device removed everywhere', async () => {
    const active = m.state.active!
    const risky = 'rm -rf build && git push --force origin main'
    m.ask(
      { code: 'perm3', job: active.id, kind: 'permission', tool: 'Bash', detail: risky, payload: null, createdAt: Date.now(), expiresAt: Date.now() + 900_000 },
      { type: 'permission', job: active, code: 'perm3', tool: 'Bash', detail: risky, minutes: 15 },
      `🔐 #${active.id} wants to use Bash`,
    )
    await page.goto(`${base}/inbox`)
    await visible('risk-perm3')
    await see('Deletes files and folders, recursively')
    await see('Rewrites history on the remote (force push)')
    await shot('24-risk')
    await tap('deny-perm3')
    await until(() => sent('answer', r => r.code === 'perm3' && r.decision === 'deny'), 'the deny')
    await page.goto(base)
    await tap('machine-build-box')
    await tap('open-devices')
    await tap('invite-role-operator')
    await tap('invite-create')
    await visible('invite-qr')
    const link = await page.$eval('[data-testid="invite-link"]', el => el.textContent ?? '')
    if (parsePairingLink(link).machine !== m.id) throw new Error(`not a pairing link for build-box: ${link}`)
    await shot('25-invite')
    // Another phone pairs with that link.
    const store = new Map<string, string>()
    const phone = new Hub({
      storage: { getSecret: async k => store.get(k) ?? null, setSecret: async (k, v) => void store.set(k, v), get: async k => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      defaultName: 'Lost phone',
      platform: 'test',
      app: 'afterhours-e2e/0',
    })
    await phone.init()
    const paired = await phone.pair(link)
    phone.close()
    if (paired.role !== 'operator') throw new Error(`paired as ${paired.role}`)
    // It shows up while the invite is open.
    await visible('device-Another device', 15_000)
    await tap('invite-done')
    await page.goto(`${base}/settings`)
    await tap('settings-lost')
    await visible('lost-Another device')
    await tap('lost-remove-Another device')
    await see('Tap again to remove')
    await tap('lost-remove-Another device')
    await until(() => sent('devices.remove', r => r.device !== m.devices()[0]), 'the removal')
    await see('Removed Another device from build-box.')
    await shot('26-lost-device')
  })

  await check('a queued task moves to another machine; a new one goes to any free machine', async () => {
    const m2 = fakeMachine({ relay: relay.url, name: 'laptop', sample: false })
    try {
      await page.goto(`${base}/pair`)
      await typeInto('pair-link', m2.offer('operator'))
      await tap('pair-go')
      await see('Paired with laptop')
      await page.goto(base)
      await see('Running now')
      const last = m.state.queued.at(-1)!
      if (last.id === 15 || last.id === 21) throw new Error(`#${last.id} is needed later`)
      await tap('machine-build-box')
      await tap(`job-${last.id}`)
      await tap('task-move')
      await see(`Move #${last.id} from build-box to`)
      await tap('new-submit')
      await until(() => m2.requests.find(r => r.type === 'queue' && r.prompt === last.prompt.trim() && r.folder === last.folder), 'the task on laptop')
      await until(() => sent('job', r => r.action === 'remove' && r.job === last.id), 'the task off build-box')
      await see('Moved to laptop as #21.')
      await shot('27-moved')
      await page.goto(`${base}/new`)
      await tap('new-machine-free')
      // build-box is running a task: laptop is the free one.
      await tap('folder-web')
      await typeInto('new-prompt', 'Try the free machine')
      await tap('new-submit')
      await until(() => m2.requests.find(r => r.type === 'queue' && r.prompt === 'Try the free machine'), 'the task on the free machine')
      await page.goto(base)
      await tap('machine-laptop')
      await tap('forget')
      await tap('forget')
      await until(async () => !(await page.evaluate(() => localStorage.getItem('afterhours.machines') ?? '')).includes(m2.id), 'laptop forgotten')
      await until(() => m2.requests.find(r => r.type === 'devices.remove'), 'laptop told to forget this device')
      await visible('home')
      await gone('machine-laptop')
    } finally {
      m2.stop()
    }
  })

  await check('after a reload the machine is still paired and comes back online; what finished while you were away', async () => {
    // As if the app was last left two hours ago (#12 finished 90 minutes ago).
    const left = await page.evaluateOnNewDocument(() => localStorage.setItem('afterhours.leftAt', String(Date.now() - 2 * 3_600_000)))
    await page.goto(base)
    await page.removeScriptToEvaluateOnNewDocument(left.identifier)
    await see('build-box')
    await see('Working')
    await visible('away')
    await see('1 done since')
    await shot('13-home')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await Bun.sleep(300)
    await shot('14-home-dark')
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await tap('away-clear')
    await gone('away')
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
    if (sent('job', r => r.action === 'remove' && r.job === 15)) throw new Error('removed on the first tap')
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
