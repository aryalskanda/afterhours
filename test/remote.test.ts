// Remote access in the daemon, end to end through a real relay: an app pairs, syncs, queues
// tasks and answers requests, under the machine's own rules.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppClient, newIdentity, type Event, type HostSession, type MachineConnection, type Request, type Role, type Snapshot } from '@afterhours/protocol'
import { startRelay, type Relay } from '../relay/src/server'
import type { Chat, ChatSource } from '../src/daemon/chats'
import { runCommand } from '../src/daemon/commands'
import type { FolderMap } from '../src/daemon/folders'
import type { Notice } from '../src/daemon/notify'
import { Remote } from '../src/daemon/remote'
import { RemoteDb } from '../src/daemon/remote/db'
import { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
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

/** The conversations the fake machine has; tests add to it. */
let conversations: Chat[] = []
const chats: ChatSource = {
  list: () => conversations,
  recent: () => ({ chats: conversations, more: false }),
  get: id => conversations.find(c => c.sessionId === id) ?? null,
}
const folders = { search: async () => [] } as unknown as FolderMap

function machine() {
  const projects = join(dir, 'projects')
  const project = join(projects, 'shop')
  const outside = join(dir, 'elsewhere')
  mkdirSync(project, { recursive: true })
  mkdirSync(outside, { recursive: true })
  let config: Config = {
    ...DEFAULT_CONFIG,
    defaults: { ...DEFAULT_CONFIG.defaults, model: 'haiku' },
    remote: { ...DEFAULT_CONFIG.remote, enabled: true, relay: relay.url, name: 'build-box', allowedRoots: [projects] },
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
    git: { head: async () => null, diffStat: async () => null, worktree: async () => null, commitAll: async () => false },
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
    log: () => {},
    now: Date.now,
    identityPath: join(dir, 'identity.json'),
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
