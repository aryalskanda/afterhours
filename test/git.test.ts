import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchSlug, git } from '../src/daemon/system'

function sh(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-git-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'test@example.com')
  sh(root, 'config', 'user.name', 'Test')
  mkdirSync(join(root, 'web'))
  writeFileSync(join(root, 'web', 'app.js'), 'console.log(1)\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'init')
  return root
}

test('branchSlug', () => {
  expect(branchSlug('Add a dark mode toggle to the settings page!')).toBe('add-a-dark-mode-toggle')
  expect(branchSlug('🚀🚀')).toBe('task')
})

test('a task gets its own branch and worktree, and its work is committed there', async () => {
  const root = repo()
  const base = sh(root, 'rev-parse', 'HEAD')
  const wt = await git.worktree(join(root, 'web'), 7, 'Add dark mode')
  expect(wt).not.toBeNull()
  const worktree = join(sh(root, 'rev-parse', '--show-toplevel'), '.claude', 'worktrees', 'afterhours-7')
  expect(wt).toEqual({ dir: join(worktree, 'web'), branch: 'afterhours/7-add-dark-mode', base })
  expect(existsSync(join(wt!.dir, 'app.js'))).toBe(true)
  // Your checkout is untouched and its status stays clean.
  expect(sh(root, 'status', '--porcelain')).toBe('')
  expect(sh(root, 'branch', '--show-current')).toBe('main')

  writeFileSync(join(wt!.dir, 'dark.css'), 'body { background: #000 }\n')
  expect(await git.commitAll(wt!.dir, 'Afterhours #7: Add dark mode')).toBe(true)
  expect(sh(root, 'log', '-1', '--format=%s', 'afterhours/7-add-dark-mode')).toBe('Afterhours #7: Add dark mode')
  expect(await git.commitAll(wt!.dir, 'nothing new')).toBe(false)
  expect(await git.diffStat(wt!.dir, base)).toBe('1 file changed, 1 insertion(+)')
})

test('no worktree outside git or before the first commit', async () => {
  expect(await git.worktree(mkdtempSync(join(tmpdir(), 'cq-plain-')), 1, 'x')).toBeNull()
  const empty = mkdtempSync(join(tmpdir(), 'cq-empty-'))
  sh(empty, 'init', '-q')
  expect(await git.worktree(empty, 1, 'x')).toBeNull()
})
