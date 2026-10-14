import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { writeFileAtomic } from '../shared/config'

// The map of your project folders behind the Telegram folder browser and search. Browsing
// lists folders live, so it's always current; search uses a cached index of the whole tree.

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

export interface FolderEntry {
  path: string
  name: string
  isRepo: boolean
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
      return {
        path,
        name: e.name,
        isRepo: inner.some(x => x.name === '.git'),
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
}

export interface FolderIndex {
  builtAt: number
  roots: string[]
  folders: IndexedFolder[]
}

const MAX_FOLDERS = 60_000

/** Walks every root down to `maxDepth` levels, yielding to the event loop as it goes. */
export async function scanFolders(roots: string[], maxDepth: number, now: number): Promise<FolderIndex> {
  const folders: IndexedFolder[] = []
  const queue: { path: string; depth: number }[] = roots.filter(r => existsSync(r)).map(path => ({ path, depth: 0 }))
  for (let next = 0; next < queue.length && folders.length < MAX_FOLDERS; next++) {
    const { path, depth } = queue[next]!
    let list: Dirent[]
    try {
      list = await readdir(path, { withFileTypes: true })
    } catch {
      continue
    }
    folders.push({ path, name: basename(path), isRepo: list.some(e => e.name === '.git'), depth })
    if (depth < maxDepth) {
      for (const e of subfolders(list)) queue.push({ path: join(path, e.name), depth: depth + 1 })
    }
  }
  return { builtAt: now, roots, folders }
}

export interface SearchHit {
  path: string
  name: string
  isRepo: boolean
}

/**
 * Ranks folders for a typed query: exact name, then name prefix, then name substring. With
 * several words ("nacho web"), a folder also matches when one word is in its name and the
 * rest are anywhere in its path. Folders you used recently and git repos come first.
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
    score -= f.depth
    scored.push({ hit: f, score })
  }
  scored.sort((a, b) => b.score - a.score || a.hit.path.length - b.hit.path.length)
  return scored.slice(0, limit).map(({ hit }) => ({ path: hit.path, name: hit.name, isRepo: hit.isRepo }))
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

export interface FolderMapOptions {
  roots: () => string[]
  maxDepth: () => number
  cachePath: string
  now: () => number
  log: (line: string) => void
}

const DAY = 24 * 3600_000

/** The search index: loaded from its cache file, rebuilt daily or when you tap 🔄 Rescan. */
export class FolderMap {
  private index: FolderIndex | null = null
  private building: Promise<FolderIndex> | null = null

  constructor(private o: FolderMapOptions) {
    try {
      const cached = JSON.parse(readFileSync(o.cachePath, 'utf8')) as FolderIndex
      if (Array.isArray(cached.folders)) this.index = cached
    } catch {
      // no cache yet
    }
  }

  get builtAt(): number | null {
    return this.index?.builtAt ?? null
  }

  get size(): number {
    return this.index?.folders.length ?? 0
  }

  /** Rebuilds when missing, older than a day, or the roots changed. */
  refreshIfStale(): void {
    const roots = this.o.roots()
    const stale =
      !this.index || this.o.now() - this.index.builtAt > DAY || this.index.roots.join('\n') !== roots.join('\n')
    if (stale && !this.building) void this.rebuild()
  }

  rebuild(): Promise<FolderIndex> {
    if (this.building) return this.building
    const started = this.o.now()
    this.building = scanFolders(this.o.roots(), this.o.maxDepth(), started)
      .then(index => {
        this.index = index
        writeFileAtomic(this.o.cachePath, JSON.stringify(index))
        this.o.log(`folders: indexed ${index.folders.length} folders in ${this.o.now() - started}ms`)
        return index
      })
      .finally(() => {
        this.building = null
      })
    return this.building
  }

  async search(query: string, recent: string[], limit = 10): Promise<SearchHit[]> {
    const index = this.index ?? (await this.rebuild())
    return searchFolders(index, query, recent, limit)
  }
}
