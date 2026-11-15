import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyOption, type QueueOptions } from '../src/daemon/commands'
import { detectModels, modelsFromInitialize, offeredModels, setDetectedModels } from '../src/daemon/models'
import { DEFAULT_CONFIG } from '../src/shared/config'

const reply = (models: unknown) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'models', response: { commands: [], models } } })
const CLAUDE = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus', displayName: 'Opus 5.5' },
  { value: 'sonnet', displayName: 'Sonnet 5.5' },
  { value: 'fable', displayName: 'Fable 5.2' },
  { value: 'haiku', displayName: 'Haiku 5.5' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
]

afterEach(() => setDetectedModels(null))

describe('what Claude Code says it offers', () => {
  test('the short names, in its order, without "default" or the pinned versions', () => {
    expect(modelsFromInitialize(reply(CLAUDE))).toEqual(['opus', 'sonnet', 'fable', 'haiku'])
  })

  test('anything else is no answer', () => {
    expect(modelsFromInitialize('not json')).toBeNull()
    expect(modelsFromInitialize(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(modelsFromInitialize(reply(undefined))).toBeNull()
    expect(modelsFromInitialize(reply([]))).toBeNull()
    expect(modelsFromInitialize(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'no' } }))).toBeNull()
  })
})

describe('what is offered', () => {
  const config = { models: ['opus', 'sonnet', 'haiku', 'claude-opus-4-8'], defaults: { ...DEFAULT_CONFIG.defaults, model: 'sonnet' } }

  test("Claude Code's models first, then the ones added in config.json", () => {
    expect(offeredModels(config, ['opus', 'sonnet', 'fable', 'haiku'])).toEqual(['opus', 'sonnet', 'fable', 'haiku', 'claude-opus-4-8'])
  })

  test('without an answer, the list in config.json', () => {
    expect(offeredModels(config, null)).toEqual(['opus', 'sonnet', 'haiku', 'claude-opus-4-8'])
  })

  test('the defaults are always there', () => {
    expect(offeredModels({ models: [], defaults: { ...DEFAULT_CONFIG.defaults, model: 'best', workModel: 'claude-sonnet-5' } }, ['opus'])).toEqual(['opus', 'best', 'claude-sonnet-5'])
  })

  test('a model newer than the typed shortcut knows is still an option word', () => {
    const out: QueueOptions = {}
    expect(applyOption('saga', DEFAULT_CONFIG, out)).toBe(false)
    setDetectedModels(['opus', 'saga'])
    expect(applyOption('saga', DEFAULT_CONFIG, out)).toBe(true)
    expect(out.model).toBe('saga')
    expect(applyOption('opus>saga', DEFAULT_CONFIG, out)).toBe(true)
    expect(out.workModel).toBe('saga')
  })
})

describe.skipIf(process.platform === 'win32')('asking Claude Code', () => {
  const script = (body: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'cq-models-')), 'claude')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('it answers the initialize request, and is stopped', async () => {
    const claude = script(`read line\ncase "$line" in *initialize*) echo '{"type":"system","subtype":"hook"}'; echo '${reply(CLAUDE)}';; esac\nsleep 30`)
    const started = Date.now()
    expect(await detectModels(claude)).toEqual(['opus', 'sonnet', 'fable', 'haiku'])
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('one that says nothing, exits, or is missing gives no list', async () => {
    expect(await detectModels(script('sleep 30'), 300)).toBeNull()
    expect(await detectModels(script('exit 1'))).toBeNull()
    expect(await detectModels('/nonexistent/claude')).toBeNull()
  })
})
