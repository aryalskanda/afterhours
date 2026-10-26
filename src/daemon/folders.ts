import { existsSync, readdirSync, watch, type FSWatcher, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Store } from './store'

// The map of your project folders behind the folder browser and search, in the apps and in
// Telegram. Browsing lists folders live, so it's always current. Search uses a snapshot of the whole
// tree that stays true to the disk: it's kept in the database, updated within seconds of a folder
// being made, renamed or removed (a watch on the project folders), and checked again every 15
// minutes by looking only at folders whose modified time changed.

const SKIP = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  'env',
  'dist',
  'build',
  'out',
  'target',
  'Pods',
  'DerivedData',
  'coverage',
  'vendor',
  'bower_components',
  '__MACOSX',
])
const SKIP_SUFFIXES = ['.xcassets', '.lproj', '.xcodeproj', '.xcworkspace', '.app', '.framework', '.xcframework', '.bundle']

/** Hidden folders, dependencies, build output and app bundles: never somewhere you'd run Claude. */
export function skipFolder(name: string): boolean {
  return name.startsWith('.') || SKIP.has(name) || SKIP_SUFFIXES.some(s => name.endsWith(s))
}

/** What a folder is, from the names inside it: the first that matches. */
const KINDS: [kind: string, names: string[]][] = [
  ['node', ['package.json']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['rust', ['Cargo.toml']],
  ['go', ['go.mod']],
  ['swift', ['Package.swift']],
  ['claude', ['CLAUDE.md', '.claude']],
]

/** "node", "python"… for a project that isn't just a git repo, else null. */
export function kindOf(names: string[]): string | null {
  const have = new Set(names)
  for (const [kind, files] of KINDS) if (files.some(f => have.has(f))) return kind
  return names.some(n => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace')) ? 'swift' : null
}

export interface FolderEntry {
  path: string
  name: string
  isRepo: boolean
  kind: string | null
  hasChildren: boolean
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function subfolders(list: Dirent[]): Dirent[] {
  return list.filter(e => e.isDirectory() && !skipFolder(e.name))
}

/** Subfolders of `dir`, straight from disk, alphabetically. */
export function listChildren(dir: string): FolderEntry[] {
  return subfolders(entries(dir))
    .map(e => {
      const path = join(dir, e.name)
      const inner = entries(path)
      const names = inner.map(x => x.name)
      return {
        path,
        name: e.name,
        isRepo: names.includes('.git'),
        kind: kindOf(names),
        hasChildren: subfolders(inner).length > 0,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

export function isRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

export interface IndexedFolder {
  path: string
  name: string
  isRepo: boolean
  depth: number
  /** What it is besides a git repo: node, python, rust, go, swift or claude. */
  kind?: string | null
  /** Modified time (ms): changes when something is added, removed or renamed directly inside. */
  mtime?: number
}

export interface FolderIndex {
  builtAt: number
  roots: string[]
  folders: IndexedFolder[]
}

/** Past this, a tree is too big to be a set of project folders (and it stops the scan). */
export const MAX_FOLDERS = 200_000
/** Folders this deep are left out: nothing sits that far down in a project folder. */
export const MAX_DEPTH = 12
/** Inside a project (a git repo, a package…) the map goes this many levels down: its own packages, not every folder of source. */
export const PROJECT_LEVELS = 2

const isProject = (f: Pick<IndexedFolder, 'isRepo' | 'kind'>) => f.isRepo || Boolean(f.kind)

export interface ScanResult {
  folders: IndexedFolder[]
  /** Folders whose listing was read (the others were unchanged by their modified time). */
  read: number
}

/**
 * Walks the roots (or `starts`, one subtree each) breadth first. A folder whose modified time is
 * what `before` has isn't read again: its subfolders come from `before`. The map goes as deep as
 * the tree does, but only `PROJECT_LEVELS` below a project.
 */
export async function walkFolders(
  starts: { path: string; depth: number; levels: number | null }[],
  before: Map<string, IndexedFolder>,
  o: { force?: boolean; children?: Map<string, string[]> } = {},
): Promise<ScanResult> {
  const folders: IndexedFolder[] = []
  const queue = [...starts]
  let read = 0
  for (let next = 0; next < queue.length && folders.length < MAX_FOLDERS; next++) {
    const { path, depth, levels } = queue[next]!
    let mtime: number
    try {
      mtime = Math.floor((await stat(path)).mtimeMs)
    } catch {
      continue
    }
    const old = before.get(path)
    let repo: boolean
    let kind: string | null
    let children: string[]
    if (!o.force && old && old.mtime === mtime) {
      repo = old.isRepo
      kind = old.kind ?? null
      children = o.children?.get(path) ?? []
    } else {
      let list: Dirent[]
      try {
        list = await readdir(path, { withFileTypes: true })
      } catch {
        continue
      }
      read++
      const names = list.map(e => e.name)
      repo = names.includes('.git')
      kind = kindOf(names)
      children = subfolders(list).map(e => join(path, e.name))
    }
    folders.push({ path, name: basename(path), isRepo: repo, kind, depth, mtime })
    const here = repo || kind ? 0 : levels
    if (depth < MAX_DEPTH && (here === null || here < PROJECT_LEVELS)) {
      for (const child of children) queue.push({ path: child, depth: depth + 1, levels: here === null ? null : here + 1 })
    }
    if (next % 200 === 199) await new Promise(r => setTimeout(r, 0))
  }
  return { folders, read }
}

/** A fresh walk of every root down to `maxDepth` levels (a fixed depth, for callers that want one). */
export async function scanFolders(roots: string[], maxDepth: number, now: number): Promise<FolderIndex> {
  const { folders } = await walkFolders(
    roots.filter(r => existsSync(r)).map(path => ({ path, depth: 0, levels: null })),
    new Map(),
    { force: true },
  )
  return { builtAt: now, roots, folders: folders.filter(f => f.depth <= maxDepth) }
}

export interface SearchHit {
  path: string
  name: string
  isRepo: boolean
  kind?: string | null
}

/**
 * Ranks folders for a typed query: exact name, then name prefix, then name substring. With
 * several words ("nacho web"), a folder also matches when one word is in its name and the
 * rest are anywhere in its path. Folders you used recently, git repos and other projects come first.
 */
export function searchFolders(index: FolderIndex, query: string, recent: string[], limit = 10): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const scored: { hit: IndexedFolder; score: number }[] = []
  for (const f of index.folders) {
    if (f.depth === 0) continue // the root itself
    const name = f.name.toLowerCase()
    const rel = relativeToRoots(f.path, index.roots).toLowerCase()
    let score: number
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (name.includes(q)) score = 60
    // One word alone would match every folder below a match; only words together do that.
    else if (words.length > 1 && words.some(w => name.includes(w)) && words.every(w => rel.includes(w))) score = 40
    else continue
    const r = recent.indexOf(f.path)
    if (r >= 0) score += 15 - Math.min(r, 10)
    if (f.isRepo) score += 5
    else if (f.kind) score += 3
    score -= f.depth
    scored.push({ hit: f, score })
  }
  scored.sort((a, b) => b.score - a.score || a.hit.path.length - b.hit.path.length)
  return scored.slice(0, limit).map(({ hit }) => ({ path: hit.path, name: hit.name, isRepo: hit.isRepo, kind: hit.kind ?? null }))
}

export function relativeToRoots(path: string, roots: string[]): string {
  for (const root of roots) {
    if (path === root) return basename(root)
    if (path.startsWith(root + '/')) return relative(root, path)
  }
  return path.startsWith(homedir() + '/') ? '~/' + relative(homedir(), path) : path
}

/** The parent to go "up" to, or null at a root. */
export function parentWithin(path: string, roots: string[]): string | null {
  if (roots.includes(path)) return null
  const parent = dirname(path)
  return roots.some(r => parent === r || parent.startsWith(r + '/')) ? parent : null
}

/** Whether `path` is one of `roots` or inside one. */
export function within(path: string, roots: string[]): boolean {
  return roots.some(r => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep))
}

/** Places in a home folder that are never where projects live. */
const NOT_PROJECTS = new Set(['Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public', 'Downloads', 'Desktop', 'Sites'])

/** Git repos directly in `dir`, or one level further in: a place that holds projects has several. */
function reposIn(dir: string, stop = 20): number {
  let n = 0
  for (const child of subfolders(entries(dir))) {
    const inner = entries(join(dir, child.name))
    if (inner.some(e => e.name === '.git')) n++
    else for (const grand of subfolders(inner)) if (existsSync(join(dir, child.name, grand.name, '.git'))) n++
    if (n >= stop) break
  }
  return n
}

export interface RootSuggestion {
  path: string
  name: string
  repos: number
}

/**
 * Folders that look like where you keep projects: the usual places, and any folder in your home or
 * Documents with several git repos in it. Ones already covered by `have` aren't suggested.
 */
export function suggestRoots(have: string[], home = homedir(), usual: string[] = []): RootSuggestion[] {
  const candidates = new Set<string>(usual.filter(p => existsSync(p)))
  for (const base of [home, join(home, 'Documents')]) {
    for (const e of subfolders(entries(base))) if (!NOT_PROJECTS.has(e.name)) candidates.add(join(base, e.name))
  }
  const out: RootSuggestion[] = []
  for (const path of candidates) {
    if (path === home || have.some(h => path === h || path.startsWith(h + sep) || h.startsWith(path + sep))) continue
    const repos = reposIn(path)
    if (repos >= 2 || (usual.includes(path) && repos >= 1)) out.push({ path, name: basename(path), repos })
  }
  // A place inside another suggestion is covered by it.
  const top = out.filter(a => !out.some(b => b !== a && a.path.startsWith(b.path + sep)))
  return top.sort((a, b) => b.repos - a.repos || a.path.localeCompare(b.path)).slice(0, 8)
}

export interface FolderMapOptions {
  roots: () => string[]
  store: Pick<Store, 'db' | 'kvGet' | 'kvSet'>
  now: () => number
  log: (line: string) => void
  /** Watch the roots for changes (default on); tests turn it off. */
  watch?: boolean
  /** How long after the last change a watched folder is read again (default 2 s). */
  settleMs?: number
}

/** How often the whole tree is looked at again, for what no watch told it. */
export const RESCAN_MS = 15 * 60_000

interface ScanNote {
  at: number
  roots: string[]
  ms: number
  read: number
}

/**
 * The folder snapshot: loaded from the database, then kept true by a watch on the roots and a
 * light rescan every 15 minutes (only folders whose modified time changed are read again).
 */
export class FolderMap {
  private rows = new Map<string, IndexedFolder>()
  private kids = new Map<string, string[]>()
  private scanning: Promise<void> | null = null
  private watchers: FSWatcher[] = []
  private watched = ''
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private o: FolderMapOptions) {
    o.store.db.exec(`CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY, name TEXT NOT NULL, depth INTEGER NOT NULL,
      is_repo INTEGER NOT NULL DEFAULT 0, kind TEXT, mtime INTEGER)`)
    const stored = o.store.db
      .query<{ path: string; name: string; depth: number; is_repo: number; kind: string | null; mtime: number | null }, []>('SELECT path, name, depth, is_repo, kind, mtime FROM folders')
      .all()
    for (const r of stored) this.rows.set(r.path, { path: r.path, name: r.name, depth: r.depth, isRepo: r.is_repo === 1, kind: r.kind, mtime: r.mtime ?? undefined })
    this.index()
  }

  private note(): ScanNote | null {
    return this.o.store.kvGet<ScanNote>('folders.scan') ?? null
  }

  get builtAt(): number | null {
    return this.note()?.at ?? null
  }

  get size(): number {
    return this.rows.size
  }

  /** How many folders the map holds under `root`. */
  countUnder(root: string): number {
    let n = 0
    for (const p of this.rows.keys()) if (p === root || p.startsWith(root + sep)) n++
    return n
  }

  private index(): void {
    this.kids.clear()
    for (const f of this.rows.values()) {
      const parent = dirname(f.path)
      const list = this.kids.get(parent)
      if (list) list.push(f.path)
      else this.kids.set(parent, [f.path])
    }
  }

  private snapshot(): FolderIndex {
    return { builtAt: this.builtAt ?? 0, roots: this.o.roots(), folders: [...this.rows.values()] }
  }

  /** The levels below a project that `dir` sits at (0 for a project itself), or null outside one. */
  private levelsOf(dir: string, roots: string[]): number | null {
    let n = 0
    for (let cur = dir; ; cur = dirname(cur), n++) {
      const row = this.rows.get(cur)
      if (row && isProject(row)) return n
      if (roots.includes(cur) || dirname(cur) === cur) return null
    }
  }

  /** Looks at the roots again; with `force`, every folder is read, not only the changed ones. */
  private scan(force: boolean): Promise<void> {
    if (this.scanning) return this.scanning
    const started = this.o.now()
    const roots = this.o.roots().filter(r => existsSync(r))
    this.scanning = (async () => {
      const result = await walkFolders(
        roots.map(path => ({ path, depth: 0, levels: null })),
        this.rows,
        { force, children: this.kids },
      )
      this.commit(new Map(result.folders.map(f => [f.path, f])))
      const ms = this.o.now() - started
      this.o.store.kvSet('folders.scan', { at: this.o.now(), roots: this.o.roots(), ms, read: result.read } satisfies ScanNote)
      this.o.log(`folders: ${this.rows.size} folders (${result.read} read) in ${ms}ms`)
    })().finally(() => {
      this.scanning = null
    })
    return this.scanning
  }

  /** Makes `next` the map, and the database the same: only what differs is written. */
  private commit(next: Map<string, IndexedFolder>): void {
    const db = this.o.store.db
    const put = db.prepare('INSERT OR REPLACE INTO folders (path, name, depth, is_repo, kind, mtime) VALUES (?, ?, ?, ?, ?, ?)')
    const del = db.prepare('DELETE FROM folders WHERE path = ?')
    db.transaction(() => {
      for (const [path, f] of next) {
        const old = this.rows.get(path)
        if (!old || old.mtime !== f.mtime || old.isRepo !== f.isRepo || (old.kind ?? null) !== (f.kind ?? null) || old.depth !== f.depth) put.run(path, f.name, f.depth, f.isRepo ? 1 : 0, f.kind ?? null, f.mtime ?? null)
      }
      for (const path of this.rows.keys()) if (!next.has(path)) del.run(path)
    })()
    this.rows = next
    this.index()
  }

  /** Rebuilds when never built, older than 15 minutes, or the roots changed; and watches the roots. */
  refreshIfStale(): void {
    const roots = this.o.roots()
    const note = this.note()
    const stale = !note || this.o.now() - note.at > RESCAN_MS || note.roots.join('\n') !== roots.join('\n')
    if (stale && !this.scanning) void this.scan(false)
    this.watchRoots(roots)
  }

  /** Every folder read again (Rescan). */
  async rebuild(): Promise<FolderIndex> {
    await this.scan(true)
    return this.snapshot()
  }

  /** Looks at what changed, now: every folder's modified time, reading only the changed ones. */
  async refresh(): Promise<void> {
    await this.scan(false)
  }

  /** A folder just listed from disk (browsed): its place in the map is looked at again soon. */
  touch(dir: string): void {
    this.queue(dir)
  }

  private watchRoots(roots: string[]): void {
    if (this.o.watch === false) return
    const key = roots.join('\n')
    if (key === this.watched) return
    this.stopWatching()
    this.watched = key
    for (const root of roots) {
      if (!existsSync(root)) continue
      try {
        const w = watch(root, { recursive: true }, (_event, name) => {
          if (!name) return
          const rel = String(name)
          // Changes inside dependencies, build output and hidden folders don't change the map.
          if (rel.split(sep).some(skipFolder)) return
          this.queue(dirname(join(root, rel)))
        })
        w.on('error', () => {})
        this.watchers.push(w)
      } catch (err) {
        this.o.log(`folders: can't watch ${root} (${err instanceof Error ? err.message : err}); it's checked every 15 minutes instead`)
      }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.watched = ''
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private queue(dir: string): void {
    this.pending.add(dir)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const dirs = [...this.pending]
      this.pending.clear()
      void this.refreshDirs(dirs)
    }, this.o.settleMs ?? 2000)
  }

  /** Reads the given folders' places in the map again (and what's new inside them). */
  async refreshDirs(dirs: string[]): Promise<void> {
    if (this.scanning) await this.scanning
    const roots = this.o.roots()
    const next = new Map(this.rows)
    const starts: { path: string; depth: number; levels: number | null }[] = []
    for (const dir of new Set(dirs)) {
      if (!within(dir, roots)) continue
      // A folder inside one already being redone is covered.
      if (starts.some(s => dir === s.path || dir.startsWith(s.path + sep))) continue
      const parentRow = this.rows.get(dir)
      const depth = parentRow?.depth ?? this.depthOf(dir, roots)
      if (depth === null) continue
      for (const p of [...next.keys()]) if (p === dir || p.startsWith(dir + sep)) next.delete(p)
      starts.push({ path: dir, depth, levels: this.levelsOf(dir, roots) })
    }
    if (starts.length === 0) return
    const result = await walkFolders(starts, this.rows, { children: this.kids })
    for (const f of result.folders) next.set(f.path, f)
    this.commit(next)
  }

  private depthOf(dir: string, roots: string[]): number | null {
    const root = roots.find(r => dir === r || dir.startsWith(r + sep))
    return root ? (dir === root ? 0 : relative(root, dir).split(sep).length) : null
  }

  /** Folders matching the typed words, the ones that are gone left out. */
  async search(query: string, recent: string[], limit = 10): Promise<SearchHit[]> {
    if (this.rows.size === 0) await this.scan(false)
    const hits = searchFolders(this.snapshot(), query, recent, limit + 10)
    const alive = hits.filter(h => existsSync(h.path))
    // What's listed but gone: the map is told, so it's right by the next search.
    for (const gone of hits.filter(h => !existsSync(h.path))) this.queue(dirname(gone.path))
    return alive.slice(0, limit)
  }
}
