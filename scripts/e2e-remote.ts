#!/usr/bin/env bun
// End-to-end check of remote access with the real Claude Code: a relay, a private daemon
// (throwaway home, port and tmux socket) and an app in this process. The app pairs through the
// relay, queues a Haiku task, allows its permission request and sees it finish; then the checks
// that matter for security: folders outside the machine's rules are refused, a tampered frame
// ends the session (and the app recovers), and a removed device is shut out.
// Uses your Claude sign-in and costs a few cents. `--keep` keeps the scratch folder.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient, newIdentity, type Event, type MachineConnection, type SocketFactory, type SocketLike } from '@afterhours/protocol'
import { startRelay } from '../relay/src/server'
import { BRAND } from '../src/shared/brand'

const PORT = Number(process.env.E2E_PORT ?? 7798)
const SOCKET = `${BRAND.slug}-e2e-remote`
const JOB_TIMEOUT_SEC = Number(process.env.E2E_JOB_TIMEOUT ?? 300)
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-e2e-remote-`))
const home = join(root, 'home')
const repo = join(root, 'projects', 'repo')
const outside = join(root, 'elsewhere')

function git(...args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
}

mkdirSync(home, { recursive: true })
mkdirSync(repo, { recursive: true })
mkdirSync(outside)
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'e2e@example.com')
git('config', 'user.name', 'E2E check')
writeFileSync(join(repo, 'README.md'), '# e2e\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')

const relay = startRelay({ port: 0 })
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    port: PORT,
    imessage: { enabled: false, allowSms: false },
    telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
    keepAwake: false,
    isolate: false,
    trustedDirs: [repo],
    folders: { roots: [root], maxDepth: 3 },
    defaults: { plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low' },
    timeouts: { launchSec: 120, stuckSec: 600, limitGraceSec: 30, approvalSec: 300, questionSec: 300, reviewSec: 600, backgroundSec: 120 },
    remote: { enabled: true, relay: relay.url, name: 'e2e-box', allowedRoots: [join(root, 'projects')], allowBypass: false, allowScreens: true, allowTyping: true },
  }),
)

const logFile = join(root, 'daemon.log')
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli', 'cq.ts'), 'daemon'], {
  env: { ...process.env, CQ_HOME: home, CQ_TMUX_SOCKET: SOCKET, CQ_PORT: String(PORT) },
  stdout: Bun.file(logFile),
  stderr: Bun.file(join(root, 'daemon.err')),
})

let tamperNext = false
const socket: SocketFactory = url => {
  const ws = new WebSocket(url) as unknown as SocketLike
  const send = ws.send.bind(ws)
  ws.send = (data: string | ArrayBuffer) => {
    if (tamperNext && typeof data !== 'string') {
      tamperNext = false
      const bytes = new Uint8Array(data)
      bytes[bytes.length - 1]! ^= 0x01
    }
    send(data)
  }
  return ws
}
const app = new AppClient({ identity: newIdentity(), device: { name: 'E2E phone', platform: 'test', app: 'afterhours-e2e/0' }, socket, timing: { retryMs: 200, maxRetryMs: 2000 } })

let cleanedUp = false
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  app.close()
  daemon.kill()
  await daemon.exited
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
  await relay.stop()
  // Claude Code keeps transcripts per folder; don't leave the scratch repo's behind.
  Bun.spawnSync(['claude', 'purge', '-y', repo], { stdout: 'ignore', stderr: 'ignore' })
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

const daemonLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

async function until<T>(what: string, check: () => T | null | undefined | false, seconds: number): Promise<T> {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const value = check()
    if (value) return value
    if (daemon.exitCode !== null) throw new Error(`the daemon exited (${daemon.exitCode}) while waiting for ${what}`)
    if (Date.now() > end) throw new Error(`timed out after ${seconds}s waiting for ${what}`)
    await Bun.sleep(200)
  }
}

async function local<T>(path: string, body?: unknown): Promise<T> {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

const results: { name: string; error: string | null }[] = []
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n• ${name}`)
  const started = Date.now()
  try {
    await fn()
    results.push({ name, error: null })
    console.log(`✔ passed in ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    results.push({ name, error })
    console.log(`✖ ${error}`)
  }
}

let conn: MachineConnection | null = null
const events: Event[] = []

try {
  await until('the daemon to start', () => daemonLog().includes('listening on'), 30)
  const version = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe' }).stdout.toString().trim()
  console.log(`${BRAND.name} remote access, end to end, with Claude Code ${version || '(version unknown)'}`)
  console.log(`scratch: ${root}`)

  await check('pairing through the relay', async () => {
    await until('the machine to reach the relay', () => daemonLog().includes('relay: connected'), 20)
    const offer = await local<{ link: string; error?: string }>('/api/remote/pair', { role: 'owner', yes: true })
    if (!offer.link) throw new Error(offer.error ?? 'no pairing link')
    const paired = await app.pair(offer.link)
    console.log(`   paired with ${paired.machine.name} (${paired.machine.os}) as ${paired.role}`)
    conn = app.connect({ id: paired.machine.id, name: paired.machine.name, relay: paired.machine.relay })
    conn.on('event', e => events.push(e))
    await until('the session', () => conn!.status === 'connected', 20)
    const devices = await local<{ name: string }[]>('/api/remote/devices')
    if (!devices.some(d => d.name === 'E2E phone')) throw new Error('the machine did not keep the device')
  })

  await check('a task queued from the app; its permission request allowed from the app', async () => {
    if (!conn) throw new Error('not connected')
    const queued = await conn.request({
      type: 'queue',
      folder: repo,
      prompt: `Run this exact shell command with the Bash tool, then reply with one word: python3 -c "open('remote.txt','w').write('42')"`,
      options: { mode: 'acceptEdits', plan: false, model: 'haiku', effort: 'low', isolate: false },
    })
    if (!queued.ok) throw new Error(queued.error ?? 'refused')
    const job = (queued.data as { job: { id: number } }).job.id
    console.log(`   queued #${job}`)
    const answered = new Set<string>()
    const end = Date.now() + JOB_TIMEOUT_SEC * 1000
    for (;;) {
      for (const e of events) {
        const n = e.notice
        if (n.type === 'permission' && n.job.id === job && !answered.has(n.code)) {
          answered.add(n.code)
          const r = await conn.request({ type: 'answer', code: n.code, decision: 'allow' })
          console.log(`   ${n.tool}: ${r.ok ? r.text : r.error}`)
        }
      }
      const done = events.find(e => (e.notice.type === 'done' || e.notice.type === 'failed' || e.notice.type === 'held') && 'job' in e.notice && e.notice.job.id === job)
      if (done) {
        if (done.notice.type !== 'done') throw new Error(`#${job} ended: ${done.text}`)
        break
      }
      if (Date.now() > end) throw new Error(`#${job} didn't finish within ${JOB_TIMEOUT_SEC}s`)
      if (daemon.exitCode !== null) throw new Error('the daemon exited')
      await Bun.sleep(500)
    }
    if (answered.size === 0) throw new Error('no permission request reached the app')
    const file = join(repo, 'remote.txt')
    if (!existsSync(file) || readFileSync(file, 'utf8').trim() !== '42') throw new Error("the allowed command didn't run")
    console.log(`   events received: ${events.length} (last seq ${conn.lastSeq})`)
  })

  await check("the machine's folder rules hold", async () => {
    if (!conn) throw new Error('not connected')
    const r = await conn.request({ type: 'queue', folder: outside, prompt: 'List the files here.' })
    if (r.ok || r.code !== 'policy') throw new Error(`expected a policy refusal, got ${JSON.stringify(r)}`)
    console.log(`   refused: ${r.error}`)
  })

  await check('a tampered frame ends the session; the app starts a new one', async () => {
    if (!conn) throw new Error('not connected')
    const statuses: string[] = []
    const off = conn.on('status', s => statuses.push(s))
    tamperNext = true
    const r = await conn.request({ type: 'snapshot' }, { timeoutMs: 15_000 })
    off()
    if (!r.ok) throw new Error(r.error ?? 'refused')
    if (!statuses.includes('connecting')) throw new Error('the tampered session was not replaced')
    if (!daemonLog().includes('failed to decrypt')) throw new Error("the machine didn't notice the tampering")
    console.log('   the machine dropped the session; the app reconnected and got its answer')
  })

  await check('a removed device is shut out', async () => {
    if (!conn) throw new Error('not connected')
    const removed = await local<{ removed?: string; error?: string }>('/api/remote/devices/remove', { device: 'E2E phone' })
    if (!removed.removed) throw new Error(removed.error ?? 'not removed')
    await until('the app to be refused', () => conn!.status === 'refused', 20)
    const audit = await local<{ action: string }[]>('/api/remote/audit?limit=50')
    for (const action of ['paired', 'queue', 'answer', 'device.removed']) {
      if (!audit.some(a => a.action === action)) throw new Error(`the audit trail has no ${action}`)
    }
    console.log(`   audit trail: ${audit.map(a => a.action).reverse().join(', ')}`)
  })
} catch (err) {
  results.push({ name: 'setup', error: err instanceof Error ? err.message : String(err) })
  console.log(`✖ ${err instanceof Error ? err.message : err}`)
} finally {
  await cleanup()
}

const failed = results.filter(r => r.error)
if (failed.length === 0) {
  console.log(`\nAll ${results.length} checks passed.`)
  if (!keep) rmSync(root, { recursive: true, force: true })
} else {
  console.log(`\n${failed.length} of ${results.length} checks failed. The daemon log is in ${logFile}`)
}
process.exit(failed.length === 0 ? 0 : 1)
