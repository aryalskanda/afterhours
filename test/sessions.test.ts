import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modeFor, modelAlias } from '../src/daemon/chats'
import { findConversation, listConversations, projectStoreDir, readConversation, renameConversation } from '../src/daemon/sessions'

// Transcript lines shaped like the ones Claude Code 2.1.29x writes.
const T0 = Date.UTC(2026, 9, 14, 9, 0)
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const user = (cwd: string, text: string, min: number, extra: object = {}) => ({
  type: 'user',
  cwd,
  timestamp: at(min),
  message: { role: 'user', content: text },
  ...extra,
})
const reply = (text: string, min: number, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  timestamp: at(min),
  message: { model, content: [{ type: 'text', text }] },
})
const limitHit = (min: number) => ({
  type: 'assistant',
  timestamp: at(min),
  isApiErrorMessage: true,
  error: 'rate_limit',
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 4:55am (Asia/Katmandu)" }] },
})

function write(claudeDir: string, cwd: string, sessionId: string, lines: object[], mtime = T0): string {
  const dir = projectStoreDir(cwd, claudeDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(path, mtime / 1000, mtime / 1000)
  return path
}

const claudeDir = () => mkdtempSync(join(tmpdir(), 'cq-claude-'))

describe('reading a conversation', () => {
  test('its store folder is the path with every other character as "-"', () => {
    expect(projectStoreDir('/Users/me/code/my.app', '/c')).toBe('/c/projects/-Users-me-code-my-app')
  })

  test('title: your name for it, then its session name, then its AI title, then the first prompt', () => {
    const dir = claudeDir()
    const cwd = '/Users/me/app'
    const lines = [user(cwd, '<pasted_content id="1">Fix the\nlogin</pasted_content>', 0), reply('ok', 1)]
    expect(readConversation(write(dir, cwd, 's1', lines))!.title).toBe('Fix the login')
    const ai = { type: 'ai-title', aiTitle: 'Login fix', sessionId: 's1' }
    expect(readConversation(write(dir, cwd, 's1', [...lines, ai]))!.title).toBe('Login fix')
    const named = { type: 'agent-name', agentName: 'Afterhours: Fix the login', sessionId: 's1' }
    expect(readConversation(write(dir, cwd, 's1', [...lines, ai, named]))!.title).toBe('Afterhours: Fix the login')
    const custom = { type: 'custom-title', customTitle: 'auth work', sessionId: 's1' }
    expect(readConversation(write(dir, cwd, 's1', [...lines, custom, ai, named]))!.title).toBe('auth work')
  })

  test('last prompt, model, permission mode, and where it ran', () => {
    const dir = claudeDir()
    const cwd = '/Users/me/app'
    const c = readConversation(
      write(dir, cwd, 's2', [
        user(cwd, 'Plan the refactor', 0, { permissionMode: 'plan' }),
        reply('Here is the plan', 1, 'claude-sonnet-5-5'),
        user(cwd, '<command-name>/compact</command-name>', 2),
        { type: 'user', isMeta: true, timestamp: at(3), message: { content: 'Caveat: …' } },
        user(cwd, 'Now do it', 4, { permissionMode: 'auto' }),
        reply('Done', 5),
        { type: 'last-prompt', lastPrompt: 'Now do it', sessionId: 's2' },
      ]),
    )!
    expect(c).toMatchObject({ sessionId: 's2', cwd, lastPrompt: 'Now do it', model: 'claude-opus-5-5', permissionMode: 'auto', limit: null })
  })

  test('a conversation that stopped on a usage limit says so until the next prompt', () => {
    const dir = claudeDir()
    const cwd = '/Users/me/app'
    const stopped = [user(cwd, 'Build it', 0, { permissionMode: 'plan' }), reply('Working', 1), limitHit(2), { type: 'last-prompt', lastPrompt: 'Build it' }]
    const c = readConversation(write(dir, cwd, 's3', stopped))!
    expect(c.limit).toEqual({ text: "You've hit your session limit · resets 4:55am (Asia/Katmandu)", at: T0 + 2 * 60_000 })
    expect(c.model).toBe('claude-opus-5-5') // the synthetic error isn't a model
    expect(readConversation(write(dir, cwd, 's3', [...stopped, user(cwd, 'continue', 9)]))!.limit).toBeNull()
  })

  test('a long transcript: the start for the first prompt, the end for the rest', () => {
    const dir = claudeDir()
    const cwd = '/Users/me/app'
    const filler = Array.from({ length: 400 }, (_, i) => reply('x'.repeat(1000), 1 + i / 100))
    const c = readConversation(write(dir, cwd, 's4', [user(cwd, 'The very first prompt', 0), ...filler, user(cwd, 'The last prompt', 9), limitHit(10)]))!
    expect(c).toMatchObject({ title: 'The very first prompt', lastPrompt: 'The last prompt', cwd })
    expect(c.limit).not.toBeNull()
  })

  test('unreadable or missing transcripts are skipped', () => {
    expect(readConversation('/definitely/not/here.jsonl')).toBeNull()
  })
})

describe('listing conversations', () => {
  test("newest first, only the folder's own, merged across folders", () => {
    const dir = claudeDir()
    const app = '/Users/me/app'
    const tree = '/Users/me/app/.claude/worktrees/afterhours-3'
    write(dir, app, 'old', [user(app, 'old one', 0)], T0)
    write(dir, app, 'new', [user(app, 'new one', 0)], T0 + 3_600_000)
    write(dir, tree, 'tree', [user(tree, 'in a worktree', 0)], T0 + 60_000)
    // "/Users/me-app" has the same store folder as "/Users/me/app"; the recorded folder tells them apart.
    write(dir, '/Users/me-app', 'other', [user('/Users/me-app', 'elsewhere', 0)], T0 + 7_200_000)
    expect(projectStoreDir('/Users/me-app', dir)).toBe(projectStoreDir(app, dir))
    expect(listConversations([app], 10, dir).map(c => c.sessionId)).toEqual(['new', 'old'])
    expect(listConversations([app, tree], 10, dir).map(c => c.sessionId)).toEqual(['new', 'tree', 'old'])
    expect(listConversations([app, tree], 2, dir).map(c => c.sessionId)).toEqual(['new', 'tree'])
    expect(listConversations(['/Users/me/nothing'], 10, dir)).toEqual([])
  })

  test('finds a conversation by id wherever it ran', () => {
    const dir = claudeDir()
    write(dir, '/Users/me/app', 'abc-123', [user('/Users/me/app', 'hello', 0)])
    expect(findConversation('abc-123', dir)).toMatchObject({ sessionId: 'abc-123', cwd: '/Users/me/app', title: 'hello' })
    expect(findConversation('abc', dir)).toBeNull()
  })

  test('renamed as Claude Code’s /rename does: the new title, here and in Claude Code', () => {
    const dir = claudeDir()
    write(dir, '/Users/me/app', 'abc-123', [user('/Users/me/app', 'hello', 0)])
    expect(renameConversation('abc-123', 'Checkout speed', dir)).toBe(true)
    expect(findConversation('abc-123', dir)?.title).toBe('Checkout speed')
    expect(renameConversation('nope', 'x', dir)).toBe(false)
  })
})

describe('continuing a chat from its last state', () => {
  test('mode from its last permission mode: plans come to you for review', () => {
    expect(modeFor('plan')).toEqual({ plan: true, review: true, execMode: 'auto' })
    expect(modeFor('acceptEdits')).toEqual({ plan: false, review: false, execMode: 'acceptEdits' })
    expect(modeFor('bypassPermissions')).toEqual({ plan: false, review: false, execMode: 'bypassPermissions' })
    expect(modeFor('auto')).toEqual({ plan: false, review: false, execMode: 'auto' })
    expect(modeFor('default')).toEqual({ plan: false, review: false, execMode: 'auto' })
    expect(modeFor(null)).toEqual({ plan: false, review: false, execMode: 'auto' })
  })

  test('model family from its last model', () => {
    expect(modelAlias('claude-opus-5-5')).toBe('opus')
    expect(modelAlias('claude-haiku-5-5')).toBe('haiku')
    expect(modelAlias('some-other-model')).toBeNull()
    expect(modelAlias(null)).toBeNull()
  })
})
