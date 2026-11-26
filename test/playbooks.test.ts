import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_STEPS, parseSteps, Playbooks, type PlaybookStep } from '../src/daemon/playbooks'
import { Store } from '../src/daemon/store'
import type { CommandContext } from '../src/daemon/commands'
import type { Runner } from '../src/daemon/runner'
import { DEFAULT_CONFIG, type Config } from '../src/shared/config'
import type { JobSpec } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'cq-pb-'))
const shop = join(root, 'shop')
const web = join(root, 'web')
mkdirSync(shop)
mkdirSync(web)

const step = (folder: string, prompt: string, over: Partial<PlaybookStep> = {}): PlaybookStep => ({ folder, prompt, plan: false, review: false, mode: 'auto', model: 'sonnet', effort: 'high', ...over })

function setup() {
  const store = new Store(':memory:')
  let now = 1_000
  const runner = { enqueue: (spec: JobSpec) => store.addJob(spec, now++) }
  const logs: string[] = []
  const pb = new Playbooks({ store, runner, now: () => now, log: l => void logs.push(l), isolate: () => true })
  return { store, pb, logs }
}

describe('playbooks', () => {
  test('saved under a name; the same name replaces it; removed', () => {
    const { pb } = setup()
    const a = pb.save({ name: 'Release', steps: [step(shop, 'Run the tests')] })
    expect(a).toMatchObject({ ok: true, playbook: { id: 'release', name: 'Release' } })
    pb.save({ name: 'release', steps: [step(shop, 'Run the tests'), step(web, 'Changelog')] })
    expect(pb.list()).toHaveLength(1)
    expect(pb.get('Release')!.steps).toHaveLength(2)
    expect(pb.save({ name: 'Two', steps: [] })).toEqual({ ok: false, error: 'A playbook needs at least one step.' })
    expect(pb.save({ name: 'Big', steps: Array.from({ length: MAX_STEPS + 1 }, () => step(shop, 'x')) }).ok).toBe(false)
    expect(pb.save({ name: 'Blank', steps: [step(shop, 'x'), step(shop, '  ')] })).toEqual({ ok: false, error: 'Step 2 has no prompt.' })
    expect(pb.remove('release')).toBe(true)
    expect(pb.list()).toEqual([])
  })

  test('run: every step queued at once, each with its own folder, model and effort, each after the one before', () => {
    const { pb, store } = setup()
    pb.save({ name: 'Release', steps: [step(shop, 'Run the tests', { model: 'sonnet', effort: 'high' }), step(web, 'Update the changelog', { model: 'haiku', effort: 'low', fresh: true }), step(shop, 'Notes', { model: 'opus', effort: 'max', plan: true })] })
    const r = pb.run('release', { source: 'telegram' })
    if (!r.ok) throw new Error(r.error)
    const [a, b, c] = r.jobs
    expect(store.queued().map(j => [j.projectDir, j.model, j.effort, j.afterJob, j.sessionPolicy, j.plan])).toEqual([
      [shop, 'sonnet', 'high', null, 'continue', false],
      [web, 'haiku', 'low', a!.id, 'new', false],
      [shop, 'opus', 'max', b!.id, 'continue', true],
    ])
    expect(new Set(r.jobs.map(j => j.group)).size).toBe(1)
    expect(r.text).toBe(`Playbook Release queued: 3 steps, #${a!.id} → #${b!.id} → #${c!.id}.`)
  })

  test('a folder that is gone or not allowed queues nothing', () => {
    const { pb, store } = setup()
    pb.save({ name: 'Gone', steps: [step(shop, 'a'), step(join(root, 'nope'), 'b')] })
    expect(pb.run('gone', { source: 'x' })).toEqual({ ok: false, error: `Step 2: the folder ${join(root, 'nope')} isn't there any more.` })
    pb.save({ name: 'Mixed', steps: [step(shop, 'a'), step(web, 'b')] })
    expect(pb.run('mixed', { source: 'x', allowed: s => (s.folder === web ? 'not a folder apps may use' : null) })).toEqual({ ok: false, error: 'Step 2: not a folder apps may use' })
    expect(store.queued()).toEqual([])
    expect(pb.run('missing', { source: 'x' })).toEqual({ ok: false, error: 'No such playbook.' })
  })
})

describe('steps written as in Telegram', () => {
  const config: Config = { ...DEFAULT_CONFIG, aliases: { shop }, defaults: { ...DEFAULT_CONFIG.defaults, model: 'sonnet', effort: 'high' } }
  const ctx = { config: () => config, store: new Store(':memory:'), source: 'remote' } as unknown as CommandContext
  const find = async (name: string) => (name === 'web' ? web : null)

  test('alias or folder name, model, effort and mode; a line without a folder uses the one before', async () => {
    const r = await parseSteps(['shop sonnet high: Run the tests and fix what fails', 'web haiku low: Update the changelog', '3. opus max plan: Write the release notes', ''], ctx, find)
    if ('error' in r) throw new Error(r.error)
    expect(r.steps.map(s => [s.folder, s.model, s.effort, s.plan, s.prompt])).toEqual([
      [shop, 'sonnet', 'high', expect.any(Boolean), 'Run the tests and fix what fails'],
      [web, 'haiku', 'low', expect.any(Boolean), 'Update the changelog'],
      [web, 'opus', 'max', true, 'Write the release notes'],
    ])
  })

  test("a line it can't read is named, and nothing is kept", async () => {
    expect(await parseSteps(['shop: a', 'blog nonsense: b'], ctx, find)).toEqual({ error: 'Line 2: I don\'t know "blog nonsense" (a folder, model, effort or mode).' })
    expect(await parseSteps(['Fix it'], ctx, find)).toMatchObject({ error: expect.stringContaining('Line 1: which folder?') })
    expect(await parseSteps([''], ctx, find)).toEqual({ error: 'No steps: put one per line after the name.' })
  })
})
