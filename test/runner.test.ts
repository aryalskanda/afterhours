import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Notice } from '../src/daemon/notify'
import { canTakeOver, Runner, windowName, type ToolActivity } from '../src/daemon/runner'
import { sessionSettings } from '../src/daemon/launch'
import type { LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import type { JobSpec } from '../src/shared/types'
import type { Procs } from '../src/daemon/procs'
import { FakeTmux } from './fakes'
import { PLAN_SCREEN, TRUST_SCREEN, TRUST_SCREEN_YES } from './fixtures'

function setup(timeouts: Partial<Config['timeouts']> = {}, opts: { gitRepo?: boolean; procs?: Procs; slowSnapshot?: Promise<void> } = {}) {
  let now = Date.UTC(2026, 9, 14, 14, 0)
  const project = mkdtempSync(join(tmpdir(), 'cq-run-'))
  const gitCalls: string[] = []
  const logs: string[] = []
  let config: Config = {
    ...DEFAULT_CONFIG,
    aliases: { proj: project },
    trustedDirs: [],
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...timeouts },
  }
  const store = new Store(':memory:')
  const tmux = new FakeTmux()
  const notices: Notice[] = []
  const files = new Map<string, string>()
  let holders: LiveSession[] = []
  const killed: number[] = []
  const reopened: string[] = []
  const activity: ToolActivity[] = []
  /** Windows that ignore being asked to close. */
  let stubborn = false
  /** The folders apps may use, besides the task's own. */
  const allowed: string[] = []
  const runner = new Runner({
    store,
    tmux,
    notify: n => notices.push(n),
    config: () => config,
    saveConfig: c => {
      config = c
    },
    now: () => now,
    allowedDir: dir => allowed.some(a => dir === a || dir.startsWith(`${a}/`)),
    claudePath: '/bin/claude',
    selfCommand: ['/bin/cq'],
    port: 7787,
    home: '/tmp/cqhome',
    jobsDir: '/tmp/cqhome/jobs',
    scripts: { hook: '/tmp/cqhome/bin/cq-hook', status: '/tmp/cqhome/bin/cq-statusline' },
    writeFile: (p, t) => files.set(p, t),
    sessionHolders: id => holders.filter(h => h.sessionId === id),
    git: {
      head: async () => 'abc123',
      diffStat: async () => '1 file changed, 1 insertion(+)',
      worktree: async (_dir, id) => {
        gitCalls.push(`worktree #${id}`)
        if (!opts.gitRepo) return null
        const dir = join(project, '.claude', 'worktrees', `afterhours-${id}`)
        mkdirSync(dir, { recursive: true })
        return { dir, branch: `afterhours/${id}-task`, base: 'abc123' }
      },
      commitAll: async (dir, message) => {
        gitCalls.push(`commit ${dir} ${message}`)
        return true
      },
      snapshot: async dir => {
        if (opts.slowSnapshot) await opts.slowSnapshot
        gitCalls.push(`snapshot ${dir}`)
        return opts.gitRepo ? `tree-${gitCalls.filter(c => c.startsWith('snapshot')).length}` : null
      },
    },
    killPid: pid => {
      killed.push(pid)
      if (!stubborn) holders = holders.filter(h => h.pid !== pid)
    },
    log: line => logs.push(line),
    sleep: async () => {},
    reopenInVsCode: sid => reopened.push(sid),
    activity: a => activity.push(a),
    uploadsDir: '/tmp/cqhome/uploads',
    procs: opts.procs,
  })
  const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
    projectDir: project,
    prompt: 'Create hello.txt',
    plan: true,
    review: false,
    execMode: 'auto',
    model: 'haiku',
    effort: 'low',
    sessionPolicy: 'continue',
    source: 'cli',
    ...over,
  })
  return {
    runner,
    store,
    tmux,
    notices,
    files,
    project,
    gitCalls,
    logs,
    spec,
    config: () => config,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    setHolders: (h: LiveSession[]) => {
      holders = h
    },
    killed,
    reopened,
    activity,
    allowed,
    setStubborn: (v: boolean) => {
      stubborn = v
    },
  }
}

type Harness = ReturnType<typeof setup>

/** Queues a job, launches it, and plays the hooks Claude Code fires when it starts. */
async function startJob(h: Harness, over: Partial<JobSpec> = {}) {
  const job = h.runner.enqueue(h.spec(over))
  await h.runner.tick()
  const sid = h.store.getJob(job.id)!.sessionId!
  await h.runner.onHook('SessionStart', job.id, { session_id: sid, transcript_path: '/tmp/t.jsonl' })
  await h.runner.onHook('UserPromptSubmit', job.id, { session_id: sid, permission_mode: over.plan === false ? 'auto' : 'plan' })
  return { id: job.id, sid, window: h.tmux.windows.get(windowName(job.id))! }
}

/** Plays a normal end of turn through to the window closing. */
async function finishTurn(h: Harness, j: Awaited<ReturnType<typeof startJob>>) {
  await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: 'All done.' })
  h.advance(2000)
  await h.runner.tick()
  j.window.dead = true
  await h.runner.tick()
}

function lastNotice<T extends Notice['type']>(h: Harness, type: T): Extract<Notice, { type: T }> {
  const n = [...h.notices].reverse().find(x => x.type === type)
  if (!n) throw new Error(`no ${type} notice in ${h.notices.map(x => x.type).join(', ')}`)
  return n as Extract<Notice, { type: T }>
}

describe('launch', () => {
  test('the log records how a job started but never its prompt', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec({ prompt: 'Rotate the secret staging keys' }))
    await h.runner.tick()
    const line = h.logs.find(l => l.startsWith(`launched #${job.id}:`))!
    expect(line).toContain('--model haiku --effort low --permission-mode plan')
    expect(line).not.toContain('Rotate')
    expect(line).not.toContain('--name')
  })

  test('a plan job starts in plan mode with session-only settings', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec())
    await h.runner.tick()
    const w = h.tmux.windows.get(windowName(job.id))!
    expect(w.argv).toEqual(['/bin/cq', 'launch', String(job.id)])
    expect(w.env).toEqual({ CQ_JOB_ID: String(job.id), CQ_PORT: '7787', CQ_HOME: '/tmp/cqhome' })
    const sid = h.store.getJob(job.id)!.sessionId!
    expect(h.runner.launchSpec(job.id)!.argv).toEqual([
      '/bin/claude',
      '--session-id',
      sid,
      '--model',
      'haiku',
      '--effort',
      'low',
      '--permission-mode',
      'plan',
      '--settings',
      '/tmp/cqhome/jobs/1.settings.json',
      '--name',
      'Afterhours: Create hello.txt',
      '--',
      'Create hello.txt',
    ])
    const settings = JSON.parse(h.files.get('/tmp/cqhome/jobs/1.settings.json')!)
    expect(settings.autoContinueAtUsageLimit).toBe(true)
    expect(settings.hooks.PermissionRequest[0].hooks[0]).toEqual({ type: 'command', command: "'/tmp/cqhome/bin/cq-hook' PermissionRequest", timeout: 960 })
    expect(settings.hooks.PostToolUse[0].hooks[0].async).toBe(true)
    expect(h.notices.map(n => n.type)).toEqual(['started'])
  })

  test('yolo jobs get bypass available and its warning pre-accepted', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec({ plan: false, execMode: 'bypassPermissions' }))
    await h.runner.tick()
    const argv = h.runner.launchSpec(job.id)!.argv
    expect(argv).toContain('--allow-dangerously-skip-permissions')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(JSON.parse(h.files.get(`/tmp/cqhome/jobs/${job.id}.settings.json`)!).skipDangerousModePermissionPrompt).toBe(true)
  })

  test('nothing starts while paused or before a limit resets', async () => {
    const h = setup()
    h.runner.enqueue(h.spec())
    h.runner.setPaused(true)
    await h.runner.tick()
    expect(h.tmux.windows.size).toBe(0)
    h.runner.setPaused(false)
    h.store.kvSet('limits', { blockedUntil: h.now() + 60_000 })
    await h.runner.tick()
    expect(h.tmux.windows.size).toBe(0)
    h.advance(61_000)
    await h.runner.tick()
    expect(h.tmux.windows.size).toBe(1)
  })
})

describe('plan → execute → next job', () => {
  test('approves the plan dialog, finishes, and the next job continues the conversation', async () => {
    const h = setup()
    const first = await startJob(h)
    const next = h.runner.enqueue(h.spec({ plan: false, prompt: 'Append a line' }))

    const r = await h.runner.onHook('PermissionRequest', first.id, {
      tool_name: 'ExitPlanMode',
      permission_mode: 'plan',
      tool_input: { plan: 'Create hello.txt with hi' },
    })
    expect(r).toEqual({}) // plans are approved with keystrokes, not by the hook
    first.window.screen = PLAN_SCREEN
    await h.runner.tick()
    expect(first.window.input).toEqual(['1'])

    first.window.screen = '⏺ Write(hello.txt)'
    h.advance(5000)
    await h.runner.tick()
    expect(h.store.getJob(first.id)!.planApproved).toBe(true)
    expect(lastNotice(h, 'plan_approved').choice).toBe('Yes, and use auto mode')
    expect(lastNotice(h, 'plan_approved').job.planText).toBe('Create hello.txt with hi')

    expect(await h.runner.onHook('Stop', first.id, { permission_mode: 'auto', last_assistant_message: 'Created hello.txt' })).toEqual({})
    h.advance(2000)
    await h.runner.tick()
    expect(first.window.input.slice(-2)).toEqual(['text:/exit', 'Enter'])
    first.window.dead = true
    await h.runner.tick()
    const done = h.store.getJob(first.id)!
    expect(done.status).toBe('done')
    expect(done.lastMessage).toBe('Created hello.txt')
    expect(lastNotice(h, 'done')).toMatchObject({ diff: '1 file changed, 1 insertion(+)' })
    expect(lastNotice(h, 'done').next?.id).toBe(next.id)

    await h.runner.tick()
    const argv = h.runner.launchSpec(next.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', first.sid])
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
    expect(argv).not.toContain('--name')
  })

  test('the hook seeing auto mode before the next tick still announces the approval', async () => {
    const h = setup()
    const j = await startJob(h)
    j.window.screen = PLAN_SCREEN
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'p' } })
    await h.runner.tick()
    await h.runner.onHook('PostToolUse', j.id, { permission_mode: 'auto', tool_name: 'Write', tool_input: { file_path: '/x' } })
    expect(h.store.getJob(j.id)!.planApproved).toBe(true)
    expect(lastNotice(h, 'plan_approved').choice).toBe('Yes, and use auto mode')
  })

  test('a mode the dialog lacks is switched to on the next permission prompt', async () => {
    const h = setup()
    const j = await startJob(h, { execMode: 'acceptEdits' })
    j.window.screen = PLAN_SCREEN
    await h.runner.tick()
    expect(j.window.input).toEqual(['2'])
    j.window.screen = ''
    h.advance(5000)
    await h.runner.tick()
    const r = await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Edit', permission_mode: 'default', tool_input: { file_path: '/x' } })
    expect(r).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      },
    })
  })

  test('a plan job that stops without a plan is nudged twice, then held', async () => {
    const h = setup()
    const j = await startJob(h)
    expect(await h.runner.onHook('Stop', j.id, { permission_mode: 'plan' })).toMatchObject({ decision: 'block' })
    expect(await h.runner.onHook('Stop', j.id, { permission_mode: 'plan' })).toMatchObject({ decision: 'block' })
    expect(await h.runner.onHook('Stop', j.id, { permission_mode: 'plan' })).toEqual({})
    expect(h.store.getJob(j.id)!.status).toBe('held')
    expect(lastNotice(h, 'held').reason).toContain('without presenting a plan')
  })

  test('background work keeps the job open until Claude ends a turn without any', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', background_tasks: [{ type: 'subagent', status: 'running' }] })
    h.advance(15 * 60_000)
    await h.runner.tick()
    expect(j.window.input).toEqual([]) // subagents always finish: no time limit
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', background_tasks: [] })
    h.advance(2000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['text:/exit', 'Enter'])
  })

  test('background commands a continued conversation started before the task don’t hold it open', async () => {
    const h = setup({ backgroundSec: 600 })
    const j = await startJob(h, { plan: false })
    const at = (ms: number) => new Date(h.now() + ms).toISOString()
    const transcript = join(h.project, 'transcript.jsonl')
    const lines = [
      // Before the task: a dev server, still running.
      { type: 'assistant', timestamp: at(-3_600_000), message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun dev' } }] } },
      { type: 'user', timestamp: at(-3_600_000), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bold1' }] } },
      // The task's own turn, which started nothing.
      { type: 'assistant', timestamp: at(1000), message: { id: 'm2', content: [{ type: 'text', text: 'Answered.' }] } },
    ]
    writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid, transcript_path: transcript })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', background_tasks: [{ id: 'bold1', type: 'shell', status: 'running' }] })
    h.advance(2000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['text:/exit', 'Enter'])
    expect(h.logs.some(l => l.includes('not waiting on 1 background command started before it'))).toBe(true)
  })

  test('background commands the task started itself are waited on', async () => {
    const h = setup({ backgroundSec: 600 })
    const j = await startJob(h, { plan: false })
    const transcript = join(h.project, 'transcript.jsonl')
    const at = new Date(h.now() + 1000).toISOString()
    const lines = [
      { type: 'assistant', timestamp: at, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }] } },
      { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bnew1' }] } },
    ]
    writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid, transcript_path: transcript })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', background_tasks: [{ id: 'bnew1', type: 'shell', status: 'running' }] })
    h.advance(2000)
    await h.runner.tick()
    expect(j.window.input).toEqual([])
  })

  test('a background command that never ends (a dev server) is given up on after the wait', async () => {
    const h = setup({ backgroundSec: 600 })
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', background_tasks: [{ type: 'shell', status: 'running' }] })
    h.advance(9 * 60_000)
    await h.runner.tick()
    expect(j.window.input).toEqual([])
    h.advance(2 * 60_000)
    await h.runner.tick() // wait over: start finishing
    h.advance(2000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['text:/exit', 'Enter'])
  })
})

describe('own branch (worktree) isolation', () => {
  test('a new conversation runs in its own worktree and its work is committed there', async () => {
    const h = setup({}, { gitRepo: true })
    const j = await startJob(h, { plan: false, isolate: true, prompt: 'Add dark mode' })
    const job = h.store.getJob(j.id)!
    const worktree = join(h.project, '.claude', 'worktrees', `afterhours-${j.id}`)
    expect(job).toMatchObject({ workDir: worktree, branch: `afterhours/${j.id}-task` })
    expect(h.runner.launchSpec(j.id)!.cwd).toBe(worktree)
    expect(h.tmux.windows.get(windowName(j.id))!.cwd).toBe(worktree)
    await finishTurn(h, j)
    // The folder is snapshotted when the task starts and after its work is committed, for its diff.
    expect(h.gitCalls).toEqual([`worktree #${j.id}`, `snapshot ${worktree}`, `commit ${worktree} Afterhours #${j.id}: Add dark mode`, `snapshot ${worktree}`])
    expect(h.store.getJob(j.id)).toMatchObject({ startTree: 'tree-1', endTree: 'tree-2' })
    expect(lastNotice(h, 'done').job.branch).toBe(`afterhours/${j.id}-task`)
  })

  test('a follow-up continues in the same worktree without making another, and commits there', async () => {
    const h = setup({}, { gitRepo: true })
    const first = await startJob(h, { plan: false, isolate: true })
    await finishTurn(h, first)
    const second = await startJob(h, { plan: false, isolate: true, prompt: 'And add tests' })
    const worktree = join(h.project, '.claude', 'worktrees', `afterhours-${first.id}`)
    const spec = h.runner.launchSpec(second.id)!
    expect(spec.argv.slice(1, 3)).toEqual(['--resume', first.sid])
    expect(spec.cwd).toBe(worktree)
    expect(h.gitCalls.filter(c => c.startsWith('worktree'))).toEqual([`worktree #${first.id}`])
    await finishTurn(h, second)
    expect(h.gitCalls.filter(c => c.startsWith('commit')).at(-1)).toBe(`commit ${worktree} Afterhours #${second.id}: And add tests`)
    expect(lastNotice(h, 'done').job.branch).toBe(`afterhours/${first.id}-task`)
  })

  test('following up a branch task by its conversation (➕ Follow up) runs on that branch', async () => {
    const h = setup({}, { gitRepo: true })
    const first = await startJob(h, { plan: false, isolate: true })
    await finishTurn(h, first)
    // Another task takes over the folder's default conversation in the meantime.
    const other = await startJob(h, { plan: false, isolate: false, sessionPolicy: 'new' })
    await finishTurn(h, other)
    const followUp = await startJob(h, { plan: false, isolate: true, sessionPolicy: 'session', sessionId: first.sid })
    const worktree = join(h.project, '.claude', 'worktrees', `afterhours-${first.id}`)
    expect(h.runner.launchSpec(followUp.id)!.cwd).toBe(worktree)
    expect(h.store.getJob(followUp.id)).toMatchObject({ workDir: worktree, branch: `afterhours/${first.id}-task` })
    await finishTurn(h, followUp)
    expect(h.gitCalls.filter(c => c.startsWith('commit')).at(-1)).toBe(`commit ${worktree} Afterhours #${followUp.id}: Create hello.txt`)
  })

  test('if you removed the worktree, the next task starts a fresh conversation', async () => {
    const h = setup({}, { gitRepo: true })
    const first = await startJob(h, { plan: false, isolate: true })
    await finishTurn(h, first)
    rmSync(join(h.project, '.claude', 'worktrees', `afterhours-${first.id}`), { recursive: true })
    const second = await startJob(h, { plan: false, isolate: true })
    expect(second.sid).not.toBe(first.sid)
    expect(h.runner.launchSpec(second.id)!.cwd).toBe(join(h.project, '.claude', 'worktrees', `afterhours-${second.id}`))
  })

  test('outside a git repo it runs in place', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, isolate: true })
    expect(h.store.getJob(j.id)).toMatchObject({ workDir: null, branch: null })
    expect(h.runner.launchSpec(j.id)!.cwd).toBe(h.project)
    await finishTurn(h, j)
    expect(h.gitCalls.some(c => c.startsWith('commit'))).toBe(false)
  })
})

describe('usage limits', () => {
  test('waits for the reset, then types continue if Claude Code did not', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    const reset = h.now() + 60 * 60_000
    h.runner.onStatusline(j.id, { rate_limits: { five_hour: { used_percentage: 100, resets_at: reset / 1000 } } })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 11am" })
    expect(h.store.getJob(j.id)!.phase).toBe('limited')
    expect(lastNotice(h, 'limit')).toMatchObject({ at: reset, window: 'five_hour' })
    expect(h.runner.limits().blockedUntil).toBe(reset)

    h.advance(61 * 60_000) // past the reset, inside the grace period
    await h.runner.tick()
    expect(j.window.input).toEqual([])
    h.advance(3 * 60_000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['Escape', 'text:continue', 'Enter'])

    await h.runner.onHook('UserPromptSubmit', j.id, { permission_mode: 'auto' })
    expect(h.store.getJob(j.id)!.phase).toBe('working')
    expect(lastNotice(h, 'resumed').how).toBe('afterhours')
    expect(h.runner.limits().blockedUntil).toBeNull()
    expect(h.logs.some(l => l.includes(`#${j.id}: running again after the usage limit (restarted by Afterhours)`))).toBe(true)
  })

  test('task #3: reset only in the message, Kathmandu time; nothing until due, then continue, restart, hold', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    // 18:48 in Kathmandu (UTC+5:45) = 13:03 UTC; resets 7:35 PM = 13:50 UTC; continue due at 13:53.
    const stop = Date.UTC(2026, 9, 14, 13, 3)
    h.advance(stop - h.now())
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 7:35pm (Asia/Katmandu)" })
    const reset = Date.UTC(2026, 9, 14, 13, 50)
    expect(lastNotice(h, 'limit').at).toBe(reset)
    expect(h.logs.some(l => l.includes('types continue at 2026-10-14T13:53:00.000Z'))).toBe(true)
    for (let t = 0; t < 49; t++) {
      h.advance(60_000)
      await h.runner.tick()
    }
    expect(j.window.input).toEqual([]) // 13:52: still waiting
    h.advance(60_000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['Escape', 'text:continue', 'Enter']) // 13:53
    h.advance(61_000)
    await h.runner.tick()
    expect(h.store.getJob(j.id)!.launches).toBe(2) // typing didn't take: restarted with continue
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid })
    h.advance(121_000)
    await h.runner.tick()
    expect(h.store.getJob(j.id)).toMatchObject({ status: 'held', holdReason: "couldn't continue after the limit reset" })
  })

  test('you typing into it ends the wait: the notice says so', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', error_details: 'resets in 1h' })
    h.advance(61 * 60_000)
    expect(await h.runner.say('continue')).toBe(`Typed into #${j.id}.`)
    await h.runner.onHook('UserPromptSubmit', j.id, { permission_mode: 'auto' })
    expect(lastNotice(h, 'resumed').how).toBe('you')
  })

  test('continue now: tries right away instead of waiting for the reset', async () => {
    const h = setup()
    expect(await h.runner.continueNow()).toBe('Nothing is waiting for a usage limit.')
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', error_details: 'resets in 3h' })
    await h.runner.tick()
    expect(j.window.input).toEqual([])
    expect(await h.runner.go()).toBe(`Trying #${j.id} again now.`)
    await h.runner.tick()
    expect(j.window.input).toEqual(['Escape', 'text:continue', 'Enter'])
  })

  test('continue now with no task waiting lets the next task start before the reset', async () => {
    const h = setup()
    h.store.kvSet('limits', { blockedUntil: h.now() + 3_600_000 })
    h.runner.enqueue(h.spec())
    await h.runner.tick()
    expect(h.tmux.windows.size).toBe(0)
    expect(await h.runner.continueNow()).toBe("The queue won't wait for the reset any more; the next task starts now.")
    await h.runner.tick()
    expect(h.tmux.windows.size).toBe(1)
  })

  test('a supervision pass that hangs is reported in the log', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    let release = () => {}
    h.tmux.pane = () => new Promise(resolve => (release = () => resolve({ dead: false, deadStatus: null, pid: 1 })))
    const first = h.runner.tick()
    h.advance(61_000)
    await h.runner.tick()
    expect(h.logs.some(l => l.startsWith('supervision has been stuck for'))).toBe(true)
    release()
    await first
    expect(j.id).toBeGreaterThan(0)
  })

  test("Claude Code's own auto-continue clears the limit without typing", async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', error_details: 'resets in 1h' })
    h.advance(61 * 60_000)
    await h.runner.onHook('Notification', j.id, { notification_type: 'quota_auto_resume_fired' })
    expect(lastNotice(h, 'resumed').how).toBe('claude')
    await h.runner.tick()
    expect(j.window.input).toEqual([])
  })

  test('if typing continue does not take, the session is restarted with continue', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit', error_details: 'resets in 10m' })
    h.advance(14 * 60_000)
    await h.runner.tick()
    expect(j.window.input).toEqual(['Escape', 'text:continue', 'Enter'])
    h.advance(61_000)
    await h.runner.tick()
    const argv = h.runner.launchSpec(j.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', j.sid])
    expect(argv.at(-1)).toBe('continue')
    expect(h.store.getJob(j.id)!.launches).toBe(2)
  })

  test('only the first limit hit is announced', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit' })
    await h.runner.onHook('StopFailure', j.id, { error: 'rate_limit' })
    expect(h.notices.filter(n => n.type === 'limit')).toHaveLength(1)
  })
})

describe('asking you', () => {
  test('relays a permission request and returns your answer', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, execMode: 'acceptEdits' })
    const pending = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', tool_input: { command: 'python3 -c "print(1)"' } })
    await Bun.sleep(0)
    const notice = lastNotice(h, 'permission')
    expect(notice).toMatchObject({ tool: 'Bash', detail: 'python3 -c "print(1)"', minutes: 15 })
    expect(h.runner.answer(notice.code, 'allow', null)).toBe(`✅ Approved #${j.id}'s request.`)
    expect(await pending).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(h.runner.answer(notice.code, 'allow', null)).toBe(`${notice.code} was already allowed.`)
  })

  test('while a plan task is still planning, a change is answered at once: present the plan', async () => {
    const h = setup()
    const j = await startJob(h) // plan first, review off, still in plan mode
    const before = h.notices.length
    for (const tool of ['Edit', 'Write', 'mcp__notion__update-page']) {
      const r = (await h.runner.onHook('PermissionRequest', j.id, { tool_name: tool, permission_mode: 'plan', tool_input: { file_path: '/x' } })) as { hookSpecificOutput: { decision: { behavior: string; message: string } } }
      expect(r.hookSpecificOutput.decision.behavior).toBe('deny')
      expect(r.hookSpecificOutput.decision.message).toContain('ExitPlanMode')
      expect(r.hookSpecificOutput.decision.message).toContain('approved automatically')
    }
    // Nothing went to your phone.
    expect(h.notices.length).toBe(before)
    expect(h.store.pendingApprovals(j.id)).toEqual([])
    expect(h.logs.some(l => l.includes('Edit while planning'))).toBe(true)
  })

  test('the same, saying you review the plan when you asked to', async () => {
    const h = setup()
    const j = await startJob(h, { review: true })
    const r = (await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Edit', permission_mode: 'plan', tool_input: { file_path: '/x' } })) as { hookSpecificOutput: { decision: { message: string } } }
    expect(r.hookSpecificOutput.decision.message).toContain('The user reviews it')
  })

  const allowedAnswer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

  test('a task in auto mode reads files in the folders apps may use without asking, planning or working', async () => {
    const h = setup()
    h.allowed.push('/other/app')
    const j = await startJob(h)
    const before = h.notices.length
    // Planning, a file in the task's own folder, then one in another allowed folder.
    expect(await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Read', permission_mode: 'plan', tool_input: { file_path: join(h.project, 'src', 'a.ts') } })).toEqual(allowedAnswer)
    expect(await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Read', permission_mode: 'auto', tool_input: { file_path: '/other/app/e2e/out/shot.png' } })).toEqual(allowedAnswer)
    // Glob and Grep with no path search the task's own folder; with one, that folder.
    for (const tool of ['Glob', 'Grep']) {
      expect(await h.runner.onHook('PermissionRequest', j.id, { tool_name: tool, permission_mode: 'auto', tool_input: { pattern: 'x' } })).toEqual(allowedAnswer)
      expect(await h.runner.onHook('PermissionRequest', j.id, { tool_name: tool, permission_mode: 'auto', tool_input: { pattern: 'x', path: '/other/app/src' } })).toEqual(allowedAnswer)
    }
    // Nothing went to the phone, and each is in the log.
    expect(h.notices.length).toBe(before)
    expect(h.store.pendingApprovals(j.id)).toEqual([])
    expect(h.logs.some(l => l.includes('allowed Read of /other/app/e2e/out/shot.png'))).toBe(true)
  })

  test('the web is read without asking in a mode that doesn’t ask', async () => {
    const h = setup()
    const j = await startJob(h)
    for (const tool of ['WebFetch', 'WebSearch']) {
      expect(await h.runner.onHook('PermissionRequest', j.id, { tool_name: tool, permission_mode: 'auto', tool_input: { url: 'https://example.com' } })).toEqual(allowedAnswer)
    }
  })

  test('a file outside the folders apps may use, a relative path out of the folder, and other tools still ask', async () => {
    const h = setup()
    const j = await startJob(h)
    for (const input of [{ file_path: '/Users/me/.ssh/id_ed25519' }, { file_path: '../../etc/passwd' }]) {
      const asked = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Read', permission_mode: 'auto', tool_input: input })
      await Bun.sleep(0)
      expect(lastNotice(h, 'permission')).toMatchObject({ tool: 'Read' })
      h.runner.answer(lastNotice(h, 'permission').code, 'deny', null)
      await asked
    }
    const bash = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', permission_mode: 'auto', tool_input: { command: 'rm -rf build' } })
    await Bun.sleep(0)
    expect(lastNotice(h, 'permission')).toMatchObject({ tool: 'Bash' })
    h.runner.answer(lastNotice(h, 'permission').code, 'deny', null)
    await bash
  })

  test('commands while planning still ask', async () => {
    const h = setup()
    const j = await startJob(h)
    const bash = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', permission_mode: 'plan', tool_input: { command: 'ls' } })
    await Bun.sleep(0)
    expect(lastNotice(h, 'permission')).toMatchObject({ tool: 'Bash' })
    h.runner.answer(lastNotice(h, 'permission').code, 'allow', null)
    await bash
  })

  test('while planning, a mode that asks for edits asks for reads too, as before', async () => {
    const h = setup()
    h.allowed.push('/x')
    const careful = await startJob(h, { execMode: 'acceptEdits' })
    const asked = h.runner.onHook('PermissionRequest', careful.id, { tool_name: 'Read', permission_mode: 'plan', tool_input: { file_path: '/x/y' } })
    await Bun.sleep(0)
    expect(lastNotice(h, 'permission')).toMatchObject({ tool: 'Read' })
    h.runner.answer(lastNotice(h, 'permission').code, 'allow', null)
    await asked
  })

  test('once the plan is approved, a change that asks is forwarded as before', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, execMode: 'acceptEdits' })
    const pending = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Edit', permission_mode: 'acceptEdits', tool_input: { file_path: '/x' } })
    await Bun.sleep(0)
    expect(lastNotice(h, 'permission')).toMatchObject({ tool: 'Edit' })
    h.runner.answer(lastNotice(h, 'permission').code, 'allow', null)
    expect(await pending).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })

  test('a declined request carries your note', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, execMode: 'acceptEdits' })
    const pending = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', tool_input: { command: 'npm publish' } })
    await Bun.sleep(0)
    h.runner.answer(lastNotice(h, 'permission').code, 'deny', 'not yet')
    const r = (await pending) as { hookSpecificOutput: { decision: { behavior: string; message: string } } }
    expect(r.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(r.hookSpecificOutput.decision.message).toContain('Their note: not yet')
  })

  test('an unanswered request is denied', async () => {
    const h = setup({ approvalSec: 0.05 })
    const j = await startJob(h, { plan: false, execMode: 'acceptEdits' })
    const r = (await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', tool_input: { command: 'make deploy' } })) as {
      hookSpecificOutput: { decision: { behavior: string; message: string } }
    }
    expect(r.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(r.hookSpecificOutput.decision.message).toContain("didn't approve this in time")
    expect(h.store.getApproval(lastNotice(h, 'permission').code)!.status).toBe('expired')
  })

  test("answers Claude's question from your reply", async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    const pending = h.runner.onHook('PreToolUse', j.id, {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] },
    })
    await Bun.sleep(0)
    expect(h.runner.answer(lastNotice(h, 'question').code, 'answer', 'b')).toBe(`Sent your answer to #${j.id}.`)
    expect(await pending).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The user is away from the keyboard and answered from their phone: "Which color?" → blue',
      },
    })
  })
})

describe('folder trust', () => {
  test('accepts the prompt for a trusted folder: Down, check focus, Enter', async () => {
    const h = setup()
    h.config().trustedDirs.push(h.project)
    const job = h.runner.enqueue(h.spec())
    await h.runner.tick()
    const w = h.tmux.windows.get(windowName(job.id))!
    w.screen = TRUST_SCREEN
    await h.runner.tick()
    expect(w.input).toEqual(['Down'])
    w.screen = TRUST_SCREEN_YES
    await h.runner.tick()
    expect(w.input).toEqual(['Down', 'Enter'])
  })

  test('asks you first for an unknown folder and remembers the answer', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec())
    await h.runner.tick()
    const w = h.tmux.windows.get(windowName(job.id))!
    w.screen = TRUST_SCREEN
    await h.runner.tick()
    expect(w.input).toEqual([])
    h.runner.answer(lastNotice(h, 'trust').code, 'allow', null)
    await h.runner.tick()
    expect(h.config().trustedDirs).toContain(h.project)
    expect(w.input).toEqual(['Down'])
  })
})

describe('problems', () => {
  test('a crash holds the queue; go restarts the conversation with continue', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    j.window.dead = true
    j.window.deadStatus = 1
    j.window.screen = 'Error: boom'
    await h.runner.tick()
    expect(h.store.getJob(j.id)!.status).toBe('held')
    expect(lastNotice(h, 'failed')).toMatchObject({ reason: 'Claude exited (code 1)', screen: 'Error: boom' })
    expect(await h.runner.go()).toBe(`Restarted #${j.id}.`)
    const argv = h.runner.launchSpec(j.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', j.sid])
    expect(argv.at(-1)).toBe('continue')
  })

  test('waits while the conversation is open elsewhere; fork continues in a copy', async () => {
    const h = setup()
    const first = await startJob(h, { plan: false })
    await finishTurn(h, first)
    h.setHolders([{ pid: 999, sessionId: first.sid, entrypoint: 'claude-vscode', status: 'idle' }])
    const second = h.runner.enqueue(h.spec({ plan: false, prompt: 'next' }))
    await h.runner.tick()
    expect(h.store.getJob(second.id)).toMatchObject({ status: 'held', holdReason: 'conflict' })
    expect(lastNotice(h, 'conflict').holder).toBe('claude-vscode pid 999')
    expect(await h.runner.fork()).toBe(`#${second.id} continues in a copy of the conversation.`)
    const argv = h.runner.launchSpec(second.id)!.argv
    expect(argv.slice(1, 6)).toEqual(['--resume', first.sid, '--fork-session', '--session-id', h.store.getJob(second.id)!.sessionId!])
  })

  test('a job waiting on a busy conversation starts by itself once it is closed', async () => {
    const h = setup()
    const first = await startJob(h, { plan: false })
    await finishTurn(h, first)
    h.setHolders([{ pid: 999, sessionId: first.sid, entrypoint: 'claude-vscode', status: 'idle' }])
    const second = h.runner.enqueue(h.spec({ plan: false, prompt: 'next' }))
    await h.runner.tick()
    await h.runner.tick()
    expect(h.store.getJob(second.id)!.holdReason).toBe('conflict')
    expect(h.notices.filter(n => n.type === 'conflict')).toHaveLength(1)
    h.setHolders([])
    await h.runner.tick()
    expect(h.store.getJob(second.id)).toMatchObject({ status: 'running', holdReason: null })
    expect(h.runner.launchSpec(second.id)!.argv.slice(1, 3)).toEqual(['--resume', first.sid])
  })

  test('no activity while idle holds the job with the screen', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    j.window.screen = 'some prompt nobody answered'
    h.advance(21 * 60_000)
    await h.runner.tick()
    expect(lastNotice(h, 'held')).toMatchObject({ reason: 'no activity for 21m', screen: 'some prompt nobody answered' })
  })

  test('a long tool call (session busy) is not stuck', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    h.setHolders([{ pid: 1, sessionId: j.sid, entrypoint: 'cli', status: 'busy' }])
    h.advance(21 * 60_000)
    await h.runner.tick()
    expect(h.store.getJob(j.id)!.status).toBe('running')
  })

  test('stop interrupts and holds; skip moves on', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    h.runner.enqueue(h.spec({ plan: false, prompt: 'second' }))
    expect(await h.runner.stop()).toContain(`Stopped #${j.id}`)
    expect(j.window.input).toEqual(['Escape'])
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto' })
    expect(h.store.getJob(j.id)!.status).toBe('held') // your stop sticks
    expect(await h.runner.skip()).toBe(`Killed #${j.id}. Next up: #${j.id + 1}.`)
    await h.runner.tick()
    expect(h.store.active()?.id).toBe(j.id + 1)
  })
})

describe('plan with one model, work with another', () => {
  test("once the plan is approved, the same conversation resumes on the work model, in the task's mode", async () => {
    const h = setup()
    const j = await startJob(h, { model: 'opus', workModel: 'sonnet' })
    expect(h.store.getJob(j.id)!.workModel).toBe('sonnet')
    let argv = h.runner.launchSpec(j.id)!.argv
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--permission-mode') + 1]]).toEqual(['opus', 'plan'])
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'Create hello.txt with hi' } })
    j.window.screen = PLAN_SCREEN
    await h.runner.tick()
    // The dialog isn't answered: the planner's window closes and the work model takes over.
    expect(j.window.input).toEqual([])
    expect(h.store.getJob(j.id)).toMatchObject({ planApproved: true, status: 'running', launches: 2, planText: 'Create hello.txt with hi' })
    argv = h.runner.launchSpec(j.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', j.sid])
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--permission-mode') + 1]]).toEqual(['sonnet', 'auto'])
    expect(argv.at(-1)).toBe('Your plan is approved. Carry it out now, step by step, and finish the task.')
    expect(lastNotice(h, 'plan_approved').choice).toBe('Yes, and use auto mode; sonnet carries it out')

    // Started again later (its window gone), it's still the work model's.
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid, transcript_path: '/tmp/t.jsonl' })
    h.tmux.windows.delete(windowName(j.id))
    await h.runner.tick()
    argv = h.runner.launchSpec(j.id)!.argv
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
  })

  test('plan as opus at max, work as sonnet at medium: both change at the hand-over, and stay', async () => {
    const h = setup()
    const j = await startJob(h, { model: 'opus', effort: 'max', workModel: 'sonnet', workEffort: 'medium' })
    const flag = (name: string) => {
      const argv = h.runner.launchSpec(j.id)!.argv
      return argv[argv.indexOf(name) + 1]
    }
    expect([flag('--model'), flag('--effort')]).toEqual(['opus', 'max'])
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'p' } })
    j.window.screen = PLAN_SCREEN
    await h.runner.tick()
    expect([flag('--model'), flag('--effort')]).toEqual(['sonnet', 'medium'])
    expect(lastNotice(h, 'plan_approved').choice).toBe('Yes, and use auto mode; sonnet at medium carries it out')
    // Started again later, it's still the work's.
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid, transcript_path: '/tmp/t.jsonl' })
    h.tmux.windows.delete(windowName(j.id))
    await h.runner.tick()
    expect([flag('--model'), flag('--effort')]).toEqual(['sonnet', 'medium'])
  })

  test('only the effort differs: the same model resumes at the work effort', async () => {
    const h = setup()
    const j = await startJob(h, { model: 'opus', effort: 'max', workEffort: 'medium' })
    expect(h.store.getJob(j.id)).toMatchObject({ workModel: null, workEffort: 'medium' })
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'p' } })
    j.window.screen = PLAN_SCREEN
    await h.runner.tick()
    expect(j.window.input).toEqual([]) // handed over, not answered
    const argv = h.runner.launchSpec(j.id)!.argv
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--effort') + 1]]).toEqual(['opus', 'medium'])
    expect(lastNotice(h, 'plan_approved').choice).toBe('Yes, and use auto mode; opus at medium carries it out')
  })

  test('the same effort, or no plan: nothing is kept', () => {
    const h = setup()
    expect(h.runner.enqueue(h.spec({ effort: 'high', workEffort: 'high' })).workEffort).toBeNull()
    expect(h.runner.enqueue(h.spec({ plan: false, effort: 'high', workEffort: 'low' })).workEffort).toBeNull()
  })

  test('the same model, or no plan to hand over: one model does it all', () => {
    const h = setup()
    expect(h.runner.enqueue(h.spec({ model: 'opus', workModel: 'opus' })).workModel).toBeNull()
    expect(h.runner.enqueue(h.spec({ plan: false, model: 'opus', workModel: 'sonnet' })).workModel).toBeNull()
  })
})

describe('live links', () => {
  const LINK = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789'

  test('at the end, Claude is asked for one; the link is kept and said, and the answer stays the answer', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, wantLink: true })
    expect(JSON.parse(h.files.get(`/tmp/cqhome/jobs/${j.id}.settings.json`)!).permissions).toEqual({ allow: ['Artifact'] })
    const first = await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: 'Added the dark mode toggle.' })
    expect(first).toMatchObject({ decision: 'block' })
    expect(String((first as { reason: string }).reason)).toContain('publish a Claude artifact')
    expect(h.store.getJob(j.id)!.phase).not.toBe('finishing')
    const second = await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', stop_hook_active: true, last_assistant_message: `Here it is: [Dark mode, before and after](${LINK})` })
    expect(second).toEqual({})
    expect(h.store.getJob(j.id)).toMatchObject({ links: [{ url: LINK, title: 'Dark mode, before and after' }], linkNote: null, lastMessage: 'Added the dark mode toggle.', phase: 'finishing' })
    expect(lastNotice(h, 'link')).toMatchObject({ url: LINK, title: 'Dark mode, before and after' })
  })

  test('Claude left a server running for its screenshots: the link is still read when the wait for it ends', async () => {
    const h = setup({ backgroundSec: 60 })
    const j = await startJob(h, { plan: false, wantLink: true })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: 'Added the toggle.' })
    const second = await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', stop_hook_active: true, last_assistant_message: `Here it is.\n${LINK}`, background_tasks: [{ type: 'shell', status: 'running' }] })
    expect(second).toEqual({})
    h.advance(61_000)
    await h.runner.tick()
    expect(h.store.getJob(j.id)).toMatchObject({ links: [{ url: LINK, title: null }], lastMessage: 'Added the toggle.', phase: 'finishing' })
  })

  test('the work ended with background commands still running: the link is asked for as a message', async () => {
    const h = setup({ backgroundSec: 60 })
    const j = await startJob(h, { plan: false, wantLink: true })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: 'Started the dev server and added the toggle.', background_tasks: [{ type: 'shell', status: 'running' }] })
    h.advance(61_000)
    await h.runner.tick()
    expect(j.window.input.some(x => x.startsWith('text:Before you finish: publish a Claude artifact'))).toBe(true)
    expect(h.store.getJob(j.id)!.phase).not.toBe('finishing')
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: LINK })
    expect(h.store.getJob(j.id)).toMatchObject({ links: [{ url: LINK, title: null }], lastMessage: 'Started the dev server and added the toggle.', phase: 'finishing' })
  })

  test("no link: the task still ends, and says why", async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, wantLink: true })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: 'Done.' })
    await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', stop_hook_active: true, last_assistant_message: "I can't publish artifacts here." })
    expect(h.store.getJob(j.id)).toMatchObject({ links: null, linkNote: "I can't publish artifacts here.", phase: 'finishing' })
    expect(lastNotice(h, 'link')).toMatchObject({ url: null, note: "I can't publish artifacts here." })
  })

  test('asked for later: a queued or running task ends with one; a finished one gets a task of its own, next, and the link lands on it', async () => {
    const h = setup()
    const a = await startJob(h, { plan: false })
    const queued = h.runner.enqueue(h.spec({ plan: false, prompt: 'later' }))
    expect(h.runner.requestLink(queued.id).text).toBe(`#${queued.id} ends with a live link.`)
    expect(h.store.getJob(queued.id)!.wantLink).toBe(true)
    await finishTurn(h, a)
    expect(h.store.getJob(a.id)!.status).toBe('done')
    const asked = h.runner.requestLink(a.id)
    expect(asked).toMatchObject({ ok: true })
    const linkJob = asked.job!
    expect(linkJob).toMatchObject({ linkFor: a.id, sessionId: a.sid, sessionPolicy: 'session', plan: false })
    expect(h.store.queued()[0]!.id).toBe(linkJob.id)
    expect(h.runner.requestLink(a.id).text).toBe(`A live link for #${a.id} is already queued as #${linkJob.id}.`)
    // It runs, publishes, and the link shows on #a.
    await h.runner.tick()
    await h.runner.onHook('SessionStart', linkJob.id, { session_id: a.sid, transcript_path: '/tmp/t.jsonl' })
    await h.runner.onHook('UserPromptSubmit', linkJob.id, { session_id: a.sid, permission_mode: 'auto' })
    await h.runner.onHook('Stop', linkJob.id, { permission_mode: 'auto', last_assistant_message: LINK })
    expect(h.store.getJob(a.id)!.links).toEqual([{ url: LINK, title: null }])
    expect(lastNotice(h, 'link').job.id).toBe(a.id)
    expect(h.runner.requestLink(999)).toMatchObject({ ok: false })
  })
})

describe('the queue: hold, put back, clear', () => {
  test('a task on hold keeps its place but the next one starts; released, it starts next', async () => {
    const h = setup()
    const a = h.runner.enqueue(h.spec({ plan: false, prompt: 'first' }))
    const b = h.runner.enqueue(h.spec({ plan: false, prompt: 'second' }))
    expect(h.runner.holdQueued(a.id, true)).toContain('on hold')
    await h.runner.tick()
    expect(h.store.active()?.id).toBe(b.id)
    expect(h.store.queued().map(j => [j.id, j.onHold])).toEqual([[a.id, true]])
    expect(h.runner.holdQueued(a.id, false)).toBe(`#${a.id} can start again.`)
    expect(h.runner.holdQueued(b.id, true)).toBe(`#${b.id} isn't waiting in the queue.`)
  })

  test('a removed task goes back in its place for ten minutes, if it never started', async () => {
    const h = setup()
    const [a, b, c] = ['one', 'two', 'three'].map(prompt => h.runner.enqueue(h.spec({ plan: false, prompt })))
    await h.runner.remove(b!.id)
    expect(h.runner.restore(b!.id)).toBe(`#${b!.id} is back in the queue.`)
    expect(h.store.queued().map(j => j.id)).toEqual([a!.id, b!.id, c!.id])
    expect(h.runner.restore(b!.id)).toBe(`#${b!.id} is already in the queue.`)
    await h.runner.remove(c!.id)
    h.advance(11 * 60_000)
    expect(h.runner.restore(c!.id)).toContain("can't go back in the queue")
    expect(h.runner.restore(999)).toBe('No task #999.')
  })

  test('clear takes every waiting task off, and they can go back', async () => {
    const h = setup()
    const running = await startJob(h, { plan: false })
    const ids = ['two', 'three'].map(prompt => h.runner.enqueue(h.spec({ plan: false, prompt })).id)
    expect(h.runner.clear()).toEqual(ids)
    expect(h.store.queued()).toEqual([])
    expect(h.store.getJob(running.id)!.status).toBe('running')
    for (const id of ids) h.runner.restore(id)
    expect(h.store.queued().map(j => j.id)).toEqual(ids)
  })
})

describe('killing a task', () => {
  /** Fake processes: the window's process 500 with Claude (501) and a dev server (502) below it. */
  function fakeProcs(o: { stubborn?: number[] } = {}) {
    const alive = new Set([500, 501, 502])
    const signals: string[] = []
    const procs: Procs = {
      tree: async root => (root === 500 ? [500, 501, 502] : [root]),
      signal: (pid, sig) => {
        if (!alive.has(pid)) return false
        signals.push(`${sig} ${pid}`)
        if (sig === 'SIGKILL' || !o.stubborn?.includes(pid)) alive.delete(pid)
        return true
      },
      alive: pid => alive.has(pid),
    }
    return { procs, signals, alive }
  }

  test('a running task ends with everything it started; what waited on you is settled; the queue moves on', async () => {
    const p = fakeProcs({ stubborn: [502] })
    const h = setup({}, { procs: p.procs })
    const j = await startJob(h, { plan: false })
    j.window.pid = 500
    h.runner.enqueue(h.spec({ plan: false, prompt: 'second' }))
    const asking = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', tool_input: { command: 'npm run dev' } })
    await Bun.sleep(0)
    expect(await h.runner.kill(j.id, { by: 'iPhone' })).toBe(`Killed #${j.id}. Next up: #${j.id + 1}.`)
    expect(p.signals).toEqual(['SIGTERM 500', 'SIGTERM 501', 'SIGTERM 502', 'SIGKILL 502'])
    expect(p.alive.size).toBe(0)
    expect(h.tmux.windows.has(windowName(j.id))).toBe(false)
    expect(await asking).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
    expect(h.store.getJob(j.id)).toMatchObject({ status: 'cancelled', error: 'Killed by iPhone', phase: null, holdReason: null })
    expect(h.notices.at(-1)).toMatchObject({ type: 'killed', by: 'iPhone' })
    await h.runner.tick()
    expect(h.store.active()?.id).toBe(j.id + 1)
  })

  test('waiting for a chat open in VS Code: it ends, and never starts by itself afterwards', async () => {
    const h = setup()
    const sid = 'bbbbbbbb-1111-2222-3333-444444444444'
    h.setHolders([{ pid: 77, sessionId: sid, entrypoint: 'claude-vscode', status: 'idle' }])
    const job = h.runner.enqueue(h.spec({ plan: false, sessionPolicy: 'session', sessionId: sid }))
    await h.runner.tick()
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'held', holdReason: 'conflict' })
    expect(await h.runner.kill(job.id, { pause: true })).toBe(`Killed #${job.id}. The queue is paused.`)
    h.setHolders([])
    await h.runner.tick()
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
    expect(h.tmux.windows.size).toBe(0)
    expect(h.runner.paused).toBe(true)
  })

  test('killed while it was starting: it never starts', async () => {
    let release!: () => void
    const h = setup({}, { slowSnapshot: new Promise<void>(resolve => (release = resolve)) })
    const job = h.runner.enqueue(h.spec({ plan: false }))
    const ticking = h.runner.tick()
    await Bun.sleep(0)
    // The launch is waiting for git (the task isn't running yet); now it's killed.
    expect(await h.runner.kill(job.id)).toBe(`Removed #${job.id} from the queue.`)
    release()
    await ticking
    expect(h.store.getJob(job.id)!.status).toBe('cancelled')
    expect(h.tmux.windows.size).toBe(0)
  })

  test('a queued task just comes off the queue; an ended one stays as it was', async () => {
    const h = setup()
    const a = await startJob(h, { plan: false })
    const b = h.runner.enqueue(h.spec({ plan: false, prompt: 'later' }))
    expect(await h.runner.kill(b.id, { by: 'iPhone' })).toBe(`Removed #${b.id} from the queue.`)
    expect(h.store.getJob(b.id)).toMatchObject({ status: 'cancelled', error: 'Removed by iPhone' })
    expect(h.store.getJob(a.id)!.status).toBe('running')
    await h.runner.kill(a.id)
    expect(await h.runner.kill(a.id)).toBe(`#${a.id} has already ended.`)
    expect(await h.runner.kill(999)).toBe('No task #999.')
  })

  test('a task taken over from VS Code gives the chat back to VS Code', async () => {
    const h = setup()
    const sid = 'cccccccc-1111-2222-3333-444444444444'
    const j = await startJob(h, { plan: false, sessionPolicy: 'session', sessionId: sid })
    h.store.updateJob(j.id, { tookFrom: 'claude-vscode' })
    await h.runner.kill(j.id)
    expect(h.reopened).toEqual([sid])
  })
})

describe('taking a chat over from VS Code', () => {
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
  const vscode = (h: Harness, over: Partial<LiveSession> = {}): LiveSession => ({
    pid: 999,
    sessionId: SID,
    entrypoint: 'claude-vscode',
    kind: 'interactive',
    status: 'idle',
    startedAt: h.now() - 60_000,
    ...over,
  })
  const handOff = (h: Harness, takeover = true) =>
    h.runner.enqueue(h.spec({ plan: false, prompt: 'Continue from where you left off.', sessionPolicy: 'session', sessionId: SID, takeover }))

  test('closes an idle chat there, then resumes the same conversation', async () => {
    const h = setup()
    h.setHolders([vscode(h)])
    const job = handOff(h)
    await h.runner.tick()
    expect(h.killed).toEqual([999])
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'running', sessionId: SID })
    const argv = h.runner.launchSpec(job.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', SID])
    expect(argv).not.toContain('--fork-session')
    expect(argv.at(-1)).toBe('Continue from where you left off.')
    expect(lastNotice(h, 'took_over').where).toBe('VS Code')
  })

  test('a busy chat is taken over once its turn ends', async () => {
    const h = setup()
    h.setHolders([vscode(h, { status: 'busy' })])
    const job = handOff(h)
    await h.runner.tick()
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'held', holdReason: 'conflict' })
    expect(lastNotice(h, 'conflict')).toMatchObject({ state: 'waiting', where: 'VS Code', busy: true })
    await h.runner.tick()
    expect(h.killed).toEqual([])
    h.setHolders([vscode(h)])
    await h.runner.tick()
    expect(h.killed).toEqual([999])
    expect(h.store.getJob(job.id)!.status).toBe('running')
  })

  test('a chat you opened again after asking is not closed: you are asked again', async () => {
    const h = setup()
    const job = handOff(h)
    h.advance(60_000)
    h.setHolders([vscode(h, { startedAt: h.now() })])
    await h.runner.tick()
    await h.runner.tick()
    expect(h.killed).toEqual([])
    expect(lastNotice(h, 'conflict').state).toBe('open')
    expect(await h.runner.takeover()).toBe(`#${job.id} took the conversation over from VS Code.`)
    expect(h.killed).toEqual([999])
    expect(h.store.getJob(job.id)!.status).toBe('running')
  })

  test("a chat that won't close is asked once, then left to you", async () => {
    const h = setup()
    h.setStubborn(true)
    h.setHolders([vscode(h)])
    const job = handOff(h)
    await h.runner.tick()
    expect(h.store.getJob(job.id)).toMatchObject({ status: 'held', holdReason: 'conflict', takeoverAt: null })
    expect(lastNotice(h, 'conflict').state).toBe('stuck')
    await h.runner.tick()
    await h.runner.tick()
    expect(h.killed).toEqual([999])
    expect(h.tmux.windows.size).toBe(0)
  })

  test('without take it waits; take closes it there and continues', async () => {
    const h = setup()
    expect(await h.runner.takeover()).toBe('Nothing is waiting on a conversation that is open somewhere else.')
    h.setHolders([vscode(h, { status: 'busy' })])
    const job = handOff(h, false)
    await h.runner.tick()
    await h.runner.tick()
    expect(h.killed).toEqual([])
    expect(lastNotice(h, 'conflict')).toMatchObject({ state: 'open', holder: 'claude-vscode pid 999', busy: true })
    expect(await h.runner.takeover()).toBe(`#${job.id} takes the conversation over as soon as VS Code finishes its turn.`)
    expect(h.killed).toEqual([])
    h.setHolders([vscode(h)])
    await h.runner.tick()
    expect(h.killed).toEqual([999])
    expect(h.runner.launchSpec(job.id)!.argv.slice(1, 3)).toEqual(['--resume', SID])
  })

  test('only idle interactive windows opened before you asked can be closed', () => {
    const base: LiveSession = { pid: 1, sessionId: SID, kind: 'interactive', status: 'idle', startedAt: 100 }
    expect(canTakeOver({ takeoverAt: null }, [base])).toBe(false)
    expect(canTakeOver({ takeoverAt: 100 }, [base])).toBe(true)
    expect(canTakeOver({ takeoverAt: 100 }, [])).toBe(false)
    expect(canTakeOver({ takeoverAt: 100 }, [{ ...base, status: 'busy' }])).toBe(false)
    expect(canTakeOver({ takeoverAt: 100 }, [{ ...base, kind: 'background' }])).toBe(false)
    expect(canTakeOver({ takeoverAt: 99 }, [base])).toBe(false)
  })
})

describe('queue order', () => {
  test('several messages for one chat at the front keep the order you sent them', async () => {
    const h = setup()
    h.runner.setPaused(true)
    const other = h.runner.enqueue(h.spec({ prompt: 'other task' }))
    const sid = 'bbbbbbbb-1111-2222-3333-444444444444'
    const one = h.runner.enqueue(h.spec({ prompt: 'first', sessionPolicy: 'session', sessionId: sid, front: true }))
    const two = h.runner.enqueue(h.spec({ prompt: 'second', sessionPolicy: 'session', sessionId: sid, front: true }))
    const three = h.runner.enqueue(h.spec({ prompt: 'third', sessionPolicy: 'session', sessionId: sid, front: true }))
    const urgent = h.runner.enqueue(h.spec({ prompt: 'urgent', front: true }))
    expect(h.store.queued().map(j => j.id)).toEqual([urgent.id, one.id, two.id, three.id, other.id])
  })
})

describe('keeping in sync', () => {
  test("the Mac restarted mid-task: the conversation starts again by itself, once per 10 minutes", async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    h.tmux.windows.delete(windowName(j.id)) // tmux and Claude went away with the reboot
    await h.runner.tick()
    const argv = h.runner.launchSpec(j.id)!.argv
    expect(argv.slice(1, 3)).toEqual(['--resume', j.sid])
    expect(argv.at(-1)).toBe('continue')
    expect(lastNotice(h, 'recovered').job.id).toBe(j.id)
    await h.runner.onHook('SessionStart', j.id, { session_id: j.sid })
    h.tmux.windows.delete(windowName(j.id))
    await h.runner.tick()
    expect(h.store.getJob(j.id)).toMatchObject({ status: 'held', error: 'its tmux window is gone' })
  })

  test('a chat taken from VS Code opens there again when the task ends', async () => {
    const h = setup()
    const sid = 'cccccccc-1111-2222-3333-444444444444'
    h.setHolders([{ pid: 999, sessionId: sid, entrypoint: 'claude-vscode', kind: 'interactive', status: 'idle', startedAt: h.now() - 60_000 }])
    const job = h.runner.enqueue(h.spec({ plan: false, sessionPolicy: 'session', sessionId: sid, takeover: true }))
    await h.runner.tick()
    expect(h.store.getJob(job.id)!.tookFrom).toBe('claude-vscode')
    await h.runner.onHook('SessionStart', job.id, { session_id: sid })
    await h.runner.onHook('UserPromptSubmit', job.id, { permission_mode: 'auto' })
    await finishTurn(h, { id: job.id, sid, window: h.tmux.windows.get(windowName(job.id))! })
    expect(h.store.getJob(job.id)!.status).toBe('done')
    expect(h.reopened).toEqual([sid])
  })

  test('typing into the running chat only while it is doing ordinary work', async () => {
    const h = setup()
    expect(await h.runner.typeIfFree('nope', 'hi')).toBeNull()
    const j = await startJob(h, { plan: false })
    expect(await h.runner.typeIfFree('another-chat', 'hi')).toBeNull()
    j.window.screen = 'Do you want to proceed?\n❯ 1. Yes'
    expect(await h.runner.typeIfFree(j.sid, 'hi')).toBeNull()
    j.window.screen = ''
    expect(await h.runner.typeIfFree(j.sid, 'also add tests')).toBe(j.id)
    expect(j.window.input).toEqual(['text:also add tests', 'Enter'])
  })
})

describe('ask mode', () => {
  test('a question runs read-only and ends when Claude has answered: no plan, no nudges', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec({ plan: false, execMode: 'plan', prompt: 'What does the watcher do?' }))
    await h.runner.tick()
    const argv = h.runner.launchSpec(job.id)!.argv
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan')
    const sid = h.store.getJob(job.id)!.sessionId!
    await h.runner.onHook('SessionStart', job.id, { session_id: sid, transcript_path: '/tmp/t.jsonl' })
    await h.runner.onHook('UserPromptSubmit', job.id, { permission_mode: 'plan' })
    expect(h.store.getJob(job.id)!.phase).toBe('working')
    expect(await h.runner.onHook('Stop', job.id, { permission_mode: 'plan', last_assistant_message: 'It watches your other chats.' })).toEqual({})
    expect(h.store.getJob(job.id)).toMatchObject({ phase: 'finishing', nudges: 0 })
  })

  test('if Claude presents a plan anyway, it is told to just answer', async () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec({ plan: false, execMode: 'plan', prompt: 'How would you add X?' }))
    await h.runner.tick()
    const sid = h.store.getJob(job.id)!.sessionId!
    await h.runner.onHook('SessionStart', job.id, { session_id: sid })
    await h.runner.onHook('PermissionRequest', job.id, { tool_name: 'ExitPlanMode', tool_input: { plan: 'Step 1…' } })
    const w = h.tmux.windows.get(windowName(job.id))!
    w.screen = PLAN_SCREEN
    await h.runner.tick()
    expect(w.input).toEqual(['3']) // "Tell Claude what to change"
    await h.runner.tick()
    expect(w.input.at(-2)).toBe("text:This task is a question: answer it directly in your reply. Don't present a plan or change anything.")
    expect(h.notices.some(n => n.type === 'plan_approved')).toBe(false)
  })
})

describe('watching a task', () => {
  test('each tool call reaches apps as it starts and ends, in a line', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    const cwd = h.store.getJob(j.id)!.launchSpec!.cwd
    await h.runner.onHook('ToolStart', j.id, { tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false\nmore' }, cwd })
    await h.runner.onHook('PostToolUse', j.id, { tool_name: 'Edit', tool_input: { file_path: join(cwd, 'src', 'csv.ts') }, cwd })
    await h.runner.onHook('ToolStart', j.id, { tool_name: 'mcp__github__create_issue', tool_input: { title: 'Flaky test' } })
    expect(h.activity.map(a => [a.job, a.phase, a.tool, a.detail])).toEqual([
      [j.id, 'start', 'Bash', 'npm test -- --watch=false'],
      [j.id, 'end', 'Edit', 'src/csv.ts'],
      [j.id, 'start', 'github · create_issue', 'Flaky test'],
    ])
    // A tool starting is activity: the watchdog doesn't call the task stuck while tools run.
    expect(h.store.getJob(j.id)!.lastEventAt).toBe(h.now())
  })

  test('every tool start is hooked, asynchronously, apart from the question hook', () => {
    const h = setup()
    const job = h.runner.enqueue(h.spec())
    const settings = sessionSettings(job, h.config(), { hook: '/h', status: '/s' }) as { hooks: Record<string, { matcher?: string; hooks: { command: string; async?: boolean }[] }[]> }
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'AskUserQuestion', hooks: [expect.objectContaining({ command: "'/h' PreToolUse" })] },
      { hooks: [expect.objectContaining({ command: "'/h' ToolStart", async: true })] },
    ])
  })

  test('the status line keeps the running task’s context and cost', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    h.runner.onStatusline(j.id, { context_window: { used_percentage: 42.4 }, cost: { total_cost_usd: 0.31 } })
    expect(h.store.getJob(j.id)).toMatchObject({ contextPct: 42.4, costUsd: 0.31 })
    // Rounded the same: not written again.
    h.runner.onStatusline(j.id, { context_window: { used_percentage: 42.2 } })
    expect(h.store.getJob(j.id)!.contextPct).toBe(42.4)
    h.runner.onStatusline(j.id, { context_window: { used_percentage: 57 } })
    expect(h.store.getJob(j.id)!.contextPct).toBe(57)
  })
})

describe('steering from an app', () => {
  const npmTest = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }

  test('a permission offers Claude Code’s own rule; allowing with it hands the rule back', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    const asked = h.runner.onHook('PermissionRequest', j.id, {
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- --watch=false' },
      permission_suggestions: [npmTest, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    })
    await Bun.sleep(0)
    const notice = lastNotice(h, 'permission')
    expect(notice.suggestions).toEqual(['Always allow commands starting with npm test in this project'])
    expect(notice.allowedBefore).toBe(0)
    expect(h.runner.answer(notice.code, 'allow', null, { rule: 0 })).toContain('Approved')
    expect(await asked).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [npmTest] } } })
  })

  test('the same request again says how often it was allowed', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    for (let i = 0; i < 3; i++) {
      const asked = h.runner.onHook('PermissionRequest', j.id, { tool_name: 'Bash', tool_input: { command: 'npm test' } })
      await Bun.sleep(0)
      const notice = lastNotice(h, 'permission')
      expect(notice.allowedBefore).toBe(i)
      h.runner.answer(notice.code, 'allow', null)
      expect(await asked).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    }
  })

  test('approving a plan with a mode works on in that mode; a revised plan keeps the one before', async () => {
    const h = setup()
    const j = await startJob(h, { review: true })
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'First plan' } })
    await h.runner.onHook('PermissionRequest', j.id, { tool_name: 'ExitPlanMode', permission_mode: 'plan', tool_input: { plan: 'Second plan' } })
    expect(h.store.getJob(j.id)).toMatchObject({ planText: 'Second plan', planVersions: [{ at: h.now(), text: 'First plan' }] })
    j.window.screen = PLAN_SCREEN
    await h.runner.tick()
    const review = lastNotice(h, 'plan_review')
    h.runner.answer(review.code, 'allow', null, { mode: 'acceptEdits' })
    expect(h.store.getJob(j.id)!.execMode).toBe('acceptEdits')
    await h.runner.tick()
    // The dialog has no "accept edits" option: approve with manual edits, then switch.
    expect(j.window.input).toEqual(['2'])
  })

  test('a task scheduled for later keeps its place while the next one runs', async () => {
    const h = setup()
    const later = h.runner.enqueue({ ...h.spec({ plan: false, prompt: 'Later' }), notBefore: h.now() + 3_600_000 })
    const now = h.runner.enqueue(h.spec({ plan: false, prompt: 'Now' }))
    await h.runner.tick()
    expect(h.store.getJob(now.id)!.status).toBe('running')
    expect(h.store.getJob(later.id)!.status).toBe('queued')
  })

  test('a task waiting on another starts after it, and is dropped if that one fails', async () => {
    const h = setup()
    const first = await startJob(h, { plan: false })
    const second = h.runner.enqueue({ ...h.spec({ plan: false, prompt: 'Then this' }), afterJob: first.id })
    await finishTurn(h, first)
    await h.runner.tick()
    expect(h.store.getJob(second.id)!.status).toBe('running')

    const h2 = setup()
    const a = await startJob(h2, { plan: false })
    const b = h2.runner.enqueue({ ...h2.spec({ plan: false }), afterJob: a.id })
    await h2.runner.skip()
    await h2.runner.tick()
    expect(h2.store.getJob(b.id)).toMatchObject({ status: 'cancelled', error: expect.stringContaining(`#${a.id} was cancelled`) })
    expect(lastNotice(h2, 'failed').job.id).toBe(b.id)
  })

  test('a daily task queues its next run when it ends', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false, prompt: 'Nightly tests' })
    h.store.updateJob(j.id, { repeatDaily: 2 * 60 })
    await finishTurn(h, j)
    const next = h.store.queued().find(x => x.prompt === 'Nightly tests')!
    expect(next.repeatDaily).toBe(120)
    const at = new Date(next.notBefore!)
    expect([at.getHours(), at.getMinutes()]).toEqual([2, 0])
    expect(next.notBefore! > h.now() && next.notBefore! <= h.now() + 86_400_000).toBe(true)
  })

  test('a time limit stops the task when it’s used up; continuing lifts it', async () => {
    const h = setup()
    const j = await startJob(h, { plan: false })
    h.store.updateJob(j.id, { maxMinutes: 1 })
    for (let i = 0; i < 7; i++) {
      h.advance(10_000)
      await h.runner.onHook('PostToolUse', j.id, { tool_name: 'Bash', tool_input: { command: 'ls' } })
      await h.runner.tick()
    }
    expect(h.store.getJob(j.id)).toMatchObject({ status: 'held', holdReason: 'it worked 1 minute, its time limit' })
    expect(j.window.input).toContain('Escape')
    await h.runner.go()
    expect(h.store.getJob(j.id)!.maxMinutes).toBeNull()
  })
})

describe('attachments', () => {
  test('the first launch names them and lets the session read the uploads folder; a restart doesn’t repeat them', async () => {
    const h = setup()
    const job = h.runner.enqueue({ ...h.spec({ plan: false, prompt: 'Why does it crash?' }), attachments: ['/tmp/cqhome/uploads/2026-10-16/ab-crash.png'] })
    await h.runner.tick()
    const argv = h.runner.launchSpec(job.id)!.argv
    expect(argv.at(-1)).toBe('Why does it crash?\n\nAttached from the phone (read it):\n- /tmp/cqhome/uploads/2026-10-16/ab-crash.png')
    expect(argv.slice(argv.indexOf('--add-dir'), argv.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/tmp/cqhome/uploads'])
  })
})

describe('tasks at once', () => {
  /** A harness allowing `n` tasks at once, with a second project folder next to the first. */
  function two(n = 2, opts: { gitRepo?: boolean } = {}) {
    const h = setup({}, opts)
    h.config().parallel = n
    const other = mkdtempSync(join(tmpdir(), 'cq-run-b-'))
    return { h, other }
  }
  /** Queues a task and ticks until it has started (one start per tick). */
  const start = async (h: Harness, over: Partial<JobSpec> = {}) => {
    const job = h.runner.enqueue(h.spec({ plan: false, ...over }))
    await h.runner.tick()
    return job
  }
  const statuses = (h: Harness, ...ids: number[]) => ids.map(id => h.store.getJob(id)!.status)

  test('one at a time stays the default: a second waits for the first', async () => {
    const h = setup()
    const a = await start(h)
    const b = await start(h, { projectDir: mkdtempSync(join(tmpdir(), 'cq-run-b-')) })
    expect(statuses(h, a.id, b.id)).toEqual(['running', 'queued'])
  })

  test('two folders run side by side, each with its own window, hooks and Stop', async () => {
    const { h, other } = two()
    const a = await start(h)
    const b = await start(h, { projectDir: other })
    expect(statuses(h, a.id, b.id)).toEqual(['running', 'running'])
    expect([...h.tmux.windows.keys()]).toEqual([windowName(a.id), windowName(b.id)])
    expect(h.store.running().map(j => j.id)).toEqual([a.id, b.id])
    // Their hooks are their own.
    for (const j of [a, b]) {
      const sid = h.store.getJob(j.id)!.sessionId!
      await h.runner.onHook('SessionStart', j.id, { session_id: sid, transcript_path: `/tmp/${j.id}.jsonl` })
      await h.runner.onHook('UserPromptSubmit', j.id, { session_id: sid, permission_mode: 'auto' })
    }
    // Stop by number holds only that one; with none given, the one that started last.
    await h.runner.stop(a.id)
    expect(statuses(h, a.id, b.id)).toEqual(['held', 'running'])
    await h.runner.go(a.id)
    expect(statuses(h, a.id, b.id)).toEqual(['running', 'running'])
    await h.runner.stop()
    expect(statuses(h, a.id, b.id)).toEqual(['running', 'held'])
    // Kill ends one and leaves the other.
    await h.runner.kill(b.id)
    expect(statuses(h, a.id, b.id)).toEqual(['running', 'cancelled'])
    expect(h.tmux.windows.has(windowName(a.id))).toBe(true)
    expect(h.tmux.windows.has(windowName(b.id))).toBe(false)
  })

  test('both finish on their own, and the queue moves on', async () => {
    const { h, other } = two()
    const a = await start(h)
    const b = await start(h, { projectDir: other })
    const c = h.runner.enqueue(h.spec({ plan: false, prompt: 'third' }))
    for (const j of [a, b]) await h.runner.onHook('Stop', j.id, { permission_mode: 'auto', last_assistant_message: `done ${j.id}` })
    h.advance(2000)
    await h.runner.tick()
    for (const j of [a, b]) h.tmux.windows.get(windowName(j.id))!.dead = true
    await h.runner.tick()
    expect(statuses(h, a.id, b.id)).toEqual(['done', 'done'])
    await h.runner.tick()
    expect(h.store.getJob(c.id)!.status).toBe('running')
  })

  test('the same folder changing files in place waits; its own branch, or only answering, runs beside', async () => {
    const { h } = two(3, { gitRepo: true })
    mkdirSync(join(h.project, '.git'), { recursive: true })
    const a = await start(h)
    // The same folder, in place: waits (two tasks would write the same files).
    const inPlace = await start(h, { isolate: false, sessionPolicy: 'new' })
    expect(h.store.getJob(inPlace.id)!.status).toBe('queued')
    expect(h.runner.collision(h.store.getJob(inPlace.id)!, [h.store.getJob(a.id)!])).toEqual({ job: a.id, why: 'folder' })
    // On its own branch: beside it.
    const branch = await start(h, { isolate: true, sessionPolicy: 'new' })
    expect(h.store.getJob(branch.id)!.status).toBe('running')
    expect(h.store.getJob(branch.id)!.workDir).toContain('afterhours-')
    // Only answering: beside both.
    const ask = await start(h, { plan: false, execMode: 'plan', sessionPolicy: 'new', prompt: 'what does it do?' })
    expect(h.store.running().length).toBe(3)
    expect(h.store.getJob(ask.id)!.status).toBe('running')
    // The waiting one starts once the one it collides with is done.
    await h.runner.kill(a.id)
    await h.runner.tick()
    expect(h.store.getJob(inPlace.id)!.status).toBe('running')
    // Three at once is the most: a fourth waits for a slot.
    const fourth = await start(h, { projectDir: mkdtempSync(join(tmpdir(), 'cq-run-c-')) })
    expect(h.store.getJob(fourth.id)!.status).toBe('queued')
  })

  test('a folder inside another counts as the same place; siblings do not', () => {
    const { h, other } = two()
    const running = h.runner.enqueue(h.spec({ plan: false, projectDir: other }))
    const asRunning = { ...running, status: 'running' as const, launchSpec: { cwd: other, argv: [] } }
    const inside = h.runner.enqueue(h.spec({ plan: false, projectDir: join(other, 'web') }))
    const sibling = h.runner.enqueue(h.spec({ plan: false, projectDir: `${other}-sibling` }))
    expect(h.runner.collision(inside, [asRunning])).toEqual({ job: running.id, why: 'folder' })
    expect(h.runner.collision(sibling, [asRunning])).toBeNull()
  })

  test('never two tasks in one conversation', async () => {
    const { h, other } = two()
    const a = await start(h, { projectDir: other })
    const sid = h.store.getJob(a.id)!.sessionId!
    // A follow-up in the same conversation, even from another folder, waits.
    const follow = h.runner.enqueue(h.spec({ plan: false, sessionId: sid, sessionPolicy: 'session', projectDir: h.project }))
    expect(h.runner.collision(follow, [h.store.getJob(a.id)!])).toEqual({ job: a.id, why: 'conversation' })
    await h.runner.tick()
    expect(h.store.getJob(follow.id)!.status).toBe('queued')
  })

  test('a later task in another folder passes one that has to wait', async () => {
    const { h, other } = two()
    const a = await start(h)
    const waits = await start(h) // same folder, in place
    const passes = await start(h, { projectDir: other })
    expect(statuses(h, a.id, waits.id, passes.id)).toEqual(['running', 'queued', 'running'])
  })

  test('a usage limit stops everything from starting, and the setting is kept between 1 and 3', async () => {
    const { h, other } = two(2)
    const a = await start(h)
    h.store.updateJob(a.id, { phase: 'limited' })
    const b = await start(h, { projectDir: other })
    expect(h.store.getJob(b.id)!.status).toBe('queued')
    h.config().parallel = 9
    expect(h.runner.parallel).toBe(3)
    h.config().parallel = 0
    expect(h.runner.parallel).toBe(1)
  })

  test('a typed message goes into the running task that has that conversation', async () => {
    const { h, other } = two()
    const a = await start(h)
    const b = await start(h, { projectDir: other })
    for (const j of [a, b]) {
      const sid = h.store.getJob(j.id)!.sessionId!
      await h.runner.onHook('SessionStart', j.id, { session_id: sid, transcript_path: `/tmp/${j.id}.jsonl` })
      await h.runner.onHook('UserPromptSubmit', j.id, { session_id: sid, permission_mode: 'auto' })
    }
    const sidB = h.store.getJob(b.id)!.sessionId!
    expect(await h.runner.typeIfFree(sidB, 'also cache it')).toBe(b.id)
    expect(h.tmux.windows.get(windowName(b.id))!.input).toContain('text:also cache it')
    expect(h.tmux.windows.get(windowName(a.id))!.input).not.toContain('text:also cache it')
    expect(await h.runner.say('and a test', a.id)).toBe(`Typed into #${a.id}.`)
    expect(await h.runner.say('x', 999)).toBe("#999 isn't running.")
  })
})
