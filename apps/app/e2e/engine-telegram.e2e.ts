// The app inside Telegram against the real engine: a private Afterhours daemon (throwaway home,
// ports and tmux socket) that runs the relay itself and serves the app from it, as `cq app setup`
// sets it up. Headless Chrome opens the app from the engine's own address, with Telegram's launch
// data and a stand-in for Telegram, pairs, and sees the machine. Nothing runs; it costs nothing.
// (Tailscale Funnel only puts a public address in front; the bot's own part is in test/telegram.)
//   npm run export:web && bun e2e/engine-telegram.e2e.ts

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drive, until } from './browser'
import { installTelegram, launchHash } from './telegram-stub'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const PORT = Number(process.env.E2E_PORT ?? 7797)
const RELAY_PORT = PORT + 1
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), 'afterhours-e2e-tg-'))
const home = join(root, 'home')
const projects = join(root, 'projects')
for (const dir of [home, join(projects, 'shop')]) mkdirSync(dir, { recursive: true })
// What `cq app setup` copies: the app's web build, where the engine's relay serves it.
cpSync(join(import.meta.dir, '..', 'dist-web'), join(home, 'web'), { recursive: true })
const local = `127.0.0.1:${RELAY_PORT}`
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    port: PORT,
    imessage: { enabled: false, allowSms: false },
    telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
    keepAwake: false,
    folders: { roots: [root], maxDepth: 3 },
    // Through Tailscale these are https:// and wss://; here the engine's own address stands in.
    remote: { enabled: true, relay: `ws://${local}/v1`, name: 'e2e-tg-box', allowedRoots: [projects], serve: { port: RELAY_PORT }, publicUrl: `http://${local}` },
  }),
)
mkdirSync(join(home, 'logs'), { recursive: true })
const logFile = join(home, 'logs', 'cqd.log')
const daemon = Bun.spawn([process.execPath, join(repoRoot, 'src', 'cli', 'cq.ts'), 'daemon'], {
  env: { ...process.env, CQ_HOME: home, CQ_TMUX_SOCKET: 'afterhours-e2e-tg', CQ_PORT: String(PORT), CQ_CLAUDE_JSON: join(root, 'claude.json') },
  stdout: Bun.file(logFile),
  stderr: Bun.file(join(root, 'daemon.err')),
})
const daemonLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

async function api<T>(path: string, body?: unknown): Promise<T> {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

const out = join(import.meta.dir, 'out-engine-telegram')
const d = await drive(out)
const { page, tap, see, shot, check } = d
const base = `http://${local}`

try {
  await until(() => daemonLog().includes('listening on'), 'the daemon', 30_000)
  await until(() => daemonLog().includes('relay: connected'), 'the engine to reach its own relay', 20_000)
  console.log(`scratch: ${root}`)

  await check('the engine runs the relay and serves the app from it', async () => {
    const status = await api<{ connected: boolean; serving: { listening: number; app: boolean; error: string | null } }>('/api/remote')
    if (!status.connected || status.serving.listening !== RELAY_PORT || !status.serving.app || status.serving.error) throw new Error(JSON.stringify(status))
    const page = await fetch(`${base}/machine/x`)
    if (!(await page.text()).includes('<div id="root">')) throw new Error('not the app')
  })

  await check('opened inside Telegram from that address, it pairs and sees the machine', async () => {
    await installTelegram(page)
    const offer = await api<{ link?: string; error?: string }>('/api/remote/pair', { role: 'owner', yes: true })
    if (!offer.link) throw new Error(offer.error ?? 'no pairing link')
    await page.goto(`${base}/pair?${offer.link.slice(offer.link.indexOf('?') + 1)}${launchHash('user=%7B%22id%22%3A1%7D&auth_date=1&hash=0')}`)
    await see('Paired with e2e-tg-box', 20_000)
    await tap('pair-open')
    await see('Online', 15_000)
    await shot('01-machine')
    const devices = await api<{ name: string; platform: string; role: string }[]>('/api/remote/devices')
    if (!devices.some(x => x.platform === 'telegram-ios' && x.name === 'Telegram on iPhone' && x.role === 'owner')) throw new Error(`the machine has ${JSON.stringify(devices)}`)
  })

  if (d.errors().length > 0) console.log(`✗ errors in the page:\n  ${d.errors().join('\n  ')}`)
} catch {
  // Reported above.
} finally {
  await d.browser.close()
  daemon.kill()
  await daemon.exited
  Bun.spawnSync(['tmux', '-L', 'afterhours-e2e-tg', 'kill-server'], { stderr: 'ignore' })
  if (keep) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
}

console.log(d.failed() ? '\nFAILED' : `\nAll passed. Screenshots: ${out}`)
process.exit(d.failed() ? 1 : 0)
