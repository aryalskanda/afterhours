// Remote access in the daemon, end to end through a real relay: an app pairs, syncs, queues
// tasks and answers requests, under the machine's own rules.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient, newIdentity, parsePairingLink, peerId, type Event, type HostSession, type MachineConnection, type Request, type Role, type Snapshot } from '@afterhours/protocol'
import { startRelay, type Relay } from '../relay/src/server'
import type { Chat, ChatSource } from '../src/daemon/chats'
import { runCommand } from '../src/daemon/commands'
import type { FolderMap } from '../src/daemon/folders'
import type { Notice } from '../src/daemon/notify'
import { Remote } from '../src/daemon/remote'
import { RemoteDb } from '../src/daemon/remote/db'
import { FEATURES } from '../src/daemon/remote/router'
import { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { git } from '../src/daemon/system'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import { checkInitData, signInitData } from '../src/telegram/webapp'
import { FakeTmux } from './fakes'

let relay: Relay
let dir: string
const cleanups: (() => void)[] = []

beforeEach(() => {
  conversations = []
  relay = startRelay({ port: 0 })
  dir = mkdtempSync(join(tmpdir(), 'cq-remote-'))
})

afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  await relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

let restarts = 0
/** What was pushed, through a stand-in for Expo's push service. */
let pushed: { to: string; title: string; body: string; data: Record<string, unknown> }[] = []
const expoFetch = (async (_url: string, init?: RequestInit) => {
  const batch = JSON.parse(String(init?.body)) as typeof pushed
  pushed.push(...batch)
  return Response.json({ data: batch.map((_, i) => ({ status: 'ok', id: `t${pushed.length}-${i}` })) })
}) as unknown as typeof fetch

/** The conversations the fake machine has; tests add to it. */
let conversations: Chat[] = []
const chats: ChatSource = {
  list: () => conversations,
  recent: () => ({ chats: conversations, more: false }),
  get: id => conversations.find(c => c.sessionId === id) ?? null,
}
const folders = { search: async () => [] } as unknown as FolderMap

function machine(o: { remote?: Partial<Config['remote']>; appDir?: string } = {}) {
  const projects = join(dir, 'projects')
  const project = join(projects, 'shop')
  const outside = join(dir, 'elsewhere')
  mkdirSync(project, { recursive: true })
  mkdirSync(outside, { recursive: true })
  let config: Config = {
    ...DEFAULT_CONFIG,
    defaults: { ...DEFAULT_CONFIG.defaults, model: 'haiku' },
    remote: { ...DEFAULT_CONFIG.remote, enabled: true, relay: relay.url, name: 'build-box', allowedRoots: [projects], ...o.remote },
  }
  const store = new Store(':memory:')
  let remote: Remote | null = null
  const runner = new Runner({
    store,
    tmux: new FakeTmux(),
    notify: n => remote?.notice(n.type, n),
    config: () => config,
    saveConfig: c => {
      config = c
    },
    now: Date.now,
    claudePath: '/bin/claude',
    selfCommand: ['/bin/cq'],
    port: 7787,
    home: dir,
    jobsDir: join(dir, 'jobs'),
    scripts: { hook: '/bin/true', status: '/bin/true' },
    writeFile: () => {},
    sessionHolders: () => [],
    git: { head: async () => null, diffStat: async () => null, worktree: async () => null, commitAll: async () => false, snapshot: async () => null },
    killPid: () => {},
    log: () => {},
    sleep: async () => {},
  })
  remote = new Remote({
    store,
    runner,
    chats,
    folders,
    config: () => config,
    command: (text, guard) =>
      runCommand(text, { runner, store, config: () => config, saveConfig: c => (config = c), now: Date.now, source: 'remote', guard, chats }),
    version: '0.1.0-test',
    git,
    uploadsDir: join(dir, 'uploads'),
    claudeDir: join(dir, 'claude'),
    claudeJson: join(dir, 'claude.json'),
    claudePath: '/usr/bin/true',
    logPath: join(dir, 'cqd.log'),
    reportsPath: join(dir, 'logs', 'app-reports.log'),
    push: { url: 'http://expo.test/send', fetch: expoFetch, sleep: async () => {} },
    restart: () => restarts++,
    log: () => {},
    now: Date.now,
    identityPath: join(dir, 'identity.json'),
    appDir: o.appDir ?? join(dir, 'no-app'),
    relayDb: ':memory:',
  })
  remote.apply()
  cleanups.push(() => {
    remote!.stop()
    store.close()
  })
  return {
    remote,
    store,
    runner,
    project,
    outside,
    config: () => config,
    setRemote: (patch: Partial<Config['remote']>) => {
      config = { ...config, remote: { ...config.remote, ...patch } }
    },
  }
}

async function pairedApp(m: ReturnType<typeof machine>, o: { role?: Role; name?: string } = {}) {
  await until(() => m.remote.status().connected)
  const offer = m.remote.openOffer({ role: o.role ?? 'owner', autoApprove: true })
  if (typeof offer === 'string') throw new Error(offer)
  const client = new AppClient({
    identity: newIdentity(),
    device: { name: o.name ?? 'Test phone', platform: 'test', app: 'afterhours-test/0' },
    timing: { retryMs: 50, maxRetryMs: 200 },
  })
  cleanups.unshift(() => client.close())
  const result = await client.pair(offer.link)
  const record = { id: result.machine.id, name: result.machine.name, relay: result.machine.relay }
  const events: Event[] = []
  const snapshots: Snapshot[] = []
  const conn = client.connect(record)
  conn.on('event', e => events.push(e))
  conn.on('snapshot', s => snapshots.push(s))
  await until(() => conn.status === 'connected' && snapshots.length > 0)
  return { client, conn, record, events, snapshots, id: client.o.identity }
}

describe('remote access', () => {
  test('a paired app gets a snapshot with the machine, its role and the rules', async () => {
    const m = machine()
    const app = await pairedApp(m)
    const snap = app.snapshots[0]!
    expect(snap.machine.name).toBe('build-box')
    expect(snap.role).toBe('owner')
    expect(snap.policy.allowBypass).toBe(false)
    expect(snap.policy.allowedRoots[0]).toEndWith('projects')
    expect(m.remote.devices().map(d => d.name)).toEqual(['Test phone'])
  })

  test('tasks run only in the folders the machine allows', async () => {
    const m = machine()
    const { conn } = await pairedApp(m)
    const ok = await conn.request({ type: 'queue', folder: m.project, prompt: 'Add a dark mode toggle' })
    expect(ok.ok).toBe(true)
    expect(m.store.queued().map(j => [j.projectDir, j.prompt, j.source])).toEqual([[m.project, 'Add a dark mode toggle', 'remote']])

    const refused = await conn.request({ type: 'queue', folder: m.outside, prompt: 'Read the secrets' })
    expect(refused).toMatchObject({ ok: false, code: 'policy' })
    expect(refused.error).toContain('outside the folders')
    // The same rule applies to text commands.
    const viaCommand = await conn.request({ type: 'command', text: `q ${m.outside}: read the secrets` })
    expect(viaCommand.text).toContain('outside the folders')
    expect(m.store.queued()).toHaveLength(1)
  })

  test("tasks that skip permission prompts need the machine's yes", async () => {
    const m = machine()
    const { conn } = await pairedApp(m)
    const refused = await conn.request({ type: 'queue', folder: m.project, prompt: 'x', options: { mode: 'bypassPermissions' } })
    expect(refused).toMatchObject({ ok: false, code: 'policy' })
    m.setRemote({ allowBypass: true })
    const allowed = await conn.request({ type: 'queue', folder: m.project, prompt: 'x', options: { mode: 'bypassPermissions' } })
    expect(allowed.ok).toBe(true)
  })

  test('viewers can look but not act; typing can be turned off', async () => {
    const m = machine()
    const viewer = await pairedApp(m, { role: 'viewer', name: 'Tablet' })
    const queued = await viewer.conn.request({ type: 'queue', folder: m.project, prompt: 'x' })
    expect(queued).toMatchObject({ ok: false, code: 'forbidden' })
    expect((await viewer.conn.request({ type: 'snapshot' })).ok).toBe(true)

    const owner = await pairedApp(m)
    m.setRemote({ allowTyping: false })
    expect(await owner.conn.request({ type: 'say', text: 'hello' })).toMatchObject({ ok: false, code: 'policy' })
    expect(await owner.conn.request({ type: 'command', text: 'say hello' })).toMatchObject({ ok: false, code: 'policy' })
    expect(await owner.conn.request({ type: 'command', text: `trust ${m.project}` })).toMatchObject({ ok: false, code: 'policy' })
  })

  test('writing into a chat that skips permission prompts needs the machine\'s yes, and so does making it the default', async () => {
    const m = machine()
    const { conn } = await pairedApp(m)
    conversations = [
      {
        sessionId: '3f0c2a9e-0000-4000-8000-000000000001',
        cwd: m.project,
        title: 'Refactor the checkout',
        lastPrompt: null,
        lastReply: null,
        updatedAt: Date.now(),
        model: 'claude-sonnet-5-5',
        permissionMode: 'bypassPermissions',
        limit: null,
        where: null,
        busy: false,
        running: false,
      },
    ]
    const refused = await conn.request({ type: 'chat.write', session: conversations[0]!.sessionId, text: 'Carry on' })
    expect(refused).toMatchObject({ ok: false, code: 'policy' })
    expect(m.store.queued()).toHaveLength(0)
    expect(await conn.request({ type: 'command', text: 'defaults yolo' })).toMatchObject({ ok: false, code: 'policy' })
    expect(m.config().defaults.execMode).toBe('auto')

    m.setRemote({ allowBypass: true })
    const allowed = await conn.request({ type: 'chat.write', session: conversations[0]!.sessionId, text: 'Carry on' })
    expect(allowed.ok).toBe(true)
    expect(m.store.queued().map(j => [j.sessionId, j.execMode, j.prompt])).toEqual([[conversations[0]!.sessionId, 'bypassPermissions', 'Carry on']])
  })

  test('a retried request is carried out once and answered the same', async () => {
    const m = machine()
    const app = await pairedApp(m)
    const router = (m.remote as unknown as { router: { handle(s: HostSession, r: Request): Promise<void> } }).router
    const sent: unknown[] = []
    const device = m.remote.devices()[0]!
    const session: HostSession = { device: device.id, hello: { v: 1, app: 'x', name: 'x', platform: 'x' }, role: 'owner', subscribed: false, lastActive: 0, send: msg => (sent.push(msg), true) }
    const request: Request = { id: 'retry-me-123', type: 'queue', folder: m.project, prompt: 'Only once' }
    await router.handle(session, request)
    await router.handle(session, request)
    expect(m.store.queued().filter(j => j.prompt === 'Only once')).toHaveLength(1)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    void app
  })

  test('notices reach the app in order, and an app that was away catches up', async () => {
    const m = machine()
    const app = await pairedApp(m)
    const warn = (message: string): Notice => ({ type: 'setup_warning', message })
    m.remote.notice('one', warn('one'))
    await until(() => app.events.length === 1)
    expect(app.events[0]).toMatchObject({ seq: 1, text: 'one', notice: { type: 'setup_warning', message: 'one' } })

    app.client.close()
    m.remote.notice('two', warn('two'))
    m.remote.notice('three', warn('three'))

    const again = new AppClient({ identity: app.id, device: { name: 'Test phone', platform: 'test', app: 'afterhours-test/0' }, timing: { retryMs: 50 } })
    cleanups.unshift(() => again.close())
    const events: Event[] = []
    const conn: MachineConnection = again.connect(app.record, { lastSeq: 1 })
    conn.on('event', e => events.push(e))
    await until(() => events.length === 2)
    expect(events.map(e => e.text)).toEqual(['two', 'three'])
    expect(conn.lastSeq).toBe(3)
  })

  test("an app kills the running task, and the other apps hear who did; a viewer can't", async () => {
    const m = machine()
    const phone = await pairedApp(m, { name: 'Phone' })
    const viewer = await pairedApp(m, { role: 'viewer', name: 'Tablet' })
    const job = m.runner.enqueue({ projectDir: m.project, prompt: 'x', plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' })
    await m.runner.tick()
    expect(m.store.getJob(job.id)!.status).toBe('running')
    expect(await viewer.conn.request({ type: 'control', action: 'kill', job: job.id })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await phone.conn.request({ type: 'control', action: 'kill', job: job.id })).toMatchObject({ ok: true, text: `Killed #${job.id}. Queue empty.` })
    expect(m.store.getJob(job.id)).toMatchObject({ status: 'cancelled', error: 'Killed by Phone' })
    m.remote.tick()
    await until(() => viewer.events.some(e => e.notice.type === 'killed'))
    expect(viewer.events.find(e => e.notice.type === 'killed')!.notice).toMatchObject({ by: 'Phone', job: { id: job.id, status: 'cancelled' } })
    expect(await phone.conn.request({ type: 'control', action: 'kill', job: job.id })).toMatchObject({ ok: false, code: 'gone' })
    expect(await phone.conn.request({ type: 'control', action: 'kill' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  test('the first answer wins, and other apps hear who answered', async () => {
    const m = machine()
    const phone = await pairedApp(m, { name: 'Phone' })
    const laptop = await pairedApp(m, { name: 'Laptop' })
    const job = m.runner.enqueue({ projectDir: m.project, prompt: 'x', plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' })
    m.store.addApproval('ab12', job.id, 'permission', { tool: 'Bash' }, Date.now())
    m.remote.tick()
    const first = await phone.conn.request({ type: 'answer', code: 'ab12', decision: 'allow' })
    expect(first.ok).toBe(true)
    const second = await laptop.conn.request({ type: 'answer', code: 'ab12', decision: 'deny' })
    expect(second).toMatchObject({ ok: false, code: 'gone' })
    m.remote.tick()
    await until(() => laptop.events.some(e => e.notice.type === 'resolved'))
    const resolved = laptop.events.find(e => e.notice.type === 'resolved')!.notice
    expect(resolved).toMatchObject({ code: 'ab12', status: 'allowed', by: 'Phone' })
  })

  test('the snapshot has what an app needs to show requests and start tasks', async () => {
    const m = machine()
    const app = await pairedApp(m)
    const job = m.runner.enqueue({ projectDir: m.project, prompt: 'x', plan: true, review: true, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' })
    m.store.updateJob(job.id, { planText: '1. Do it' })
    const now = Date.now()
    m.store.addApproval('perma', job.id, 'permission', { tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }, now)
    m.store.addApproval('quest', job.id, 'question', { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] }, now)
    m.store.addApproval('revie', job.id, 'review', {}, now)
    m.store.addApproval('trust', job.id, 'trust', { dir: m.project }, now)
    const r = await app.conn.request({ type: 'snapshot' })
    const snap = r.data as Snapshot
    const by = Object.fromEntries(snap.approvals.map(a => [a.code, a]))
    expect(by.perma).toMatchObject({ kind: 'permission', tool: 'Bash' })
    expect(by.perma!.detail).toContain('npm test')
    expect(by.perma!.expiresAt).toBe(now + m.config().timeouts.approvalSec * 1000)
    expect(by.quest!.questions![0]!.question).toBe('Which?')
    expect(by.revie!.plan).toBe('1. Do it')
    expect(by.trust!.folder).toBe(m.project)
    expect(snap.defaults).toMatchObject({ model: 'haiku', mode: 'auto' })
    expect(snap.models).toContain('haiku')
  })

  test("a task in full, and the folders tasks ran in lately (only allowed ones)", async () => {
    const m = machine()
    const { conn } = await pairedApp(m)
    const inside = m.runner.enqueue({ projectDir: m.project, prompt: 'x', plan: true, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' })
    m.runner.enqueue({ projectDir: m.outside, prompt: 'y', plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' })
    m.store.updateJob(inside.id, { planText: '## Plan', lastMessage: 'Done: **all good**' })
    const task = await conn.request({ type: 'task', job: inside.id })
    expect(task.data).toMatchObject({ plan: '## Plan', answer: 'Done: **all good**', job: { id: inside.id } })
    expect(await conn.request({ type: 'task', job: 999 })).toMatchObject({ ok: false, code: 'not-found' })
    const folders = await conn.request({ type: 'folders', query: '' })
    expect((folders.data as { path: string }[]).map(f => f.path)).toEqual([m.project])
  })

  test('any device may rename or remove itself, but only an owner may do that to others', async () => {
    const m = machine()
    const owner = await pairedApp(m, { name: 'Laptop' })
    const viewer = await pairedApp(m, { role: 'viewer', name: 'Tablet' })
    const ownerId = m.remote.devices().find(d => d.name === 'Laptop')!.id
    const viewerId = m.remote.devices().find(d => d.name === 'Tablet')!.id
    expect(await viewer.conn.request({ type: 'devices.rename', device: viewerId, name: 'Kitchen tablet' })).toMatchObject({ ok: true })
    expect(m.remote.devices().find(d => d.id === viewerId)!.name).toBe('Kitchen tablet')
    expect(await viewer.conn.request({ type: 'devices.rename', device: ownerId, name: 'Mine now' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await viewer.conn.request({ type: 'devices.remove', device: ownerId })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await viewer.conn.request({ type: 'devices.remove', device: viewerId })).toMatchObject({ ok: true })
    await until(() => viewer.conn.status === 'refused')
    expect(m.remote.devices().map(d => d.id)).toEqual([ownerId])
    expect(owner.conn.status).toBe('connected')
  })

  test('a removed device is cut off at once', async () => {
    const m = machine()
    const app = await pairedApp(m)
    const id = m.remote.devices()[0]!.id
    expect(m.remote.removeDevice(id, 'test')).toBe(true)
    await until(() => app.conn.status === 'refused')
    expect(m.remote.devices()).toHaveLength(0)
  })

  test('the audit trail says what was done, never the prompt', async () => {
    const m = machine()
    const { conn } = await pairedApp(m)
    await conn.request({ type: 'queue', folder: m.project, prompt: 'Rotate the API keys in config/secrets.yml' })
    const trail = m.remote.auditLog(10)
    expect(trail.map(e => e.action)).toContain('paired')
    const queue = trail.find(e => e.action === 'queue')!
    expect(queue.deviceName).toBe('Test phone')
    expect(queue.detail).toContain('characters')
    expect(JSON.stringify(trail)).not.toContain('secrets.yml')
  })
})

describe('the event log', () => {
  test('after a long absence the newest events are replayed, oldest first', () => {
    const store = new Store(':memory:')
    const db = new RemoteDb(store.db)
    for (let i = 1; i <= 5; i++) db.addEvent(i, JSON.stringify({ type: 'empty' }), `#${i}`)
    expect(db.eventsAfter(0, 2).map(e => e.seq)).toEqual([4, 5])
    expect(db.eventsAfter(3, 10).map(e => e.seq)).toEqual([4, 5])
    expect(db.lastSeq()).toBe(5)
    store.close()
  })
})

describe('seeing the work', () => {
  const base = { plan: false, review: false, execMode: 'auto' as const, model: 'haiku', effort: 'low' as const, sessionPolicy: 'new' as const, source: 'remote' }
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  test('the snapshot lists what this machine can do', async () => {
    const m = machine()
    const app = await pairedApp(m)
    expect(app.snapshots[0]!.features).toEqual(FEATURES)
    expect(FEATURES).toContain('transcript')
  })

  test('a task’s conversation, a page at a time, only in shared folders', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const path = join(dir, 'conversation.jsonl')
    const lines = [
      { type: 'user', cwd: m.project, timestamp: new Date().toISOString(), message: { content: 'Add a CSV export' } },
      { type: 'assistant', cwd: m.project, message: { id: 'a', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', cwd: m.project, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '12 passed' }] } },
      { type: 'assistant', cwd: m.project, message: { id: 'b', content: [{ type: 'text', text: 'Done.' }] } },
    ]
    require('node:fs').writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Add a CSV export' }, Date.now())
    m.store.updateJob(job.id, { transcriptPath: path, startedAt: Date.now() - 60_000 })

    const page = await conn.request({ type: 'transcript', job: job.id })
    expect(page.ok).toBe(true)
    const data = page.data as { items: { kind: string }[]; total: number; before: number | null }
    expect(data.items.map(i => i.kind)).toEqual(['you', 'tool', 'claude'])
    expect(data.items[1]).toMatchObject({ name: 'Bash', detail: 'npm test', result: '12 passed' })
    expect((await conn.request({ type: 'transcript', job: job.id, limit: 1 })).data).toMatchObject({ before: 2, total: 3 })

    // A task that hasn't started has an empty conversation; one outside the shared folders, none.
    const waiting = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Later' }, Date.now())
    expect((await conn.request({ type: 'transcript', job: waiting.id })).data).toMatchObject({ items: [], total: 0 })
    const elsewhere = m.store.addJob({ ...base, projectDir: m.outside, prompt: 'x' }, Date.now())
    m.store.updateJob(elsewhere.id, { transcriptPath: path })
    expect(await conn.request({ type: 'transcript', job: elsewhere.id })).toMatchObject({ ok: false, code: 'policy' })
    expect(await conn.request({ type: 'transcript', session: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await conn.request({ type: 'transcript' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  test('a task’s exact changes and one file’s diff; secrets stay out', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    sh(m.project, 'init', '-q', '-b', 'main')
    sh(m.project, 'config', 'user.email', 't@example.com')
    sh(m.project, 'config', 'user.name', 'T')
    const write = (rel: string, text: string) => require('node:fs').writeFileSync(join(m.project, rel), text)
    write('orders.ts', 'export const orders = []\n')
    sh(m.project, 'add', '-A')
    sh(m.project, 'commit', '-q', '-m', 'init')
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Add CSV' }, Date.now())
    const startTree = await git.snapshot(m.project)
    write('orders.ts', 'export const orders = []\nexport const csv = true\n')
    write('csv.ts', 'export function toCsv() {}\n')
    write('.env', 'STRIPE_KEY=sk_live_x\n')
    const endTree = await git.snapshot(m.project)
    m.store.updateJob(job.id, { status: 'done', startTree, endTree, finishedAt: Date.now() })

    const summary = await conn.request({ type: 'diff', job: job.id })
    expect(summary.ok).toBe(true)
    expect(summary.data).toMatchObject({
      basis: 'exact',
      files: [
        { path: 'csv.ts', status: 'added', added: 1, removed: 0 },
        { path: 'orders.ts', status: 'modified', added: 1, removed: 0 },
      ],
    })
    const patch = await conn.request({ type: 'diff', job: job.id, file: 'orders.ts' })
    expect((patch.data as { patch: string }).patch).toContain('+export const csv = true')
    expect(await conn.request({ type: 'diff', job: job.id, file: '.env' })).toMatchObject({ ok: false, code: 'not-found' })
  })

  test('files: operators may browse and read inside shared folders; never secrets', async () => {
    const m = machine()
    const write = (rel: string, text: string) => require('node:fs').writeFileSync(join(m.project, rel), text)
    write('README.md', '# Shop\n')
    write('.env', 'SECRET=1\n')
    const viewer = await pairedApp(m, { role: 'viewer' })
    expect(await viewer.conn.request({ type: 'files', folder: m.project })).toMatchObject({ ok: false, code: 'forbidden' })

    const { conn } = await pairedApp(m, { role: 'operator' })
    const listed = await conn.request({ type: 'files', folder: m.project })
    expect((listed.data as { entries: { name: string }[] }).entries.map(e => e.name)).toEqual(['README.md'])
    expect((await conn.request({ type: 'files', folder: m.project, path: 'README.md', read: true })).data).toMatchObject({ file: { kind: 'text', text: '# Shop\n' } })
    expect(await conn.request({ type: 'files', folder: m.project, path: '.env', read: true })).toMatchObject({ ok: false, code: 'policy' })
    expect(await conn.request({ type: 'files', folder: m.project, path: '../../elsewhere', read: true })).toMatchObject({ ok: false })
    expect(await conn.request({ type: 'files', folder: m.outside })).toMatchObject({ ok: false, code: 'policy' })
    expect(((await conn.request({ type: 'files', folder: m.project, query: 'read' })).data as { entries: { path: string }[] }).entries.map(e => e.path)).toEqual(['README.md'])
  })

  test('a task’s timeline: every notice about it, and who answered', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Add CSV' }, Date.now())
    const other = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Something else' }, Date.now())
    m.remote.notice('started', { type: 'started', job } as Notice)
    m.remote.notice('started', { type: 'started', job: other } as Notice)
    m.remote.notice('done', { type: 'done', job, diff: '1 file changed', next: null } as Notice)
    const r = await conn.request({ type: 'timeline', job: job.id })
    const events = (r.data as { events: Event[] }).events
    expect(events.map(e => e.notice.type)).toEqual(['started', 'done'])
  })

  test('tool calls reach watching apps as they happen', async () => {
    const m = machine()
    const app = await pairedApp(m, { role: 'viewer' })
    const seen: unknown[] = []
    app.conn.on('activity', a => seen.push(a))
    m.remote.activity({ job: 4, at: 1, phase: 'start', tool: 'Bash', detail: 'npm test' })
    await until(() => seen.length === 1)
    expect(seen[0]).toEqual({ type: 'activity', job: 4, at: 1, phase: 'start', tool: 'Bash', detail: 'npm test' })
  })
})

describe('steering', () => {
  const base = { plan: false, review: false, execMode: 'auto' as const, model: 'haiku', effort: 'low' as const, sessionPolicy: 'new' as const, source: 'remote' }
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  test('answers: only a rule Claude Code offered; plan modes under the machine’s rules', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'operator' })
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'x' }, Date.now())
    m.store.addApproval('perma', job.id, 'permission', { tool: 'Bash', input: { command: 'ls' } }, Date.now())
    expect(await conn.request({ type: 'answer', code: 'perma', decision: 'allow', rule: 0 })).toMatchObject({ ok: false, code: 'invalid' })
    m.store.addApproval('plana', job.id, 'review', {}, Date.now())
    expect(await conn.request({ type: 'answer', code: 'plana', decision: 'allow', mode: 'bypassPermissions' })).toMatchObject({ ok: false, code: 'policy' })
    expect(await conn.request({ type: 'answer', code: 'plana', decision: 'allow', mode: 'plan' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await conn.request({ type: 'answer', code: 'plana', decision: 'allow', mode: 'acceptEdits' })).toMatchObject({ ok: true })
    expect(m.store.getJob(job.id)!.execMode).toBe('acceptEdits')
  })

  test('a queued task can be changed and moved; not one that started', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'operator' })
    const a = m.store.addJob({ ...base, projectDir: m.project, prompt: 'A' }, Date.now())
    const b = m.store.addJob({ ...base, projectDir: m.project, prompt: 'B' }, Date.now())
    const c = m.store.addJob({ ...base, projectDir: m.project, prompt: 'C' }, Date.now())
    const edited = await conn.request({ type: 'job', action: 'edit', job: b.id, prompt: 'B, but better', options: { model: 'opus', effort: 'max', maxMinutes: 30 } })
    expect(edited.ok).toBe(true)
    expect(m.store.getJob(b.id)).toMatchObject({ prompt: 'B, but better', model: 'opus', effort: 'max', maxMinutes: 30 })
    expect(await conn.request({ type: 'job', action: 'edit', job: b.id, options: { mode: 'bypassPermissions' } })).toMatchObject({ ok: false, code: 'policy' })
    await conn.request({ type: 'job', action: 'move', job: c.id, to: 0 })
    expect(m.store.queued().map(j => j.prompt)).toEqual(['C', 'A', 'B, but better'])
    await conn.request({ type: 'job', action: 'move', job: c.id, to: 9 })
    expect(m.store.queued().map(j => j.id)).toEqual([a.id, b.id, c.id])
    m.store.updateJob(a.id, { status: 'running' })
    expect(await conn.request({ type: 'job', action: 'edit', job: a.id, prompt: 'too late' })).toMatchObject({ ok: false, code: 'gone' })
  })

  test('scheduling: at a time, at the limit reset, after another task, every day', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'operator' })
    const at = Date.now() + 3_600_000
    const timed = await conn.request({ type: 'queue', folder: m.project, prompt: 'At a time', options: { notBefore: at } })
    expect((timed.data as { job: { notBefore: number } }).job.notBefore).toBe(at)
    expect(await conn.request({ type: 'queue', folder: m.project, prompt: 'Far', options: { notBefore: Date.now() + 30 * 86_400_000 } })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await conn.request({ type: 'queue', folder: m.project, prompt: 'Reset', options: { atReset: true } })).toMatchObject({ ok: false, code: 'invalid' })
    const resets = Date.now() + 2 * 3_600_000
    m.store.kvSet('limits', { fiveHour: { usedPct: 91, resetsAt: resets } })
    const reset = await conn.request({ type: 'queue', folder: m.project, prompt: 'Reset', options: { atReset: true } })
    expect((reset.data as { job: { notBefore: number } }).job.notBefore).toBe(resets)
    expect(await conn.request({ type: 'queue', folder: m.project, prompt: 'After', options: { afterJob: 999 } })).toMatchObject({ ok: false, code: 'invalid' })
    const first = (timed.data as { job: { id: number } }).job.id
    const after = await conn.request({ type: 'queue', folder: m.project, prompt: 'After', options: { afterJob: first } })
    expect((after.data as { job: { afterJob: number } }).job.afterJob).toBe(first)
    const daily = await conn.request({ type: 'queue', folder: m.project, prompt: 'Nightly', options: { repeatDaily: 150 } })
    const next = new Date((daily.data as { job: { notBefore: number } }).job.notBefore)
    expect([next.getHours(), next.getMinutes()]).toEqual([2, 30])
  })

  test('a branch task is merged into a clean checkout or thrown away; a pull request needs an owner', async () => {
    const m = machine()
    sh(m.project, 'init', '-q', '-b', 'main')
    sh(m.project, 'config', 'user.email', 't@example.com')
    sh(m.project, 'config', 'user.name', 'T')
    require('node:fs').writeFileSync(join(m.project, 'app.js'), 'console.log(1)\n')
    sh(m.project, 'add', '-A')
    sh(m.project, 'commit', '-q', '-m', 'init')
    const branchTask = async (id: number) => {
      const wt = (await git.worktree(m.project, id, 'Add dark mode'))!
      require('node:fs').writeFileSync(join(wt.dir, `dark-${id}.css`), 'body { background: #000 }\n')
      await git.commitAll(wt.dir, `Afterhours #${id}`)
      const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'Add dark mode' }, Date.now())
      return m.store.updateJob(job.id, { status: 'done', branch: wt.branch, workDir: wt.dir, finishedAt: Date.now() })
    }
    const operator = await pairedApp(m, { role: 'operator' })
    const one = await branchTask(101)
    expect(await operator.conn.request({ type: 'branch', job: one.id, action: 'pr' })).toMatchObject({ ok: false, code: 'forbidden' })
    // Your checkout has uncommitted changes: nothing is merged.
    require('node:fs').writeFileSync(join(m.project, 'app.js'), 'console.log(2)\n')
    expect(await operator.conn.request({ type: 'branch', job: one.id, action: 'merge' })).toMatchObject({ ok: false, error: expect.stringContaining('uncommitted') })
    sh(m.project, 'checkout', '--', 'app.js')
    const merged = await operator.conn.request({ type: 'branch', job: one.id, action: 'merge' })
    expect(merged).toMatchObject({ ok: true, text: `Merged ${one.branch} into main.` })
    expect(sh(m.project, 'log', '-1', '--format=%s')).toBe(`Merge Afterhours #${one.id}: Add dark mode`)
    expect(require('node:fs').existsSync(join(m.project, 'dark-101.css'))).toBe(true)
    expect(sh(m.project, 'branch', '--list', one.branch!)).toBe('')
    expect(m.store.getJob(one.id)!.branchNote).toBe(`Merged ${one.branch} into main.`)

    const two = await branchTask(102)
    expect(await operator.conn.request({ type: 'branch', job: two.id, action: 'discard' })).toMatchObject({ ok: true })
    expect(sh(m.project, 'branch', '--list', two.branch!)).toBe('')
    expect(require('node:fs').existsSync(two.workDir!)).toBe(false)
    expect(require('node:fs').existsSync(join(m.project, 'dark-102.css'))).toBe(false)

    const owner = await pairedApp(m, { role: 'owner' })
    const three = await branchTask(103)
    expect(await owner.conn.request({ type: 'branch', job: three.id, action: 'pr' })).toMatchObject({ ok: false, code: 'failed' })
    const plain = m.store.addJob({ ...base, projectDir: m.project, prompt: 'In place' }, Date.now())
    expect(await owner.conn.request({ type: 'branch', job: plain.id, action: 'merge' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  test('opening a conversation on the computer needs a screen there', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'operator' })
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'x' }, Date.now())
    expect(await conn.request({ type: 'open', job: job.id })).toMatchObject({ ok: false, code: 'invalid' })
    m.store.updateJob(job.id, { sessionId: '3f0c2a9e-0000-4000-8000-000000000009' })
    expect(await conn.request({ type: 'open', job: job.id })).toMatchObject({ ok: false, code: 'failed', error: 'build-box has no screen to open it on.' })
  })
})

describe('prompts', () => {
  test('an upload comes back as a path; a task names its attachments, and only real uploads', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'operator' })
    const up = await conn.request({ type: 'upload', name: '../../Screen Shot 1.png', data: Buffer.from('png bytes').toString('base64') })
    expect(up.ok).toBe(true)
    const path = (up.data as { path: string }).path
    expect(path.startsWith(join(dir, 'uploads'))).toBe(true)
    expect(path.endsWith('-Screen-Shot-1.png')).toBe(true)
    expect(require('node:fs').readFileSync(path, 'utf8')).toBe('png bytes')
    const queued = await conn.request({ type: 'queue', folder: m.project, prompt: 'Why does this crash?', options: { attachments: [path], group: 'try-3' } })
    expect(queued.ok).toBe(true)
    expect(m.store.queued()[0]).toMatchObject({ attachments: [path], group: 'try-3' })
    expect((queued.data as { job: { attachments: string[] } }).job.attachments).toEqual([path.slice(path.lastIndexOf('/') + 1)])
    expect(await conn.request({ type: 'queue', folder: m.project, prompt: 'x', options: { attachments: ['/etc/hosts'] } })).toMatchObject({ ok: false, code: 'invalid' })
    const viewer = await pairedApp(m, { role: 'viewer' })
    expect(await viewer.conn.request({ type: 'upload', name: 'a.txt', data: 'aGk=' })).toMatchObject({ ok: false, code: 'forbidden' })
  })

  test('slash commands and skills: the project’s and yours, only in shared folders', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const fs = require('node:fs')
    fs.mkdirSync(join(m.project, '.claude', 'commands', 'frontend'), { recursive: true })
    fs.writeFileSync(join(m.project, '.claude', 'commands', 'review.md'), '---\ndescription: Review the diff for bugs\n---\nLook at...')
    fs.writeFileSync(join(m.project, '.claude', 'commands', 'frontend', 'component.md'), '# Make a component\nWith tests.')
    fs.mkdirSync(join(dir, 'claude', 'skills', 'release-notes'), { recursive: true })
    fs.writeFileSync(join(dir, 'claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes from the log\n---\n')
    const r = await conn.request({ type: 'commands', folder: m.project })
    expect((r.data as { commands: unknown[] }).commands).toEqual([
      { name: 'frontend:component', description: 'Make a component', scope: 'project', kind: 'command' },
      { name: 'review', description: 'Review the diff for bugs', scope: 'project', kind: 'command' },
      { name: 'release-notes', description: 'Write release notes from the log', scope: 'user', kind: 'skill' },
    ])
    expect(await conn.request({ type: 'commands', folder: m.outside })).toMatchObject({ ok: false, code: 'policy' })
  })
})

describe('machines, money, safety', () => {
  const base = { plan: false, review: false, execMode: 'auto' as const, model: 'haiku', effort: 'low' as const, sessionPolicy: 'new' as const, source: 'remote' }

  test('history: paging back, a status, words in the prompt or the answer', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const ids: number[] = []
    for (const [i, p] of ['Add CSV export', 'Fix the 50% bug', 'Add dark mode', 'Fix flaky test'].entries()) {
      const j = m.store.addJob({ ...base, projectDir: m.project, prompt: p }, Date.now())
      m.store.updateJob(j.id, { status: i === 3 ? 'failed' : 'done', finishedAt: Date.now() + i, lastMessage: i === 2 ? 'The toggle is in Settings' : null })
      ids.push(j.id)
    }
    const page = async (o: object) => (await conn.request({ type: 'jobs', ...o })).data as { recent: { id: number }[]; more: boolean }
    expect(await page({ recent: 3 })).toMatchObject({ recent: [{ id: ids[3] }, { id: ids[2] }, { id: ids[1] }], more: true })
    expect((await page({ recent: 2, before: ids[3]! + 1 })).recent.map(j => j.id)).toEqual([ids[3]!, ids[2]!])
    expect((await page({ recent: 2, before: ids[3]! + 1 })).more).toBe(true)
    expect((await page({ recent: 2, before: ids[1] })).recent.map(j => j.id)).toEqual([ids[0]!])
    expect((await page({ status: 'failed' })).recent.map(j => j.id)).toEqual([ids[3]!])
    expect((await page({ query: 'add' })).recent.map(j => j.id)).toEqual([ids[2]!, ids[0]!])
    expect((await page({ query: 'settings toggle' })).recent.map(j => j.id)).toEqual([ids[2]!])
    expect((await page({ query: '50%' })).recent.map(j => j.id)).toEqual([ids[1]!])
    expect((await page({ query: '%' })).recent.map(j => j.id)).toEqual([ids[1]!])
  })

  test('chats: a search through titles and last messages, in shared folders', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const chat = (id: string, title: string, cwd: string) => ({ sessionId: id, cwd, title, lastPrompt: null, lastReply: 'Moved the price lookup', updatedAt: 1, model: null, permissionMode: null, limit: null, where: null, busy: false, running: false })
    conversations = [chat('a', 'Refactor the checkout', m.project), chat('b', 'Checkout notes', m.outside), chat('c', 'Dark mode', m.project)]
    const r = await conn.request({ type: 'chats', query: 'checkout price' })
    expect((r.data as { chats: { session: string }[] }).chats.map(c => c.session)).toEqual(['a'])
  })

  test('health for everyone, the log only for owners; restart and invites for owners', async () => {
    const m = machine()
    require('node:fs').writeFileSync(join(dir, 'cqd.log'), 'line one\nline two\n')
    const viewer = await pairedApp(m, { role: 'viewer' })
    const h = (await viewer.conn.request({ type: 'health' })).data as { version: string; uptimeSec: number; logs?: string[]; load: number }
    expect(h.version).toBe('0.1.0-test')
    expect(h.uptimeSec).toBeGreaterThan(0)
    expect(h.logs).toBeUndefined()
    expect(await viewer.conn.request({ type: 'restart' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await viewer.conn.request({ type: 'pair.offer', role: 'viewer' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await viewer.conn.request({ type: 'audit' })).toMatchObject({ ok: false, code: 'forbidden' })

    const owner = await pairedApp(m, { role: 'owner' })
    expect(((await owner.conn.request({ type: 'health' })).data as { logs: string[] }).logs).toEqual(['line one', 'line two'])
    const invite = await owner.conn.request({ type: 'pair.offer', role: 'operator' })
    expect((invite.data as { link: string }).link).toStartWith('afterhours://pair?')
    const before = restarts
    expect(await owner.conn.request({ type: 'restart' })).toMatchObject({ ok: true })
    await until(() => restarts === before + 1)
    const audit = (await owner.conn.request({ type: 'audit', limit: 50 })).data as { entries: { action: string }[] }
    expect(audit.entries.map(e => e.action)).toContain('restart')
  })

  test('Claude Code: the account for owners, MCP servers by name only, and CLAUDE.md', async () => {
    const m = machine()
    const fs = require('node:fs')
    fs.writeFileSync(
      join(dir, 'claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Me' },
        mcpServers: { github: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer secret' } } },
        projects: { [m.project]: { mcpServers: { db: { command: 'pg-mcp', env: { PGPASSWORD: 'secret' } } } } },
      }),
    )
    fs.writeFileSync(join(m.project, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { type: 'sse', url: 'https://y' } } }))
    fs.writeFileSync(join(m.project, 'CLAUDE.md'), '# Shop\nUse bun.\n')
    const viewer = await pairedApp(m, { role: 'viewer' })
    const v = (await viewer.conn.request({ type: 'claude', folder: m.project })).data as Record<string, unknown>
    expect(v.account).toBeUndefined()
    expect(v.mcp).toEqual([
      { name: 'github', scope: 'user', type: 'http' },
      { name: 'db', scope: 'local', type: 'stdio' },
      { name: 'linear', scope: 'project', type: 'sse' },
    ])
    expect(JSON.stringify(v)).not.toContain('secret')
    expect(v.memory).toEqual({ path: join(m.project, 'CLAUDE.md'), exists: true, text: '# Shop\nUse bun.\n' })
    expect(await viewer.conn.request({ type: 'claude.md', folder: m.project, text: 'x' })).toMatchObject({ ok: false, code: 'forbidden' })
    const owner = await pairedApp(m, { role: 'owner' })
    expect(((await owner.conn.request({ type: 'claude' })).data as { account: unknown }).account).toEqual({ email: 'me@example.com', organization: 'Me' })
    expect(await owner.conn.request({ type: 'claude.md', folder: m.project, text: '# Shop\nUse bun. Run tests with bun test.\n' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(join(m.project, 'CLAUDE.md'), 'utf8')).toContain('bun test')
    expect(await owner.conn.request({ type: 'claude.md', folder: m.outside, text: 'x' })).toMatchObject({ ok: false, code: 'policy' })
  })

  test('the limits over the last week, as sampled from the status line', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { role: 'viewer' })
    const job = m.store.addJob({ ...base, projectDir: m.project, prompt: 'x' }, Date.now())
    m.store.updateJob(job.id, { status: 'running' })
    const line = (five: number) => ({ rate_limits: { five_hour: { used_percentage: five, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 86400 } } })
    m.runner.onStatusline(job.id, line(40))
    m.runner.onStatusline(job.id, line(40.4))
    m.runner.onStatusline(job.id, line(55))
    const r = await conn.request({ type: 'limits.history' })
    expect((r.data as { samples: { fiveHour: number }[] }).samples.map(s => s.fiveHour)).toEqual([40, 55])
  })
})

describe('pushes and problem reports', () => {
  const prefs = { events: { requests: true, done: true, failed: true, limits: true }, quiet: null, details: true }

  test('each device registers its token and choices; a removed device gets nothing more', async () => {
    pushed = []
    const m = machine()
    const phone = await pairedApp(m, { name: 'Phone', role: 'viewer' })
    const tablet = await pairedApp(m, { name: 'Tablet' })
    expect((await phone.conn.request({ type: 'push.register', token: 'ExponentPushToken[phone]', prefs })).ok).toBe(true)
    expect((await tablet.conn.request({ type: 'push.register', token: 'ExponentPushToken[tablet]', prefs: { ...prefs, details: false, events: { ...prefs.events, done: false } } })).ok).toBe(true)
    const job = m.store.addJob({ plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'remote', projectDir: m.project, prompt: 'Run the tests' }, Date.now())
    m.remote.notice('🔐 #1 wants to use Bash: npm test', { type: 'permission', job, code: 'k3x9', tool: 'Bash', detail: 'npm test', minutes: 15 })
    await until(() => pushed.length === 2)
    expect(pushed.map(p => [p.to, p.title, p.body])).toEqual([
      ['ExponentPushToken[phone]', 'build-box', '#1 wants to use Bash: npm test'],
      ['ExponentPushToken[tablet]', 'build-box', `#${job.id} needs you.`],
    ])
    m.remote.notice('✅ done', { type: 'done', job, diff: null, next: null })
    await until(() => pushed.length === 3)
    expect(pushed[2]!.to).toBe('ExponentPushToken[phone]')
    // Off on the phone; the tablet removed: nothing more for either.
    await phone.conn.request({ type: 'push.register', token: null, prefs })
    await tablet.conn.request({ type: 'devices.remove', device: peerId(phone.id.publicKey) })
    const owner = await pairedApp(m, { name: 'Owner' })
    await owner.conn.request({ type: 'devices.remove', device: peerId(tablet.id.publicKey) })
    expect(m.remote.db.pushTargets()).toEqual([])
    m.remote.notice('🔐 again', { type: 'permission', job, code: 'k3y0', tool: 'Bash', detail: 'npm test', minutes: 15 })
    await Bun.sleep(100)
    expect(pushed.length).toBe(3)
    expect(m.remote.db.auditLog(20).filter(e => e.action === 'push.register').map(e => e.detail)).toEqual(['off', 'on', 'on, with details'])
  })

  test('a problem report lands in the app-reports log, with the device’s name', async () => {
    const m = machine()
    const { conn } = await pairedApp(m, { name: 'Pixel', role: 'viewer' })
    const r = await conn.request({ type: 'report', text: 'The diff screen is blank on a big file.', app: 'afterhours-app/0.2.0', platform: 'android' })
    expect(r).toMatchObject({ ok: true, text: 'Thanks. It’s in build-box’s app-reports log.' })
    const log = await Bun.file(join(dir, 'logs', 'app-reports.log')).text()
    expect(log).toContain('· Pixel · afterhours-app/0.2.0 · android\nThe diff screen is blank on a big file.')
  })
})

describe('the app inside Telegram: this machine runs the relay and serves the app', () => {
  const TOKEN = '123456:test-token'
  const OWNER = 7001

  function servingMachine() {
    const appDir = join(dir, 'web')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><div id="root"></div>')
    // The public address is Tailscale's; here only the local one exists.
    return machine({ appDir, remote: { relay: 'wss://mac.example.ts.net/v1', serve: { port: 0 }, publicUrl: 'https://mac.example.ts.net/' } })
  }

  function telegramApp(initData: () => string | undefined) {
    const client = new AppClient({
      identity: newIdentity(),
      device: { name: 'Telegram on iPhone', platform: 'telegram-ios', app: 'afterhours-app/0.3.0', telegram: initData },
      timing: { retryMs: 50, maxRetryMs: 200 },
    })
    cleanups.unshift(() => client.close())
    return client
  }

  const verify = (hello: { telegram?: string }) => checkInitData(hello.telegram, { token: TOKEN, ownerId: OWNER, now: Date.now() }).ok
  const launch = (user = OWNER) =>
    signInitData({ user: JSON.stringify({ id: user, first_name: 'Skanda' }), auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN)

  test('it reaches its own relay locally, links give the public address, and the same address serves the app', async () => {
    const m = servingMachine()
    await until(() => m.remote.status().connected)
    const serving = m.remote.status().serving!
    expect(serving).toMatchObject({ port: 0, app: true, error: null, publicUrl: 'https://mac.example.ts.net/' })
    expect(m.remote.appUrl()).toBe('https://mac.example.ts.net')
    const offer = m.remote.openTelegramOffer(verify)
    if (typeof offer === 'string') throw new Error(offer)
    expect(parsePairingLink(offer.link).relay).toBe('wss://mac.example.ts.net/v1')
    const page = await fetch(`http://127.0.0.1:${serving.listening}/machine/x`)
    expect(await page.text()).toContain('id="root"')
  })

  test("pairing from Telegram: the owner's launch data pairs as owner; anyone else's, or none, is refused", async () => {
    const m = servingMachine()
    await until(() => m.remote.status().connected)
    const local = `ws://127.0.0.1:${m.remote.status().serving!.listening}/v1`
    const linkFor = () => {
      const offer = m.remote.openTelegramOffer(verify)
      if (typeof offer === 'string') throw new Error(offer)
      // Through Tailscale this is the public address; here it's the same relay, locally.
      return offer.link.replace(encodeURIComponent('wss://mac.example.ts.net/v1'), encodeURIComponent(local))
    }

    await expect(telegramApp(() => launch(9009)).pair(linkFor())).rejects.toThrow('only works for the bot’s owner')
    await expect(telegramApp(() => undefined).pair(linkFor())).rejects.toThrow('only works for the bot’s owner')
    expect(m.remote.hasTelegramDevice()).toBe(false)

    const paired = await telegramApp(() => launch()).pair(linkFor())
    expect(paired.role).toBe('owner')
    expect(m.remote.hasTelegramDevice()).toBe(true)
    expect(m.remote.devices().map(d => [d.name, d.platform])).toEqual([['Telegram on iPhone', 'telegram-ios']])
  })

  test('turned off: no relay here, no app address', async () => {
    const m = servingMachine()
    await until(() => m.remote.status().connected)
    const port = m.remote.status().serving!.listening!
    m.setRemote({ serve: null, publicUrl: null })
    m.remote.apply()
    expect(m.remote.appUrl()).toBeNull()
    expect(m.remote.status().serving).toBeNull()
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })
})
