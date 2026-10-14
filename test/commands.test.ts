import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat } from '../src/daemon/chats'
import { applyOption, parseQueueText, runCommand, type QueueOptions } from '../src/daemon/commands'
import type { Runner } from '../src/daemon/runner'
import { Store } from '../src/daemon/store'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'

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

  test('full model ids and aliases are case-insensitive', () => {
    expect(apply('claude-opus-5-5').o.model).toBe('claude-opus-5-5')
    expect(apply('NACHO').o.project).toBe(project)
  })

  test('session ids need a few characters', () => {
    expect(apply('@abc').ok).toBe(false)
    expect(apply('@9a7a2477').o).toEqual({ policy: 'session', sessionId: '9a7a2477' })
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
    chats: { list: () => list, get: () => null },
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
