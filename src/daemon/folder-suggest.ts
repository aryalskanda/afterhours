// Where your projects probably are, worked out so nobody has to type a path: folders you've already
// used Claude Code in, folders full of git projects, and the usual places. On Windows (WSL) the
// Windows drives and user folders count too, shown as Windows paths.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { COMMON_CODE_FOLDERS, expandHome } from '../shared/config'
import { isWsl } from '../platform/os'
import { suggestRoots } from './folders'
import { listRecentConversations } from './sessions'

export interface FolderSuggestion {
  path: string
  /** Why it's suggested, in words: "6 projects you've used Claude Code in". */
  why: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** `/mnt/d/IT Works` → `D:\IT Works` (as a person on Windows knows it). */
export function windowsName(path: string): string {
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(path)
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : path
}

/**
 * Folders that hold the projects of your Claude Code chats: one used project is suggested as itself;
 * two or more under one folder are suggested as that folder.
 */
export function fromChats(cwds: string[], home: string): { path: string; projects: number }[] {
  const used = [...new Set(cwds)].filter(p => isDir(p) && p !== home && p !== dirname(p))
  const byParent = new Map<string, string[]>()
  for (const p of used) {
    const parent = dirname(p)
    byParent.set(parent, [...(byParent.get(parent) ?? []), p])
  }
  const out: { path: string; projects: number }[] = []
  for (const [parent, projects] of byParent) {
    if (projects.length >= 2 && parent !== home && parent !== dirname(parent)) out.push({ path: parent, projects: projects.length })
    else for (const p of projects) out.push({ path: p, projects: 1 })
  }
  return out
}

/** Windows places seen from WSL: the top level of each drive, and your Windows user folders. */
export function windowsHomes(mnt = '/mnt'): string[] {
  const homes: string[] = []
  let drives: string[] = []
  try {
    drives = readdirSync(mnt).filter(d => /^[a-z]$/.test(d))
  } catch {
    return []
  }
  for (const d of drives) {
    homes.push(join(mnt, d))
    const users = join(mnt, d, 'Users')
    try {
      for (const u of readdirSync(users)) if (!/^(Public|Default|All Users|desktop\.ini)/i.test(u) && isDir(join(users, u))) homes.push(join(users, u))
    } catch {
      // No Users folder on this drive.
    }
  }
  return homes
}

export interface SuggestOptions {
  /** Folders already chosen: not suggested again. */
  have?: string[]
  home?: string
  claudeDir?: string
  /** Also look at Windows drives and user folders (inside WSL). */
  wsl?: boolean
  mnt?: string
  max?: number
}

export function suggestProjectFolders(o: SuggestOptions = {}): FolderSuggestion[] {
  const home = o.home ?? homedir()
  const have = o.have ?? []
  const out: FolderSuggestion[] = []
  const add = (path: string, why: string) => {
    if (!isDir(path) || path === home) return
    if (have.some(h => inside(path, h))) return
    // A place inside one already suggested is covered by it.
    if (out.some(x => inside(path, x.path))) return
    for (let i = out.length - 1; i >= 0; i--) if (inside(out[i]!.path, path)) out.splice(i, 1)
    out.push({ path, why })
  }

  // 1. Where you've already used Claude Code.
  let cwds: string[] = []
  try {
    cwds = listRecentConversations(0, 300, o.claudeDir).chats.flatMap(c => (c.cwd ? [c.cwd] : []))
  } catch {
    // No Claude Code history yet.
  }
  for (const f of fromChats(cwds, home).sort((a, b) => b.projects - a.projects)) {
    add(f.path, f.projects > 1 ? `${plural(f.projects, 'project')} you've used Claude Code in` : "you've used Claude Code here")
  }
  // 2. Folders full of git projects, and the usual places.
  // The usual places, under the home folder this is about (not always the real one: tests, WSL).
  const usual = COMMON_CODE_FOLDERS.map(p => (p.startsWith('~/') ? join(home, p.slice(2)) : expandHome(p)))
  for (const s of suggestRoots(have, home, usual)) add(s.path, `${plural(s.repos, 'git project')}`)
  // 3. Windows drives and user folders, when this is WSL.
  if (o.wsl) {
    for (const h of windowsHomes(o.mnt)) {
      if (h === home) continue
      for (const s of suggestRoots(have, h, [])) add(s.path, `${plural(s.repos, 'git project')}`)
    }
  }
  // Most projects first; keep it short.
  return out.slice(0, o.max ?? 6)
}

/** A folder as a person reads it: "~/code", or a Windows path in WSL. */
export function folderLabel(path: string, o: { home?: string; wsl?: boolean } = {}): string {
  const home = o.home ?? homedir()
  if (path === home) return '~'
  // Either slash counts, and the rest is written with "/", as tilde() does everywhere else.
  if (path.startsWith(home + '/') || path.startsWith(home + '\\')) return '~' + path.slice(home.length).replace(/\\/g, '/')
  return o.wsl ? windowsName(path) : path
}

export { basename as folderName, existsSync as folderExists }

/**
 * What a person types for a folder, as a path here: quotes and a trailing slash dropped, "\\ " read
 * as a space, and (inside WSL) a Windows path such as D:\\IT Works turned into /mnt/d/IT Works.
 */
export function folderPath(typed: string, wsl = isWsl()): string {
  let t = typed.trim()
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim()
  t = t.replace(/\\ /g, ' ')
  const drive = /^([A-Za-z]):(?:[\\/]+(.*))?$/.exec(t)
  if (drive && wsl) t = `/mnt/${drive[1]!.toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`
  // Natively on Windows, D:\Projects stays as it is ("D:" alone is the drive's top, not its current folder).
  else if (drive && process.platform === 'win32') t = `${drive[1]!.toUpperCase()}:\\${drive[2] ?? ''}`
  t = t.replace(/\/+$/, '')
  // A WSL path is a Linux path, whatever this runs on.
  return (wsl ? posix.resolve : resolve)(expandHome(t || '/'))
}
