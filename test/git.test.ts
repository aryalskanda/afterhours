import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchSlug, git, parseDiffLists } from '../src/daemon/system'

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

describe('a task’s exact changes, from snapshots of its folder', () => {
  test('snapshots catch edits, new and deleted files, and never touch your index or refs', async () => {
    const root = repo()
    writeFileSync(join(root, 'web', 'app.js'), 'console.log(1)\nconsole.log("dirty before the task")\n')
    writeFileSync(join(root, 'notes.txt'), 'yours, untracked, before the task\n')
    const status = sh(root, 'status', '--porcelain')
    const refs = sh(root, 'for-each-ref')
    const start = await git.snapshot(join(root, 'web'))
    expect(start).toMatch(/^[0-9a-f]{40}$/)
    // What the task does.
    writeFileSync(join(root, 'web', 'app.js'), 'console.log(1)\nconsole.log("dirty before the task")\nexport const csv = true\n')
    writeFileSync(join(root, 'web', 'csv.js'), 'export function toCsv(rows) {\n  return rows.join("\\n")\n}\n')
    rmSync(join(root, 'notes.txt'))
    const end = await git.snapshot(join(root, 'web'))
    expect(end).not.toBe(start)
    // Your index, refs and status are as they were (the new files are the task's, on disk).
    expect(sh(root, 'diff', '--cached', '--name-only')).toBe('')
    expect(sh(root, 'for-each-ref')).toBe(refs)
    expect(status).toContain('notes.txt')

    const changes = await git.changes(join(root, 'web'), start!, end!)
    expect(changes).toEqual({
      truncated: false,
      files: [
        { path: 'notes.txt', status: 'deleted', added: 0, removed: 1, binary: false },
        { path: 'web/app.js', status: 'modified', added: 1, removed: 0, binary: false },
        { path: 'web/csv.js', status: 'added', added: 3, removed: 0, binary: false },
      ],
    })
    // Only the task's line: the edit you made before it started isn't part of its diff.
    const patch = await git.patch(join(root, 'web'), start!, end!, 'web/app.js')
    expect(patch?.binary).toBe(false)
    expect(patch?.patch).toContain('+export const csv = true')
    expect(patch?.patch).not.toContain('+console.log("dirty')
    expect(new TextDecoder().decode((await git.show(root, end!, 'web/csv.js'))!)).toContain('toCsv')
    expect(await git.show(root, end!, 'notes.txt')).toBeNull()
  })

  test('renames, binary files, and folders outside git', async () => {
    const root = repo()
    writeFileSync(join(root, 'web', 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    const start = await git.snapshot(root)
    renameSync(join(root, 'web', 'app.js'), join(root, 'web', 'main.js'))
    writeFileSync(join(root, 'web', 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]))
    const end = await git.snapshot(root)
    const changes = await git.changes(root, start!, end!)
    expect(changes?.files).toEqual([
      { path: 'web/logo.png', status: 'modified', added: null, removed: null, binary: true },
      { path: 'web/main.js', from: 'web/app.js', status: 'renamed', added: 0, removed: 0, binary: false },
    ])
    expect((await git.patch(root, start!, end!, 'web/logo.png'))?.binary).toBe(true)
    expect((await git.patch(root, start!, end!, 'web/main.js', 'web/app.js'))?.patch).toContain('rename to web/main.js')
    expect(await git.snapshot(mkdtempSync(join(tmpdir(), 'cq-plain-')))).toBeNull()
    expect(await git.treeOf(root, sh(root, 'rev-parse', 'HEAD'))).toBe(sh(root, 'rev-parse', 'HEAD^{tree}'))
    expect(await git.top(join(root, 'web'))).toBe(sh(root, 'rev-parse', '--show-toplevel'))
  })

  test('parseDiffLists reads git’s -z output', () => {
    expect(parseDiffLists('2\t1\ta.ts\0-\t-\timg.png\0' + '0\t0\t\0old.ts\0new.ts\0', 'M\0a.ts\0M\0img.png\0R100\0old.ts\0new.ts\0')).toEqual([
      { path: 'a.ts', status: 'modified', added: 2, removed: 1, binary: false },
      { path: 'img.png', status: 'modified', added: null, removed: null, binary: true },
      { path: 'new.ts', from: 'old.ts', status: 'renamed', added: 0, removed: 0, binary: false },
    ])
  })
})
