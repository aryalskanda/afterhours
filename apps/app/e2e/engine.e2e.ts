// The web build against the real engine: a relay and a private Afterhours daemon (throwaway home,
// port, tmux socket and Claude Code config), and headless Chrome driving the app. It checks what
// the app shows of a real machine (its rules, defaults, folders, health and Claude Code), that the
// machine's rules hold for a task from the app, and devices: renaming this one, inviting another,
// removing a lost one, and being removed. No Claude task runs, so it costs nothing. `--keep` keeps
// the scratch folder.
//   npm run export:web && bun e2e/engine.e2e.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePairingLink } from '@afterhours/protocol'
import { startRelay } from '../../../relay/src/server'
import { Hub } from '../src/lib/hub'
import { drive, serveWeb, until } from './browser'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const PORT = Number(process.env.E2E_PORT ?? 7796)
const SOCKET = 'afterhours-e2e-app'
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), 'afterhours-e2e-app-'))
const home = join(root, 'home')
const projects = join(root, 'projects')
const outside = join(root, 'elsewhere')
for (const dir of [home, join(projects, 'shop'), join(projects, 'notes'), outside]) mkdirSync(dir, { recursive: true })
Bun.spawnSync(['git', 'init', '-q', join(projects, 'shop')])

const relay = startRelay({ port: 0, hostname: '127.0.0.1' })
// Claude Code's config as the engine reads it: an account, and an MCP server whose URL and key
// must never reach an app.
const claudeJson = join(root, 'claude.json')
writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'e2e@example.com' }, mcpServers: { tracker: { type: 'http', url: 'https://mcp.example.com/e2e', headers: { Authorization: 'Bearer e2e-not-a-real-key' } } } }))
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    port: PORT,
    imessage: { enabled: false, allowSms: false },
    telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
    keepAwake: false,
    isolate: false,
    folders: { roots: [root], maxDepth: 3 },
    defaults: { plan: false, review: false, execMode: 'acceptEdits', model: 'haiku', effort: 'low' },
    remote: { enabled: true, relay: relay.url, name: 'e2e-box', allowedRoots: [projects], allowBypass: false, allowScreens: true, allowTyping: true },
  }),
)
// Where the service writes the engine's output on a real install (launchd, systemd).
mkdirSync(join(home, 'logs'), { recursive: true })
const logFile = join(home, 'logs', 'cqd.log')
const daemon = Bun.spawn([process.execPath, join(repoRoot, 'src', 'cli', 'cq.ts'), 'daemon'], {
  env: { ...process.env, CQ_HOME: home, CQ_TMUX_SOCKET: SOCKET, CQ_PORT: String(PORT), CQ_CLAUDE_JSON: claudeJson },
  stdout: Bun.file(logFile),
  stderr: Bun.file(join(root, 'daemon.err')),
})
const daemonLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

async function local<T>(path: string, body?: unknown): Promise<T> {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

const out = join(import.meta.dir, 'out-engine')
const web = serveWeb()
const d = await drive(out)
const { page, tap, typeInto, replace, see, visible, gone, shot, check } = d
const base = `http://127.0.0.1:${web.port}`

try {
  await until(() => daemonLog().includes('listening on'), 'the daemon', 30_000)
  await until(() => daemonLog().includes('relay: connected'), 'the machine to reach the relay', 20_000)
  console.log(`scratch: ${root}`)

  await check('pairing the app with the real engine', async () => {
    const offer = await local<{ link?: string; error?: string }>('/api/remote/pair', { role: 'owner', yes: true })
    if (!offer.link) throw new Error(offer.error ?? 'no pairing link')
    await page.goto(base)
    await tap('pair-first')
    await typeInto('pair-link', offer.link)
    await tap('pair-go')
    await see('Paired with e2e-box', 20_000)
    await tap('pair-open')
    await see('Online', 15_000)
    await shot('01-machine')
    const devices = await local<{ name: string; role: string }[]>('/api/remote/devices')
    if (!devices.some(x => x.role === 'owner')) throw new Error(`the machine has ${JSON.stringify(devices)}`)
  })

  await check('the machine’s own rules show as such', async () => {
    // The machine lists its folders with links followed (macOS's temp folder is one).
    await see(realpathSync(projects))
    await see('Skip permission prompts')
    await see('Rules for apps')
  })

  await check('a new task starts from the machine’s defaults, and finds its folders', async () => {
    await tap('machine-new')
    await see('File edits go ahead; everything else asks you first.')
    await see('Claude starts on the work right away.')
    const picked = await page.evaluate(() =>
      ['new-model-haiku', 'new-effort-low'].map(id => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        return el?.getAttribute('aria-checked') ?? el?.getAttribute('aria-selected')
      }),
    )
    if (picked.some(x => x !== 'true')) throw new Error(`haiku and low aren't picked: ${JSON.stringify(picked)}`)
    await typeInto('folder-search', 'shop')
    await visible('folder-shop', 20_000)
    await shot('02-new')
  })

  await check('the machine refuses a folder outside its rules, and says why', async () => {
    await replace('folder-search', outside)
    await tap('folder-Use elsewhere')
    await typeInto('new-prompt', 'List the files here')
    await tap('new-submit')
    await see('is outside the folders this machine lets apps use')
    await shot('03-refused')
    const audit = await local<{ action: string; ok: boolean }[]>('/api/remote/audit')
    const queue = audit.find(e => e.action === 'queue')
    if (!queue || queue.ok) throw new Error(`the audit says ${JSON.stringify(queue)}`)
  })

  await check('the devices on the machine; renaming this one reaches it', async () => {
    await page.goto(`${base}/settings`)
    await page.waitForFunction(() => /\w{4}/.test(document.querySelector('[data-testid="fingerprint"]')?.textContent ?? ''))
    await see('Online', 15_000)
    await replace('device-name', 'E2E browser')
    await tap('save-name')
    await until(async () => (await local<{ name: string }[]>('/api/remote/devices')).some(x => x.name === 'E2E browser'), 'the new name on the machine')
    await tap('settings-machine-e2e-box')
    await tap('open-devices')
    await see('E2E browser (this device)')
    await shot('04-devices')
  })

  await check('the machine’s health and Claude Code; a CLAUDE.md written; usage; what devices did', async () => {
    await page.goto(base)
    await tap('machine-e2e-box')
    await tap('open-about')
    await visible('health')
    await see('Up for')
    await see('Disk')
    await visible('engine-log')
    await see('relay: connected')
    await see('e2e@example.com')
    await see('tracker')
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes('mcp.example.com') || text.includes('e2e-not-a-real-key')) throw new Error('an MCP server’s URL or key reached the app')
    await shot('05-about')
    await tap('open-instructions')
    const shop = realpathSync(join(projects, 'shop'))
    await typeInto('instructions-path', shop)
    await page.keyboard.press('Enter')
    await see('No CLAUDE.md in this folder yet.')
    await tap('instructions-edit')
    await typeInto('instructions-field', '# Shop\n\nRun the tests before you finish.\n')
    await tap('instructions-save')
    await see('Saved CLAUDE.md.')
    await until(() => existsSync(join(shop, 'CLAUDE.md')) && readFileSync(join(shop, 'CLAUDE.md'), 'utf8').includes('Run the tests before you finish.'), 'the file on the machine')
    await page.goto(base)
    await tap('machine-e2e-box')
    await tap('open-usage')
    await visible('usage-history')
    await page.goto(base)
    await tap('machine-e2e-box')
    await tap('open-audit')
    await see('Changed a CLAUDE.md')
    await see('Renamed a device')
    await shot('06-activity')
  })

  await check('an invite pairs another device; removing it as lost cuts it off', async () => {
    await page.goto(base)
    await tap('machine-e2e-box')
    await tap('open-devices')
    await tap('invite-role-viewer')
    await tap('invite-create')
    await visible('invite-qr')
    const link = await page.$eval('[data-testid="invite-link"]', el => el.textContent ?? '')
    parsePairingLink(link)
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
    if (paired.role !== 'viewer') throw new Error(`paired as ${paired.role}`)
    await until(async () => (await local<{ name: string; role: string }[]>('/api/remote/devices')).some(x => x.name === 'Lost phone' && x.role === 'viewer'), 'the new device on the machine')
    await visible('device-Lost phone', 15_000)
    await shot('07-invite')
    await page.goto(`${base}/settings`)
    await tap('settings-lost')
    await tap('lost-remove-Lost phone')
    await tap('lost-remove-Lost phone')
    await see('Removed Lost phone from e2e-box.')
    await until(async () => !(await local<{ name: string }[]>('/api/remote/devices')).some(x => x.name === 'Lost phone'), 'the device gone from the machine')
    await gone('lost-Lost phone')
  })

  await check('a problem report lands in the machine’s app-reports log', async () => {
    await page.goto(`${base}/settings`)
    await tap('settings-report')
    await typeInto('report-text', 'Checking that reports reach the owner.')
    await tap('report-send')
    await see('app-reports log')
    const reports = join(home, 'logs', 'app-reports.log')
    await until(() => existsSync(reports) && readFileSync(reports, 'utf8').includes('Checking that reports reach the owner.'), 'the report in the log')
    if (!readFileSync(reports, 'utf8').includes('· E2E browser · afterhours-app/')) throw new Error('the report doesn’t say which device sent it')
  })

  await check('removed on the machine (cq devices remove), the app says so', async () => {
    await local('/api/remote/devices/remove', { device: 'E2E browser' })
    await page.goto(base)
    await see('Removed this device', 20_000)
    await shot('05-removed')
  })

  if (d.errors().length > 0) console.log(`✗ errors in the page:\n  ${d.errors().join('\n  ')}`)
} catch {
  // Reported above.
} finally {
  await d.browser.close()
  web.stop(true)
  daemon.kill()
  await daemon.exited
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
  await relay.stop()
  if (!keep) rmSync(root, { recursive: true, force: true })
}

console.log(d.failed() ? '\nFAILED' : `\nAll passed. Screenshots: ${out}`)
process.exit(d.failed() ? 1 : 0)
