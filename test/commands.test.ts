import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat } from '../src/daemon/chats'
import { applyOption, parseQueueText, runCommand, type QueueOptions } from '../src/daemon/commands'
import { PowerControl } from '../src/daemon/power'
import type { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import { FakePower } from './fakes'

const project = mkdtempSync(join(tmpdir(), 'cq-proj-'))
const config: Config = { ...DEFAULT_CONFIG, aliases: { nacho: project } }

describe('parseQueueText', () => {
  test('options before the colon', () => {
    const { options, prompt } = parseQueueText('nacho plan opus max: add CSV export to reports', config)
    expect(prompt).toBe('add CSV export to reports')
    expect(options).toEqual({ project, plan: true, review: false, model: 'opus', effort: 'max' })
  })

  test('no colon: the whole text is the prompt', () => {
    expect(parseQueueText('fix the flaky login test', config)).toEqual({ options: {}, prompt: 'fix the flaky login test' })
  })

  test('a colon inside the prompt with non-option words stays prompt', () => {
    expect(parseQueueText('fix: the login bug', config).prompt).toBe('fix: the login bug')
    expect(parseQueueText('nacho please: do it', config).options).toEqual({})
  })

  test('only the first colon splits', () => {
    const { options, prompt } = parseQueueText('auto: rename foo: bar to baz', config)
    expect(options.execMode).toBe('auto')
    expect(options.plan).toBe(false)
    expect(prompt).toBe('rename foo: bar to baz')
  })

  test('compound modes, efforts, session flags', () => {
    const { options } = parseQueueText('review+yolo sonnet med new now: x', config)
    expect(options).toEqual({
      plan: true,
      review: true,
      execMode: 'bypassPermissions',
      model: 'sonnet',
      effort: 'medium',
      policy: 'new',
      front: true,
    })
  })
})

describe('applyOption', () => {
  const apply = (t: string) => {
    const o: QueueOptions = {}
    return { ok: applyOption(t, config, o), o }
  }

  test('modes', () => {
    expect(apply('edits').o).toEqual({ plan: false, review: false, execMode: 'acceptEdits' })
    expect(apply('plan+edits').o).toEqual({ plan: true, review: false, execMode: 'acceptEdits' })
    expect(apply('plan+nope').ok).toBe(false)
  })

  test('plan with one model, work with another: opus>sonnet', () => {
    expect(apply('opus>sonnet').o).toEqual({ model: 'opus', workModel: 'sonnet', plan: true })
    expect(apply('claude-opus-5-5>haiku').o).toMatchObject({ model: 'claude-opus-5-5', workModel: 'haiku' })
    expect(apply('opus>nonsense').ok).toBe(false)
  })

  test('plan at one effort, work at another: max>medium', () => {
    expect(apply('max>medium').o).toEqual({ effort: 'max', workEffort: 'medium', plan: true })
    expect(apply('max>nonsense').ok).toBe(false)
  })

  test('full model ids and aliases are case-insensitive', () => {
    expect(apply('claude-opus-5-5').o.model).toBe('claude-opus-5-5')
    expect(apply('NACHO').o.project).toBe(project)
  })

  test('session ids need a few characters', () => {
    expect(apply('@abc').ok).toBe(false)
    expect(apply('@9a7a2477').o).toEqual({ policy: 'session', sessionId: '9a7a2477' })
  })

  test('ask: a read-only question, no plan', () => {
    expect(apply('ask').o).toEqual({ plan: false, review: false, execMode: 'plan' })
  })

  test('take: close the conversation where it is open and continue it here', () => {
    expect(apply('take').o).toEqual({ takeover: true })
    const { options, prompt } = parseQueueText('@9a7a2477 take: continue', config)
    expect(options).toEqual({ policy: 'session', sessionId: '9a7a2477', takeover: true })
    expect(prompt).toBe('continue')
  })

  test('absolute paths must be folders', () => {
    expect(apply(project).o.project).toBe(project)
    expect(apply('/definitely/not/here').ok).toBe(false)
  })
})

describe('chats', () => {
  const now = Date.UTC(2026, 9, 14, 12, 0)
  const chat = (over: Partial<Chat>): Chat => ({
    sessionId: '4887cfe0-2e43-4615-a7c6-5688b3f086fd',
    cwd: project,
    title: 'Claude Code prompt queue optimizer',
    lastPrompt: null,
    lastReply: null,
    updatedAt: now - 2 * 3_600_000,
    model: null,
    permissionMode: null,
    limit: null,
    where: null,
    busy: false,
    running: false,
    ...over,
  })
  const ctx = (list: Chat[]) => ({
    runner: {} as Runner,
    store: new Store(':memory:'),
    config: () => config,
    saveConfig: () => {},
    now: () => now,
    source: 'cli' as const,
    cwd: project,
    chats: { list: () => list, recent: () => ({ chats: list, more: false }), get: () => null, rename: () => false },
  })

  test('lists the folder\'s chats with the ids q @<id>: takes', async () => {
    const reply = await runCommand('chats', ctx([
      chat({ where: 'VS Code', limit: { text: 'resets 4:55am', at: now - 60_000 } }),
      chat({ sessionId: '6a53d062-2479-4990-809e-dea4f6a92cb0', title: 'Older', updatedAt: now - 86_400_000 }),
    ]))
    expect(reply).toBe(
      [
        'Chats in nacho, newest first:',
        '@4887cfe0 Claude Code prompt queue optimizer · open in VS Code · stopped at a usage limit · 2h 00m ago',
        '@6a53d062 Older · 24h 00m ago',
        "Continue one: q @4887cfe0: <prompt> (add take to close it where it's open first)",
      ].join('\n'),
    )
  })

  test('an empty folder, and an unknown one', async () => {
    expect(await runCommand('chats', ctx([]))).toBe('No Claude Code chats in nacho yet.')
    expect(await runCommand('chats /definitely/not/here', ctx([]))).toBe('Folder not found: /definitely/not/here')
  })
})

describe('sleeping, in text', () => {
  const ctx = (sys: FakePower | null) => {
    const store = new Store(':memory:')
    const runner = { paused: false } as Runner
    const notices: string[] = []
    const mac = sys
      ? new PowerControl({ system: sys, store, runner, config: () => config, saveConfig: () => {}, notify: n => notices.push(n.type), now: Date.now, log: () => {}, later: () => {} })
      : null
    return { notices, ctx: { runner, store, config: () => config, saveConfig: () => {}, now: Date.now, source: 'imessage' as const, mac } }
  }

  test('sleep, sleep done and sleep cancel; with nothing to sleep, a plain no', async () => {
    const { ctx: c, notices } = ctx(new FakePower('linux'))
    expect(await runCommand('sleep done', c)).toBe('The computer sleeps once the queue is done.')
    expect(await runCommand('sleep cancel', c)).toBe('The computer stays awake after the queue is done.')
    expect(await runCommand('sleep', c)).toContain('Going to sleep.')
    expect(notices).toEqual(['sleeping'])
    expect(await runCommand('sleep', ctx(null).ctx)).toBe('There is nothing here to sleep (a container).')
  })

  test('apps and quit are not commands any more', async () => {
    const { ctx: c } = ctx(new FakePower())
    expect(await runCommand('apps', c)).toBeNull()
    expect(await runCommand('quit Mail', c)).toBeNull()
  })
})

describe('more than one task at once', () => {
  const spec = (dir: string) => ({ projectDir: dir, prompt: 'x', plan: false, review: false, execMode: 'auto' as const, model: 'haiku', effort: 'low' as const, sessionPolicy: 'new' as const, source: 'test' })
  function setup(parallel = 1) {
    let saved: Config = { ...config, parallel }
    const store = new Store(':memory:')
    const calls: string[] = []
    const runner = {
      get parallel() {
        return saved.parallel
      },
      paused: false,
      stop: async (id?: number) => (calls.push(`stop ${id}`), 'stopped'),
      say: async (text: string, id?: number) => (calls.push(`say ${id} ${text}`), 'typed'),
      kill: async (id: number) => (calls.push(`kill ${id}`), 'killed'),
      collision: () => null,
      limits: () => ({}),
      runtimeInfo: () => null,
    } as unknown as Runner
    return { store, runner, calls, saved: () => saved, ctx: { runner, store, config: () => saved, saveConfig: (c: Config) => (saved = c), now: () => Date.now(), source: 'cli' as const, cwd: project } }
  }

  test('parallel shows and sets how many, 1 to 3', async () => {
    const t = setup()
    expect(await runCommand('parallel', t.ctx)).toContain('Up to 1 task at once')
    expect(await runCommand('parallel 2', t.ctx)).toContain('Up to 2 tasks at once')
    expect(t.saved().parallel).toBe(2)
    expect(await runCommand('parallel 5', t.ctx)).toBe('Usage: parallel 1, 2 or 3.')
    expect(await runCommand('parallel 1', t.ctx)).toContain('One task at a time')
  })

  test('with several running, a command that acts on one asks which; naming it does it', async () => {
    const t = setup(2)
    for (const dir of [project, join(project, 'b')]) t.store.updateJob(t.store.addJob(spec(dir), 1).id, { status: 'running' })
    expect(await runCommand('stop', t.ctx)).toBe('Several are running (#1, #2): stop #<number>.')
    expect(await runCommand('kill', t.ctx)).toBe('Several are running (#1, #2): kill <number>.')
    expect(await runCommand('say hello', t.ctx)).toBe('Several are running (#1, #2): say #<number> <text>.')
    expect(t.calls).toEqual([])
    expect(await runCommand('stop #2', t.ctx)).toBe('stopped')
    expect(await runCommand('say #1 hello there', t.ctx)).toBe('typed')
    expect(await runCommand('kill 2', t.ctx)).toBe('killed')
    expect(t.calls).toEqual(['stop 2', 'say 1 hello there', 'kill 2'])
    // Status lists both.
    const status = await runCommand('st', t.ctx)
    expect(status!.split('\n').filter(l => l.startsWith('▶')).length).toBe(2)
    expect(status).toContain('Up to 2 tasks at once.')
  })
})
