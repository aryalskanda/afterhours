#!/usr/bin/env bun
// The Linux engine end to end, in its Docker image: a relay here, the engine in a container, and
// an app here that pairs with it and queues a task. Claude Code in the container isn't signed in
// (that takes your account), so the task stops on Claude's sign-in screen, which is the point: it
// shows the whole path works on Linux (starting without a service manager, the relay, pairing,
// the queue, tmux, Claude's screen read back through the app). Costs nothing. Needs Docker.
//   docker build -f packaging/docker/Dockerfile -t afterhours-engine:test .
//   bun scripts/e2e-docker.ts [--image afterhours-engine:test] [--keep]

import { AppClient, newIdentity, type Event } from '@afterhours/protocol'
import { startRelay } from '../relay/src/server'

const imageArg = process.argv.indexOf('--image')
const image = imageArg > 0 ? process.argv[imageArg + 1]! : 'afterhours-engine:test'
const keep = process.argv.includes('--keep')
const name = `afterhours-e2e-${process.pid}`
const project = '/home/afterhours/projects/demo'

function docker(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
}

function inside(script: string): string {
  const r = docker('exec', name, 'sh', '-c', script)
  if (!r.ok) throw new Error(`in the container: ${script}\n${r.out}`)
  return r.out
}

async function until<T>(what: string, check: () => T | null | undefined | false, seconds: number): Promise<T> {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out after ${seconds}s waiting for ${what}`)
    await Bun.sleep(500)
  }
}

const relay = startRelay({ port: 0, hostname: '0.0.0.0' })
const app = new AppClient({ identity: newIdentity(), device: { name: 'Docker check', platform: 'test', app: 'afterhours-e2e/0' }, timing: { retryMs: 300 } })
const results: { name: string; error: string | null }[] = []
/** Processes to stop at the end (cq pair, which waits for the device). */
const children: { kill(): void }[] = []
let machine: { id: string; name: string; relay: string } | null = null

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n• ${label}`)
  try {
    await fn()
    results.push({ name: label, error: null })
    console.log('✔ passed')
  } catch (err) {
    results.push({ name: label, error: err instanceof Error ? err.message : String(err) })
    console.log(`✖ ${err instanceof Error ? err.message : err}`)
  }
}

try {
  const run = docker('run', '-d', '--name', name, '--add-host=host.docker.internal:host-gateway', image)
  if (!run.ok) throw new Error(`docker run: ${run.out}`)
  console.log(`container ${name} from ${image}`)

  await check('the engine starts on Linux, without a service manager', async () => {
    await until('the daemon', () => docker('exec', name, 'curl', '-fsS', 'http://127.0.0.1:7787/api/health').ok, 30)
    console.log(docker('exec', name, 'cq', 'doctor').out.replace(/^/gm, '   '))
    const install = docker('exec', name, 'cq', 'install').out
    if (!/systemd user session/.test(install)) throw new Error(`cq install should explain there's no service here:\n${install}`)
    console.log(`   cq install: ${install.split('\n').find(l => /systemd user session/.test(l))}`)
  })

  await check('pairing from here, through the relay', async () => {
    inside(
      `git init -q ${project} && git -C ${project} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && ` +
        `cat > ~/.afterhours/config.json <<'JSON'
{"defaults": {"plan": false, "review": false, "execMode": "auto", "model": "haiku", "effort": "low"}, "isolate": false,
 "trustedDirs": ["${project}"], "folders": {"roots": ["/home/afterhours/projects"], "maxDepth": 3},
 "timeouts": {"launchSec": 25, "stuckSec": 600, "limitGraceSec": 30, "approvalSec": 300, "questionSec": 300, "reviewSec": 600, "backgroundSec": 120}}
JSON`,
    )
    // cq pair turns remote access on, shows the link, and (--yes) approves the first device to use it.
    const pair = Bun.spawn(['docker', 'exec', name, 'cq', 'pair', '--relay', `ws://host.docker.internal:${relay.port}/v1`, '--yes'], { stdout: 'pipe', stderr: 'pipe' })
    children.push(pair)
    let output = ''
    void (async () => {
      for await (const chunk of pair.stdout) output += new TextDecoder().decode(chunk)
    })()
    const link = await until('the pairing link', () => /afterhours:\/\/pair\?\S+/.exec(output)?.[0], 40)
    // The container reaches this machine as host.docker.internal; from here the relay is 127.0.0.1.
    const local = link.replace(encodeURIComponent(`ws://host.docker.internal:${relay.port}/v1`), encodeURIComponent(`ws://127.0.0.1:${relay.port}/v1`))
    const paired = await app.pair(local)
    console.log(`   paired with ${paired.machine.name} (${paired.machine.os} ${paired.machine.arch}) as ${paired.role}`)
    await until('cq pair to finish', () => /Paired with/.test(output), 20)
    machine = { id: paired.machine.id, name: paired.machine.name, relay: `ws://127.0.0.1:${relay.port}/v1` }
  })

  await check('a task queued from here runs in tmux in the container, and its screen comes back', async () => {
    if (!machine) throw new Error('not paired')
    const conn = app.connect(machine)
    const events: Event[] = []
    conn.on('event', e => events.push(e))
    await until('the session', () => conn.status === 'connected', 20)
    const queued = await conn.request({ type: 'queue', folder: project, prompt: 'Say hi.' })
    if (!queued.ok) throw new Error(queued.error ?? 'refused')
    const job = (queued.data as { job: { id: number } }).job.id
    await until(`#${job} to start`, () => events.some(e => e.notice.type === 'started'), 30)
    console.log(`   #${job} started`)
    let screen = ''
    await until(
      "Claude's screen",
      () => {
        void conn.request({ type: 'peek', lines: 30 }).then(r => (screen = (r.data as { text?: string } | null)?.text ?? ''))
        return screen.trim() !== ''
      },
      40,
    )
    const lines = screen.split('\n').filter(l => l.trim()).slice(0, 12)
    console.log(`   Claude's screen, read back through the relay:\n${lines.map(l => `   │ ${l}`).join('\n')}`)
    const stopped = await until('the task to stop on that screen', () => events.find(e => e.notice.type === 'held' || e.notice.type === 'failed'), 90)
    console.log(`   then: ${stopped.text.split('\n')[0]}`)
  })
} catch (err) {
  results.push({ name: 'setup', error: err instanceof Error ? err.message : String(err) })
  console.log(`✖ ${err instanceof Error ? err.message : err}`)
} finally {
  for (const child of children) child.kill()
  app.close()
  if (!keep) docker('rm', '-f', '-v', name)
  await relay.stop()
}

const failed = results.filter(r => r.error)
console.log(failed.length === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed.length} of ${results.length} checks failed.`)
process.exit(failed.length === 0 ? 0 : 1)
