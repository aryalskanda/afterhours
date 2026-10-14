import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacy } from '../src/cli/migrate'
import { Store } from '../src/daemon/store'

function legacyInstall(opts: { running?: boolean; config?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cq-mig-'))
  const legacyHome = join(root, '.claude-queue')
  const agentsDir = join(root, 'LaunchAgents')
  mkdirSync(join(legacyHome, 'bin'), { recursive: true })
  mkdirSync(agentsDir)
  writeFileSync(join(legacyHome, 'bin', 'cq-launcher'), 'old')
  writeFileSync(join(agentsDir, 'com.skandaaryal.claude-queue.plist'), '<plist/>')
  writeFileSync(join(legacyHome, 'config.json'), JSON.stringify(opts.config ?? { telegram: { token: 'x', ownerId: 1 } }))
  const store = new Store(join(legacyHome, 'state.db'))
  const job = store.addJob(
    { projectDir: root, prompt: 'p', plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'continue', source: 'cli' },
    1,
  )
  store.updateJob(job.id, { status: opts.running ? 'running' : 'done' })
  store.close()
  const calls: string[] = []
  const deps = {
    home: join(root, '.afterhours'),
    legacyHome,
    agentsDir,
    domain: 'gui/501',
    run: (argv: string[]) => {
      calls.push(argv.join(' '))
      return { ok: true, out: '' }
    },
    tmuxBin: '/bin/tmux',
  }
  return { root, deps, calls }
}

describe('migrating a pre-rename install', () => {
  test('moves state, stops the old service, keeps working in place', () => {
    const { deps, calls } = legacyInstall()
    const result = migrateLegacy(deps)
    expect(result.moved).toBe(true)
    expect(calls).toEqual(['launchctl bootout gui/501/com.skandaaryal.claude-queue', '/bin/tmux -L claude-queue kill-server'])
    expect(existsSync(deps.legacyHome)).toBe(false)
    expect(existsSync(join(deps.agentsDir, 'com.skandaaryal.claude-queue.plist'))).toBe(false)
    expect(existsSync(join(deps.home, 'state.db'))).toBe(true)
    expect(existsSync(join(deps.home, 'bin'))).toBe(false) // rebuilt by install
    const config = JSON.parse(readFileSync(join(deps.home, 'config.json'), 'utf8'))
    expect(config).toMatchObject({ isolate: false, telegram: { token: 'x', ownerId: 1 } })
    const db = new Database(join(deps.home, 'state.db'), { readonly: true })
    expect(db.query('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 1 })
    db.close()
  })

  test('an explicit isolate setting is kept', () => {
    const { deps } = legacyInstall({ config: { isolate: true } })
    migrateLegacy(deps)
    expect(JSON.parse(readFileSync(join(deps.home, 'config.json'), 'utf8')).isolate).toBe(true)
  })

  test('waits while a job is running', () => {
    const { deps, calls } = legacyInstall({ running: true })
    const result = migrateLegacy(deps)
    expect(result.moved).toBe(false)
    expect(result.message).toContain('still running')
    expect(calls).toEqual([])
    expect(existsSync(deps.legacyHome)).toBe(true)
  })

  test('nothing to do on fresh installs or after migrating', () => {
    const { deps } = legacyInstall()
    migrateLegacy(deps)
    expect(migrateLegacy(deps)).toEqual({ moved: false, message: null })
  })
})
