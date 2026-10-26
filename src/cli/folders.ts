// `cq folders`: the project folders (what the apps and the bot search and browse). Owners change
// them from an app too; this is the same list, from the Mac.

import { Database } from 'bun:sqlite'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { suggestRoots } from '../daemon/folders'
import { codeRoots, COMMON_CODE_FOLDERS, expandHome, loadConfig, paths, saveConfig } from '../shared/config'

const USAGE = 'Usage: cq folders [list] | cq folders add <path> | cq folders remove <path>'

const tilde = (p: string) => (p === homedir() ? '~' : p.startsWith(homedir() + sep) ? '~' + p.slice(homedir().length) : p)

/** How many folders the engine's map holds under each root, if it has been built. */
function counts(roots: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!existsSync(paths.db)) return out
  try {
    const db = new Database(paths.db, { readonly: true })
    for (const r of roots) {
      const row = db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM folders WHERE path = ? OR path LIKE ?').get(r, r + sep + '%')
      out.set(r, row?.n ?? 0)
    }
    db.close()
  } catch {
    // No map yet: the engine builds it when it starts.
  }
  return out
}

export function foldersCommand(args: string[]): boolean {
  const config = loadConfig()
  const [sub, ...rest] = args
  const have = codeRoots(config)
  if (sub === undefined || sub === 'list') {
    const n = counts(have)
    console.log('Project folders (searched and browsed from your phone):')
    for (const r of have) console.log(`  ${tilde(r)}${n.has(r) ? ` · ${n.get(r)} folders` : ''}`)
    if (config.folders.roots.length === 0) console.log('  (the usual places; add one to choose them yourself)')
    const more = suggestRoots(have, homedir(), COMMON_CODE_FOLDERS.map(expandHome))
    if (more.length > 0) {
      console.log('Could be added:')
      for (const s of more) console.log(`  ${tilde(s.path)} · ${s.repos} repos   cq folders add ${tilde(s.path)}`)
    }
    return true
  }
  if ((sub !== 'add' && sub !== 'remove') || rest.length !== 1) {
    console.error(USAGE)
    return false
  }
  const path = resolve(expandHome(rest[0]!))
  const home = realpathSync(homedir())
  if (sub === 'add') {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      console.error(`${tilde(path)} isn't a folder.`)
      return false
    }
    const real = realpathSync(path)
    if (real === home || !real.startsWith(home + sep)) {
      console.error('A project folder has to be inside your home folder, and not the home folder itself.')
      return false
    }
    const covering = have.find(h => real === realpathSync(h) || real.startsWith(realpathSync(h) + sep))
    if (covering) {
      console.log(`${tilde(path)} is already covered by ${tilde(covering)}.`)
      return true
    }
    config.folders.roots = [...have.filter(h => !realpathSync(h).startsWith(real + sep)), path].map(tilde)
    saveConfig(config)
    console.log(`Added ${tilde(path)}. The engine picks it up within a few seconds.`)
    return true
  }
  const keep = have.filter(h => h !== path && realpathSync(h) !== (existsSync(path) ? realpathSync(path) : path))
  if (keep.length === have.length) {
    console.error(`${tilde(path)} isn't one of the project folders.`)
    return false
  }
  if (keep.length === 0) {
    console.error('Keep at least one project folder.')
    return false
  }
  config.folders.roots = keep.map(tilde)
  saveConfig(config)
  console.log(`Removed ${tilde(path)}.`)
  return true
}
