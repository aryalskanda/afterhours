import type { Subprocess } from 'bun'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BRAND } from '../shared/brand'
import { cleanEnv } from '../shared/config'

export interface Worktree {
  /** Where Claude runs: the worktree, or the subfolder matching the one you picked. */
  dir: string
  branch: string
  /** The commit it started from. */
  base: string
}

/** "Add a dark mode toggle!" → "add-a-dark-mode-toggle". */
export function branchSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'task'
}

async function run(argv: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd, env: cleanEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out }
}

export const git = {
  async head(dir: string): Promise<string | null> {
    const r = await run(['git', '-C', dir, 'rev-parse', 'HEAD'])
    return r.code === 0 ? r.out.trim() : null
  },

  /** "3 files changed, 120 insertions(+), 8 deletions(-) · 2 new files" since `since` (or HEAD). */
  async diffStat(dir: string, since: string | null): Promise<string | null> {
    const inside = await run(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0) return null
    const diff = await run(['git', '-C', dir, 'diff', '--shortstat', since ?? 'HEAD'])
    const untracked = await run(['git', '-C', dir, 'ls-files', '--others', '--exclude-standard'])
    const newFiles = untracked.code === 0 ? untracked.out.split('\n').filter(Boolean).length : 0
    const parts = [diff.code === 0 ? diff.out.trim() : '', newFiles > 0 ? `${newFiles} untracked file${newFiles === 1 ? '' : 's'}` : '']
    const text = parts.filter(Boolean).join(' · ')
    return text || 'no file changes'
  },

  /**
   * A new branch in its own worktree under <repo>/.claude/worktrees (where Claude Code keeps its
   * own), starting from your last commit. Null when the folder isn't a git repo with a commit.
   */
  async worktree(projectDir: string, jobId: number, prompt: string): Promise<Worktree | null> {
    const top = await run(['git', '-C', projectDir, 'rev-parse', '--show-toplevel'])
    if (top.code !== 0) return null
    const root = top.out.trim()
    const head = await run(['git', '-C', root, 'rev-parse', 'HEAD'])
    if (head.code !== 0) return null // no commits yet
    const parent = join(root, '.claude', 'worktrees')
    mkdirSync(parent, { recursive: true })
    // Keeps the worktrees out of your repo's `git status`.
    const ignore = join(parent, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    const dir = join(parent, `${BRAND.slug}-${jobId}`)
    const branch = `${BRAND.slug}/${jobId}-${branchSlug(prompt)}`
    const add = await run(['git', '-C', root, 'worktree', 'add', '-b', branch, dir, 'HEAD'])
    if (add.code !== 0) return null
    const rel = relative(root, realpathSync(projectDir))
    return { dir: rel && !rel.startsWith('..') ? join(dir, rel) : dir, branch, base: head.out.trim() }
  },

  /** Commits everything changed in a task's worktree, so its branch holds the work. */
  async commitAll(dir: string, message: string): Promise<boolean> {
    await run(['git', '-C', dir, 'add', '-A'])
    const unchanged = await run(['git', '-C', dir, 'diff', '--cached', '--quiet'])
    if (unchanged.code === 0) return false
    return (await run(['git', '-C', dir, 'commit', '--no-verify', '-m', message])).code === 0
  },
}

/** Holds a `caffeinate -i` assertion (no idle sleep) while there's queued or running work. */
export class KeepAwake {
  private proc: Subprocess | null = null

  set(on: boolean): void {
    if (on && !this.proc) {
      this.proc = Bun.spawn(['caffeinate', '-i', '-w', String(process.pid)], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    } else if (!on && this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}
