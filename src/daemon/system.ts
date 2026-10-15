import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { DiffFile } from '@afterhours/protocol'
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

/** Runs git with extra environment and a time limit; stdout as bytes. A timeout counts as failure. */
async function gitBytes(argv: string[], o: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; out: Uint8Array }> {
  const proc = Bun.spawn(['git', ...argv], { env: { ...cleanEnv(), ...o.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 30_000)
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
    return { code, out: new Uint8Array(out) }
  } finally {
    clearTimeout(timer)
  }
}

async function gitText(argv: string[], o: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  const r = await gitBytes(argv, o)
  return { code: r.code, out: new TextDecoder().decode(r.out) }
}

/** The top of the repo `dir` is in, or null outside git. */
async function topLevel(dir: string): Promise<string | null> {
  const r = await gitText(['-C', dir, 'rev-parse', '--show-toplevel'])
  return r.code === 0 ? r.out.trim() : null
}

/** Most files a diff lists; a task that touched more says so. */
const MAX_DIFF_FILES = 500
/** Biggest single-file diff sent to a phone. */
const MAX_PATCH_BYTES = 300 * 1024

/** `git diff -z --numstat` and `--name-status` merged into one entry per file. */
export function parseDiffLists(numstat: string, nameStatus: string): DiffFile[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const n = numstat.split('\0')
  for (let i = 0; i < n.length; i++) {
    const head = n[i]
    if (!head) continue
    const [a, r, path] = head.split('\t')
    const added = a === '-' ? null : Number(a)
    const removed = r === '-' ? null : Number(r)
    if (path === '') {
      // A rename: the old and new paths follow as their own fields.
      const to = n[i + 2] ?? ''
      i += 2
      counts.set(to, { added, removed })
    } else if (path !== undefined) {
      counts.set(path, { added, removed })
    }
  }
  const files: DiffFile[] = []
  const f = nameStatus.split('\0')
  for (let i = 0; i < f.length; i++) {
    const code = f[i]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const from = f[i + 1] ?? ''
      const to = f[i + 2] ?? ''
      i += 2
      const c = counts.get(to) ?? { added: null, removed: null }
      files.push({ path: to, from, status: letter === 'R' ? 'renamed' : 'added', added: c.added, removed: c.removed, binary: c.added === null })
      continue
    }
    const path = f[i + 1] ?? ''
    i += 1
    const c = counts.get(path) ?? { added: null, removed: null }
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    files.push({ path, status, added: c.added, removed: c.removed, binary: c.added === null && c.removed === null })
  }
  return files
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

  /**
   * The folder's files as they are now, as a git tree in the repo's object store: everything
   * tracked plus untracked files that aren't ignored. Uses a scratch copy of the index, so your
   * index, refs and files are never touched. Null outside git, or when it takes too long.
   */
  async snapshot(dir: string): Promise<string | null> {
    if (!existsSync(dir)) return null
    const where = await gitText(['-C', dir, 'rev-parse', '--git-path', 'index'])
    if (where.code !== 0) return null
    const index = resolve(dir, where.out.trim())
    const scratch = join(tmpdir(), `afterhours-index-${process.pid}-${randomUUID()}`)
    try {
      if (existsSync(index)) copyFileSync(index, scratch)
      const env = { GIT_INDEX_FILE: scratch }
      const add = await gitText(['-C', dir, 'add', '-A'], { env, timeoutMs: 60_000 })
      if (add.code !== 0) return null
      const tree = await gitText(['-C', dir, 'write-tree'], { env })
      return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(tree.out.trim()) ? tree.out.trim() : null
    } finally {
      rmSync(scratch, { force: true })
      rmSync(`${scratch}.lock`, { force: true })
    }
  },

  /** What changed from tree (or commit) `from` to `to`, paths relative to the repo's top. */
  async changes(dir: string, from: string, to: string): Promise<{ files: DiffFile[]; truncated: boolean } | null> {
    const top = await topLevel(dir)
    if (!top) return null
    const base = ['-C', top, 'diff', '--no-color', '--no-ext-diff', '-M', '-z']
    const [numstat, names] = await Promise.all([gitText([...base, '--numstat', from, to]), gitText([...base, '--name-status', from, to])])
    if (numstat.code !== 0 || names.code !== 0) return null
    const files = parseDiffLists(numstat.out, names.out)
    return { files: files.slice(0, MAX_DIFF_FILES), truncated: files.length > MAX_DIFF_FILES }
  },

  /** One file's unified diff between two trees (both paths of a rename). */
  async patch(dir: string, from: string, to: string, path: string, oldPath?: string): Promise<{ patch: string; binary: boolean; truncated: boolean } | null> {
    const top = await topLevel(dir)
    if (!top) return null
    const paths = oldPath && oldPath !== path ? [`:(top)${oldPath}`, `:(top)${path}`] : [`:(top)${path}`]
    const r = await gitBytes(['-C', top, 'diff', '--no-color', '--no-ext-diff', '-M', from, to, '--', ...paths])
    if (r.code !== 0) return null
    const truncated = r.out.length > MAX_PATCH_BYTES
    const text = new TextDecoder().decode(truncated ? r.out.slice(0, MAX_PATCH_BYTES) : r.out)
    const patch = truncated ? text.slice(0, text.lastIndexOf('\n') + 1) : text
    return { patch, binary: /^Binary files .* differ$/m.test(patch) && !/^@@/m.test(patch), truncated }
  },

  /** A file's bytes as `tree` holds it (the path relative to the repo's top). */
  async show(dir: string, tree: string, path: string): Promise<Uint8Array | null> {
    const top = await topLevel(dir)
    if (!top) return null
    const r = await gitBytes(['-C', top, 'cat-file', 'blob', `${tree}:${path}`])
    return r.code === 0 ? r.out : null
  },

  /** The top folder of the repo `dir` is in, or null outside git. */
  top: topLevel,

  /** The tree a commit points at, e.g. the commit a task started from. */
  async treeOf(dir: string, commit: string): Promise<string | null> {
    const r = await gitText(['-C', dir, 'rev-parse', '--verify', '--quiet', `${commit}^{tree}`])
    return r.code === 0 ? r.out.trim() : null
  },

  /** Commits everything changed in a task's worktree, so its branch holds the work. */
  async commitAll(dir: string, message: string): Promise<boolean> {
    await run(['git', '-C', dir, 'add', '-A'])
    const unchanged = await run(['git', '-C', dir, 'diff', '--cached', '--quiet'])
    if (unchanged.code === 0) return false
    // A fresh server or container often has no git identity; then the commit is signed as Afterhours.
    const named = (await run(['git', '-C', dir, 'config', 'user.email'])).out.trim() !== ''
    const identity = named ? [] : ['-c', `user.name=${BRAND.name}`, '-c', `user.email=${BRAND.slug}@localhost`]
    return (await run(['git', '-C', dir, ...identity, 'commit', '--no-verify', '-m', message])).code === 0
  },
}
