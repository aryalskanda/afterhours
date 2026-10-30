// Picking a folder by browsing: start somewhere familiar (the home folder), open folders page by
// page, go up as far as the top of the disk. On Windows the top is "This PC", a level that lists
// the drives; inside WSL the Windows drives are /mnt/c, /mnt/d…, shown as C:\ and D:\. One browser
// for the terminal, the Telegram bot and the apps, so they all behave the same.

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { isWindows, isWsl } from '../platform/os'
import { kindOf, skipFolder } from './folders'
import { folderLabel } from './folder-suggest'

/** The level above every drive on Windows ("This PC"), as a path. */
export const THIS_PC = ''

export interface BrowseEnv {
  home?: string
  /** Inside WSL (Windows drives are under /mnt). */
  wsl?: boolean
  /** Native Windows (drives are C:\, D:\…). */
  windows?: boolean
  /** The drive letters that exist (native Windows); tests give their own. */
  drives?: () => string[]
}

function env(o: BrowseEnv = {}): Required<Omit<BrowseEnv, 'drives'>> & { drives: () => string[] } {
  return {
    home: o.home ?? homedir(),
    wsl: o.wsl ?? isWsl(),
    windows: o.windows ?? isWindows,
    drives: o.drives ?? (() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => existsSync(`${l}:\\`))),
  }
}

export interface BrowseItem {
  path: string
  name: string
  /** How a person reads it: "Documents", "C:\", "D:\". */
  title: string
  isRepo: boolean
  kind: string | null
  hasChildren: boolean
}

export interface BrowseView {
  /** The folder being looked at ('' is "This PC"). */
  path: string
  label: string
  /** The folder above, or null at the very top. */
  parent: string | null
  page: number
  pages: number
  total: number
  items: BrowseItem[]
}

/** The folder above, or null at the top ("/" on a Mac or Linux, "This PC" on Windows). */
export function parentOf(dir: string, o?: BrowseEnv): string | null {
  const e = env(o)
  if (e.windows) {
    if (dir === THIS_PC) return null
    if (/^[A-Za-z]:[\\/]*$/.test(dir)) return THIS_PC
  }
  const up = (e.windows ? win32.dirname : dirname)(dir)
  return up === dir ? null : up
}

/** The label for a folder: ~/code, D:\IT Works, This PC. */
export function browseLabel(path: string, o?: BrowseEnv): string {
  const e = env(o)
  if (path === THIS_PC) return 'This PC'
  return folderLabel(path, { home: e.home, wsl: e.wsl })
}

/** Folders that can't be a project folder: the top of a disk (too big to be where projects live). */
export function canChoose(path: string, o?: BrowseEnv): boolean {
  if (path === THIS_PC) return false
  try {
    if (!statSync(path).isDirectory()) return false
  } catch {
    return false
  }
  return parentOf(path, o) !== null && !(env(o).windows && /^[A-Za-z]:[\\/]*$/.test(path))
}

interface Named {
  path: string
  name: string
}

/** The subfolder names of `dir`, sorted: one directory read, nothing opened inside them. */
function names(dir: string, o?: BrowseEnv): Named[] {
  const e = env(o)
  if (dir === THIS_PC) return e.drives().map(l => ({ path: `${l}:\\`, name: `${l}:` }))
  let list: Dirent[] = []
  try {
    list = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return list
    .filter(d => d.isDirectory() && !skipFolder(d.name))
    .map(d => ({ path: join(dir, d.name), name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

/** What a folder is, from a look inside it (done for the folders on the page only). */
function describe(f: Named, o?: BrowseEnv): BrowseItem {
  const e = env(o)
  const title = f.name.endsWith(':') ? `${f.name}\\` : e.wsl && /^\/mnt\/[a-z]$/.test(f.path) ? browseLabel(f.path, o) : f.name
  if (f.name.endsWith(':') && e.windows) return { path: f.path, name: f.name, title, isRepo: false, kind: null, hasChildren: true }
  let inner: Dirent[] = []
  try {
    inner = readdirSync(f.path, { withFileTypes: true })
  } catch {
    // Not readable: shown, empty.
  }
  const inside = inner.map(d => d.name)
  return { path: f.path, name: f.name, title, isRepo: inside.includes('.git'), kind: kindOf(inside), hasChildren: inner.some(d => d.isDirectory() && !skipFolder(d.name)) }
}

/** One page of what's inside `dir`. */
export function browse(dir: string, page = 0, size = 8, o?: BrowseEnv): BrowseView {
  const all = names(dir, o)
  const pages = Math.max(1, Math.ceil(all.length / size))
  const at = Math.min(Math.max(0, page), pages - 1)
  return { path: dir, label: browseLabel(dir, o), parent: parentOf(dir, o), page: at, pages, total: all.length, items: all.slice(at * size, (at + 1) * size).map(f => describe(f, o)) }
}

/** Where browsing starts: the home folder. */
export function startFolder(o?: BrowseEnv): string {
  return env(o).home
}

/** Where to open the browser for a folder already chosen: its parent (so its siblings show). */
export function startNear(chosen: string | undefined, o?: BrowseEnv): string {
  if (chosen && existsSync(chosen)) return parentOf(chosen, o) ?? startFolder(o)
  return startFolder(o)
}

