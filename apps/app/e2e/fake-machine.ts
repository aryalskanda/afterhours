// A scripted machine for testing the app: a real protocol Host (encrypted sessions through a real
// relay) with made-up tasks, requests and chats. Tests and the end-to-end runs drive it; run it
// alone to try the app by hand:
//   bun apps/app/e2e/fake-machine.ts            prints a pairing link (and an Expo Go link)

import {
  Host,
  newIdentity,
  peerId,
  PROTOCOL,
  type Activity,
  type ApprovalInfo,
  type DiffFile,
  type TranscriptItem,
  type Event,
  type HostSession,
  type JobInfo,
  type MachineInfo,
  type Notice,
  type Request,
  type Result,
  type Role,
  type Snapshot,
} from '@afterhours/protocol'

const now = () => Date.now()

export function job(id: number, over: Partial<JobInfo> = {}): JobInfo {
  return {
    id,
    status: 'queued',
    phase: null,
    holdReason: null,
    folder: '/home/me/code/shop/web',
    workDir: null,
    prompt: 'Add a dark mode toggle to the settings page',
    plan: true,
    review: false,
    mode: 'auto',
    model: 'sonnet',
    effort: 'high',
    session: null,
    branch: null,
    isolate: true,
    summary: null,
    error: null,
    source: 'remote',
    position: id,
    createdAt: now() - 3_600_000,
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

export const SAMPLE_PLAN = `## Plan
1. Add a **theme** store with \`light\`, \`dark\` and \`system\`
2. Put a toggle in *Settings → Appearance*
3. Test it in both themes

| File | Change |
| --- | --- |
| src/theme.ts | new |
| src/settings/Appearance.tsx | toggle |`

/** A task's conversation as the transcript request gives it. `running`: the last tool hasn't answered. */
type WithoutIndex<T> = T extends unknown ? Omit<T, 'i'> : never

export function sampleTranscript(running: boolean): TranscriptItem[] {
  const at = now() - 11 * 60_000
  const items: WithoutIndex<TranscriptItem>[] = [
    { kind: 'you', at, text: 'Add a dark mode toggle to the settings page' },
    { kind: 'claude', at: at + 20_000, text: 'I’ll look at how the settings page is built first.' },
    { kind: 'tool', at: at + 30_000, id: 't1', name: 'Read', detail: 'src/settings/index.tsx', result: '     1→import { Group } from \'../ui\'\n     2→\n     3→export function Settings() {', error: false },
    { kind: 'tool', at: at + 40_000, id: 't2', name: 'Grep', detail: 'theme in src', result: 'src/theme.ts\nsrc/app.tsx', error: false },
    { kind: 'tool', at: at + 60_000, id: 't3', name: 'Edit', detail: 'src/settings/index.tsx', result: 'The file src/settings/index.tsx has been updated.', error: false },
    { kind: 'tool', at: at + 90_000, id: 't4', name: 'Bash', detail: 'npm test -- --watch=false', result: running ? null : 'Tests: 12 passed', error: false },
  ]
  if (!running) items.push({ kind: 'claude', at: at + 120_000, text: 'Done. The toggle is in **Settings → Appearance**.' })
  return items.map((item, i) => ({ ...item, i }) as TranscriptItem)
}

export const SAMPLE_CHANGES: DiffFile[] = [
  { path: 'src/settings/Appearance.tsx', status: 'added', added: 41, removed: 0, binary: false },
  { path: 'src/settings/index.tsx', status: 'modified', added: 3, removed: 1, binary: false },
  { path: 'src/theme.ts', status: 'added', added: 24, removed: 0, binary: false },
]

export const SAMPLE_PATCH = `diff --git a/src/settings/index.tsx b/src/settings/index.tsx
index 1a2b3c4..5d6e7f8 100644
--- a/src/settings/index.tsx
+++ b/src/settings/index.tsx
@@ -1,7 +1,9 @@ import
 import { Group } from '../ui'
+import { Appearance } from './Appearance'
 
 export function Settings() {
   return (
     <Group>
-      <Notifications />
+      <Notifications />
+      <Appearance />
     </Group>
`

export const SAMPLE_PREVIOUS_PLAN = `## Plan

1. Add a dark stylesheet
2. Check it by hand`

export const SAMPLE_ANSWER = `Done. The toggle is in **Settings → Appearance**.

- Theme store: \`src/theme.ts\`
- Tests: 12 passed

\`\`\`ts
export type Theme = 'light' | 'dark' | 'system'
\`\`\``

export interface FakeMachine {
  id: string
  name: string
  /** A fresh pairing link (approved automatically). */
  offer(role?: Role): string
  /** Every request apps sent, in order. */
  requests: Request[]
  /** Sends a notice to listening apps (and keeps it for those that catch up later). */
  emit(notice: Notice, text: string): Event
  /** Adds a request waiting on you, and announces it. */
  ask(approval: ApprovalInfo, notice: Notice, text: string): void
  state: { paused: boolean; active: JobInfo | null; queued: JobInfo[]; recent: JobInfo[]; approvals: ApprovalInfo[] }
  /** The next `n` answers fail, as when the machine is busy. */
  failAnswers(n: number): void
  /** Removes a device, as `cq devices remove` does. */
  removeDevice(id: string): void
  /** A tool call in the running task, to listening apps. */
  activity(a: Omit<Activity, 'type'>): void
  devices(): string[]
  stop(): void
}

export function fakeMachine(o: { relay: string; name?: string; sample?: boolean }): FakeMachine {
  const identity = newIdentity()
  const id = peerId(identity.publicKey)
  const name = o.name ?? 'build-box'
  const roles = new Map<string, Role>()
  const requests: Request[] = []
  const events: Event[] = []
  let seq = 0
  let nextJob = 20
  let failing = 0
  const state: FakeMachine['state'] = { paused: false, active: null, queued: [], recent: [], approvals: [] }
  const details = new Map<number, { plan: string | null; answer: string | null }>()

  if (o.sample !== false) {
    state.active = job(14, { status: 'running', phase: 'working', startedAt: now() - 12 * 60_000, branch: 'afterhours/14-dark-mode', contextPct: 38 })
    state.queued = [job(15, { prompt: 'Fix the flaky checkout test', folder: '/home/me/code/shop/api', mode: 'acceptEdits', plan: false })]
    state.recent = [
      job(12, {
        status: 'done',
        prompt: 'Add CSV export to reports',
        createdAt: now() - 7_500_000,
        startedAt: now() - 7_200_000,
        finishedAt: now() - 5_400_000,
        summary: 'Added CSV export',
        usage: { input: 3_100, output: 18_400, cacheRead: 1_240_000, cacheWrite: 96_000 },
        costUsd: 1.84,
        branch: 'afterhours/12-csv-export',
        session: '3f0c2a9e-0000-4000-8000-000000000012',
      }),
    ]
    details.set(12, { plan: SAMPLE_PLAN, answer: SAMPLE_ANSWER })
    details.set(14, { plan: SAMPLE_PLAN, answer: null })
  }

  const machine = (): MachineInfo => ({ id, name, os: 'Linux', arch: 'arm64', version: '0.2.0', protocol: PROTOCOL })
  const snapshot = (role: Role): Snapshot => ({
    type: 'snapshot',
    seq,
    machine: machine(),
    role,
    paused: state.paused,
    active: state.active,
    queued: state.queued,
    recent: state.recent,
    approvals: state.approvals,
    limits: { fiveHour: { usedPct: 62, resetsAt: now() + 5_400_000 }, sevenDay: { usedPct: 18, resetsAt: now() + 3 * 86_400_000 }, blockedUntil: null },
    policy: { allowedRoots: ['/home/me/code'], allowBypass: false, allowScreens: true, allowTyping: true },
    defaults: { plan: true, review: false, mode: 'auto', model: 'sonnet', effort: 'high', isolate: true },
    models: ['opus', 'sonnet', 'haiku'],
    features: ['transcript', 'timeline', 'diff', 'files', 'activity', 'peek.ansi', 'rules', 'plan.mode', 'queue.edit', 'schedule', 'budget', 'branch', 'open', 'attachments', 'commands', 'group'],
  })

  const host: Host = new Host({
    identity,
    relay: o.relay,
    machine,
    roleOf: device => roles.get(device) ?? null,
    devices: () => [...roles.keys()],
    onPaired: (device, role) => roles.set(device.id, role),
    onRequest: (session, request) => handle(session, request),
  })
  host.start()

  function reply(session: HostSession, request: Request, r: Omit<Result, 'type' | 'id'>): void {
    session.send({ type: 'result', id: request.id, ...r })
  }

  function emit(notice: Notice, text: string): Event {
    const event: Event = { type: 'event', seq: ++seq, at: now(), notice, text }
    events.push(event)
    host.broadcast(event)
    return event
  }

  function handle(session: HostSession, r: Request): void {
    requests.push(r)
    switch (r.type) {
      case 'sync':
        session.subscribed = true
        for (const e of events.filter(e => e.seq > (r.since ?? 0)).slice(-200)) session.send(e)
        session.send(snapshot(session.role))
        return reply(session, r, { ok: true })
      case 'snapshot':
        return reply(session, r, { ok: true, data: snapshot(session.role) })
      case 'task': {
        const j = state.active?.id === r.job ? state.active : [...state.queued, ...state.recent].find(x => x.id === r.job)
        if (!j) return reply(session, r, { ok: false, code: 'not-found', error: `No task #${r.job}.` })
        return reply(session, r, { ok: true, data: { job: j, ...(details.get(r.job) ?? { plan: null, answer: null }) } })
      }
      case 'answer': {
        if (failing > 0) {
          failing--
          return reply(session, r, { ok: false, code: 'failed', error: 'It failed on the machine: the queue is busy.' })
        }
        const a = state.approvals.find(x => x.code === r.code)
        if (!a) return reply(session, r, { ok: false, code: 'gone', error: `${r.code} was already answered.` })
        state.approvals = state.approvals.filter(x => x.code !== r.code)
        const status = r.decision === 'answer' ? 'answered' : r.decision === 'allow' ? 'allowed' : 'denied'
        emit({ type: 'resolved', code: r.code, job: a.job, status, by: session.hello.name }, `#${a.job}'s request ${r.code} was ${status}.`)
        return reply(session, r, { ok: true, text: status === 'answered' ? `Sent your answer to #${a.job}.` : `${status === 'allowed' ? '✅ Approved' : '❌ Declined'} #${a.job}'s request.` })
      }
      case 'queue': {
        if (!r.folder.startsWith('/home/me/code')) return reply(session, r, { ok: false, code: 'policy', error: `${r.folder} is outside the folders this machine lets apps use.` })
        const o = r.options ?? {}
        const j = job(++nextJob, {
          prompt: r.prompt,
          folder: r.folder,
          mode: o.mode ?? 'auto',
          model: o.model ?? 'sonnet',
          effort: o.effort ?? 'high',
          plan: o.plan ?? true,
          notBefore: o.atReset ? now() + 5_400_000 : (o.notBefore ?? null),
          afterJob: o.afterJob ?? null,
          repeatDaily: o.repeatDaily ?? null,
          maxMinutes: o.maxMinutes ?? null,
          attachments: o.attachments?.map(p => p.slice(p.lastIndexOf('/') + 1)) ?? null,
          group: o.group ?? null,
        })
        state.queued = [...state.queued, j]
        return reply(session, r, { ok: true, text: `Queued #${j.id}.`, data: { job: j } })
      }
      case 'folders': {
        const all = ['/home/me/code/shop/web', '/home/me/code/shop/api', '/home/me/code/notes']
        const hits = all.filter(p => !r.query || p.includes(r.query))
        return reply(session, r, { ok: true, data: hits.map(path => ({ path, name: path.split('/').pop(), isRepo: true })) })
      }
      case 'chats':
        return reply(session, r, {
          ok: true,
          data: {
            more: false,
            chats: [
              { session: '3f0c2a9e-0000-4000-8000-000000000001', folder: '/home/me/code/shop/web', title: 'Refactor the checkout', lastPrompt: 'Make the checkout faster', lastReply: 'I moved the **price lookup** out of the loop.', updatedAt: now() - 600_000, model: 'claude-sonnet-5-5', mode: 'auto', where: 'VS Code', busy: false, running: false, limited: false },
            ],
          },
        })
      case 'peek': {
        const text = r.ansi
          ? '\x1b[32m⏺\x1b[0m Editing \x1b[1msrc/theme.ts\x1b[22m\n  ⎿  Added \x1b[32m24\x1b[39m lines\n\n\x1b[38;5;208m✻\x1b[0m Working… \x1b[2m(2m 10s · esc to interrupt)\x1b[22m'
          : '⏺ Editing src/theme.ts\n  ⎿  Added 24 lines\n\n✻ Working… (2m 10s · esc to interrupt)'
        return reply(session, r, { ok: true, data: { job: state.active?.id ?? 0, text } })
      }
      case 'transcript': {
        const running = r.job !== undefined && state.active?.id === r.job
        const chat: TranscriptItem[] = [
          { kind: 'you', i: 0, at: now() - 900_000, text: 'Make the checkout faster' },
          { kind: 'tool', i: 1, at: now() - 890_000, id: 'c1', name: 'Read', detail: 'src/checkout.ts', result: 'export function total(items) {', error: false },
          { kind: 'claude', i: 2, at: now() - 880_000, text: 'I moved the **price lookup** out of the loop.' },
        ]
        const all = r.session ? chat : r.job === 15 ? [] : sampleTranscript(running)
        const limit = r.limit ?? 100
        const start = r.after !== undefined ? Math.max(0, r.after + 1) : Math.max(0, Math.min(r.before ?? all.length, all.length) - limit)
        const end = r.after !== undefined ? start + limit : Math.min(r.before ?? all.length, all.length)
        return reply(session, r, {
          ok: true,
          data: {
            session: '3f0c2a9e-0000-4000-8000-000000000001',
            items: all.slice(start, end),
            before: start > 0 ? start : null,
            total: all.length,
            usage: { input: 2_400, output: 9_800, cacheRead: 610_000, cacheWrite: 48_000 },
            cost: { usd: 0.92, linesAdded: 68, linesRemoved: 1 },
            updatedAt: now(),
          },
        })
      }
      case 'timeline':
        return reply(session, r, { ok: true, data: { events: events.filter(e => 'job' in e.notice && (typeof e.notice.job === 'number' ? e.notice.job : e.notice.job.id) === r.job) } })
      case 'diff': {
        if (r.file === undefined) return reply(session, r, { ok: true, data: { dir: '/home/me/code/shop/web', branch: 'afterhours/14-dark-mode', basis: 'exact', files: SAMPLE_CHANGES, truncated: false } })
        if (!SAMPLE_CHANGES.some(f => f.path === r.file)) return reply(session, r, { ok: false, code: 'not-found', error: `#${r.job} didn't change ${r.file}.` })
        return reply(session, r, { ok: true, data: { path: r.file, patch: SAMPLE_PATCH, binary: false, truncated: false } })
      }
      case 'upload':
        return reply(session, r, { ok: true, text: 'Uploaded.', data: { path: `/home/me/.afterhours/uploads/2026-10-16/ab12cd34-${r.name.replace(/[^A-Za-z0-9._-]+/g, '-')}` } })
      case 'commands':
        return reply(session, r, {
          ok: true,
          data: {
            commands: [
              { name: 'review', description: 'Review the diff for bugs', scope: 'project', kind: 'command' },
              { name: 'release-notes', description: 'Write release notes from the log', scope: 'user', kind: 'skill' },
            ],
          },
        })
      case 'jobs':
        return reply(session, r, { ok: true, data: { active: state.active, queued: state.queued, recent: state.recent } })
      case 'files': {
        if (session.role === 'viewer') return reply(session, r, { ok: false, code: 'forbidden', error: 'This device is a viewer here; that needs operator.' })
        if (r.query !== undefined) {
          const all = ['src/settings/index.tsx', 'src/settings/Appearance.tsx', 'src/theme.ts', 'README.md']
          const q = r.query.replace(/^\.$/, '').toLowerCase()
          return reply(session, r, { ok: true, data: { root: '/home/me/code/shop/web', path: '', entries: all.filter(p => p.toLowerCase().includes(q)).map(p => ({ name: p.split('/').pop(), path: p, kind: 'file', size: null })) } })
        }
        if (r.read) return reply(session, r, { ok: true, data: { root: '/home/me/code/shop/web', path: r.path, file: { path: r.path, kind: 'text', size: 120, text: "import { Group } from '../ui'\nimport { Appearance } from './Appearance'\n\nexport function Settings() {\n  return <Group><Appearance /></Group>\n}\n", truncated: false } } })
        return reply(session, r, { ok: true, data: { root: '/home/me/code/shop/web', path: r.path ?? '', entries: [{ name: 'src', path: 'src', kind: 'dir', size: null }] } })
      }
      case 'devices':
        return reply(session, r, { ok: true, data: [...roles.entries()].map(([device, role]) => ({ id: device, name: device === session.device ? session.hello.name : 'Another device', platform: 'test', role, addedAt: now(), lastSeen: now() })) })
      case 'devices.remove':
        roles.delete(r.device)
        host.unlink(r.device)
        return reply(session, r, { ok: true, text: 'Removed.' })
      case 'job': {
        const j = state.queued.find(x => x.id === r.job)
        if (r.action === 'top' || r.action === 'remove') {
          if (r.action === 'remove') state.queued = state.queued.filter(x => x.id !== r.job)
          return reply(session, r, { ok: true, text: r.action === 'top' ? `#${r.job} is next.` : `Removed #${r.job}.` })
        }
        if (!j) return reply(session, r, { ok: false, code: 'gone', error: `#${r.job} isn't waiting in the queue.` })
        if (r.action === 'move') {
          const rest = state.queued.filter(x => x.id !== r.job)
          rest.splice(Math.min(r.to ?? 0, rest.length), 0, j)
          state.queued = rest
          return reply(session, r, { ok: true, text: `#${r.job} moved.` })
        }
        const edited = { ...j, ...(r.prompt ? { prompt: r.prompt } : {}), ...(r.options?.model ? { model: r.options.model } : {}), ...(r.options?.effort ? { effort: r.options.effort } : {}) }
        state.queued = state.queued.map(x => (x.id === r.job ? edited : x))
        return reply(session, r, { ok: true, text: `Changed #${r.job}.`, data: { job: edited } })
      }
      case 'branch':
        return reply(session, r, { ok: true, text: r.action === 'merge' ? 'Merged afterhours/12-csv-export into main.' : r.action === 'discard' ? 'Threw away afterhours/12-csv-export.' : 'Opened https://github.com/me/shop/pull/7' })
      case 'open':
        return reply(session, r, { ok: true, text: `Opened in VS Code on ${name}.` })
      case 'command':
        return reply(session, r, { ok: true, text: r.text === 'help' ? 'Commands: status, q <folder>: <prompt>, go, pause, stop, skip, limits' : `Did ${r.text}.` })
      case 'control':
        if (r.action === 'pause') state.paused = true
        if (r.action === 'go') state.paused = false
        return reply(session, r, { ok: true, text: `Did ${r.action}.` })
      default:
        return reply(session, r, { ok: true, text: `Did ${r.type}.` })
    }
  }

  return {
    id,
    name,
    requests,
    state,
    emit,
    offer: (role = 'owner') => host.openOffer({ role, autoApprove: true }).link,
    ask(approval, notice, text) {
      state.approvals = [...state.approvals, approval]
      emit(notice, text)
    },
    failAnswers(n) {
      failing = n
    },
    removeDevice(device) {
      roles.delete(device)
      host.unlink(device)
    },
    activity(a) {
      host.broadcast({ type: 'activity', ...a })
    },
    devices: () => [...roles.keys()],
    stop: () => host.stop(),
  }
}

/** The sample requests the end-to-end runs answer: a permission, three questions, a plan. */
export function askSamples(m: FakeMachine): void {
  const active = m.state.active ?? job(14, { status: 'running', phase: 'working' })
  const at = now()
  m.ask(
    {
      code: 'perma',
      job: active.id,
      kind: 'permission',
      tool: 'Bash',
      detail: 'npm test -- --watch=false\n(Run the tests once)',
      payload: null,
      createdAt: at,
      expiresAt: at + 15 * 60_000,
      suggestions: [{ label: 'Always allow commands starting with npm test in this project' }],
      allowedBefore: 14,
    },
    {
      type: 'permission',
      job: active,
      code: 'perma',
      tool: 'Bash',
      detail: 'npm test -- --watch=false\n(Run the tests once)',
      minutes: 15,
      suggestions: ['Always allow commands starting with npm test in this project'],
      allowedBefore: 14,
    },
    `🔐 #${active.id} wants to use Bash`,
  )
  const questions = [
    { question: 'How should the engine run on Windows?', header: 'Windows', options: [{ label: 'WSL2 first (Recommended)', description: 'The Linux build runs inside WSL2 unchanged, so Windows works from day one.' }, { label: 'Native Windows now', description: 'Replace tmux with a Windows terminal layer; a lot more work first.' }] },
    { question: 'Which platforms first?', multiSelect: true, options: [{ label: 'iPhone' }, { label: 'Android' }, { label: 'Desktop' }] },
    { question: 'What should the relay be called?', options: [{ label: 'relay' }, { label: 'bridge' }] },
  ]
  m.ask(
    { code: 'quest', job: active.id, kind: 'question', questions, payload: null, createdAt: at + 1, expiresAt: at + 15 * 60_000 + 1 },
    { type: 'question', job: active, code: 'quest', questions, minutes: 15 },
    `❓ #${active.id} asks`,
  )
  m.ask(
    { code: 'revie', job: 15, kind: 'review', plan: SAMPLE_PLAN, previousPlan: SAMPLE_PREVIOUS_PLAN, payload: null, createdAt: at + 2 },
    { type: 'plan_review', job: job(15, { status: 'held', prompt: 'Fix the flaky checkout test' }), code: 'revie', plan: SAMPLE_PLAN, previousPlan: SAMPLE_PREVIOUS_PLAN },
    '📝 #15 plan ready for your review',
  )
}

if (import.meta.main) {
  const { startRelay } = await import('../../../relay/src/server')
  const relay = startRelay({ port: Number(process.env.PORT ?? 8799), hostname: '0.0.0.0' })
  const m = fakeMachine({ relay: relay.url })
  await Bun.sleep(300)
  askSamples(m)
  const link = m.offer()
  console.log(`Pairing link:\n${link}\n`)
  // The same fields as the link itself, as the phone's camera hands them to the app.
  const fields = link.slice(link.indexOf('?') + 1)
  console.log(`In Expo Go on the iPhone simulator:\nexp://127.0.0.1:8081/--/pair?${fields}\n`)
  console.log(`In Expo Go on the Android emulator:\nexp://10.0.2.2:8081/--/pair?${fields.replace('127.0.0.1', '10.0.2.2')}\n`)
  console.log('Ctrl-C to stop.')
}
