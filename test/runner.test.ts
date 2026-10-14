import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Notice } from '../src/daemon/notify'
import { canTakeOver, Runner, windowName } from '../src/daemon/runner'
import type { LiveSession } from '../src/daemon/sessions'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import type { JobSpec } from '../src/shared/types'
import { FakeTmux } from './fakes'
import { PLAN_SCREEN, TRUST_SCREEN, TRUST_SCREEN_YES } from './fixtures'

function setup(timeouts: Partial<Config['timeouts']> = {}, opts: { gitRepo?: boolean } = {}) {
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
  /** Windows that ignore being asked to close. */
  let stubborn = false
  const runner = new Runner({
    store,
    tmux,
    notify: n => notices.push(n),
    config: () => config,
    saveConfig: c => {
      config = c
    },
    now: () => now,
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
    },
    killPid: pid => {
      killed.push(pid)
      if (!stubborn) holders = holders.filter(h => h.pid !== pid)
    },
    log: line => logs.push(line),
    sleep: async () => {},
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
    expect(h.gitCalls).toEqual([`worktree #${j.id}`, `commit ${worktree} Afterhours #${j.id}: Add dark mode`])
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
    expect(h.gitCalls.at(-1)).toBe(`commit ${worktree} Afterhours #${second.id}: And add tests`)
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
    expect(h.gitCalls.at(-1)).toBe(`commit ${worktree} Afterhours #${followUp.id}: Create hello.txt`)
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
    expect(await h.runner.skip()).toBe(`Skipped #${j.id}. Next up: #${j.id + 1}.`)
    await h.runner.tick()
    expect(h.store.active()?.id).toBe(j.id + 1)
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
