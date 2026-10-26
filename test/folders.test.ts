import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { FolderMap, kindOf, listChildren, parentWithin, relativeToRoots, scanFolders, searchFolders, skipFolder, walkFolders, within } from '../src/daemon/folders'
import { Store } from '../src/daemon/store'
import { makeTree } from './fakes'

const root = makeTree()

test('skipFolder', () => {
  for (const name of ['.git', '.venv', 'node_modules', 'dist', 'build', 'Pods', 'Assets.xcassets', 'App.xcodeproj']) expect(skipFolder(name)).toBe(true)
  for (const name of ['src', 'web', 'nacho', 'research']) expect(skipFolder(name)).toBe(false)
})

describe('listChildren', () => {
  test('lists real subfolders with repo and has-children markers', () => {
    expect(listChildren(root)).toEqual([
      { path: join(root, 'alpha'), name: 'alpha', isRepo: true, kind: null, hasChildren: true },
      { path: join(root, 'beta'), name: 'beta', isRepo: false, kind: null, hasChildren: true },
      { path: join(root, 'gamma-web'), name: 'gamma-web', isRepo: false, kind: null, hasChildren: true },
    ])
  })

  test('skips dependencies and build output', () => {
    expect(listChildren(join(root, 'alpha')).map(c => c.name)).toEqual(['src'])
    expect(listChildren(join(root, 'beta'))).toEqual([{ path: join(root, 'beta', 'docs'), name: 'docs', isRepo: false, kind: null, hasChildren: false }])
  })
})

describe('scan and search', () => {
  test('the index skips junk and respects depth', async () => {
    const index = await scanFolders([root], 6, 1)
    const rel = index.folders.map(f => relativeToRoots(f.path, [root])).sort()
    expect(rel).toEqual(
      ['alpha', 'alpha/src', 'alpha/src/components', 'beta', 'beta/docs', 'gamma-web', 'gamma-web/web', 'gamma-web/web/app', root.split('/').pop()!].sort(),
    )
    const shallow = await scanFolders([root], 1, 1)
    expect(shallow.folders.map(f => f.depth)).toEqual([0, 1, 1, 1])
  })

  test('ranking: exact name, prefix, substring, then words in the path', async () => {
    const index = await scanFolders([root], 6, 1)
    const names = (q: string, recent: string[] = []) => searchFolders(index, q, recent).map(h => relativeToRoots(h.path, [root]))
    expect(names('web')).toEqual(['gamma-web/web', 'gamma-web'])
    expect(names('comp')).toEqual(['alpha/src/components'])
    expect(names('alpha comp')).toEqual(['alpha/src/components'])
    expect(names('gamma app')).toEqual(['gamma-web/web/app'])
    expect(names('nothing-like-this')).toEqual([])
  })

  test('a recently used folder wins among equally good matches', () => {
    const index = {
      builtAt: 0,
      roots: ['/r'],
      folders: [
        { path: '/r/one-app', name: 'one-app', isRepo: false, depth: 1 },
        { path: '/r/two-app', name: 'two-app', isRepo: false, depth: 1 },
      ],
    }
    expect(searchFolders(index, 'app', []).map(h => h.name)).toEqual(['one-app', 'two-app'])
    expect(searchFolders(index, 'app', ['/r/two-app']).map(h => h.name)).toEqual(['two-app', 'one-app'])
  })
})

test('parentWithin stops at the root', () => {
  expect(parentWithin(join(root, 'alpha', 'src'), [root])).toBe(join(root, 'alpha'))
  expect(parentWithin(join(root, 'alpha'), [root])).toBe(root)
  expect(parentWithin(root, [root])).toBeNull()
})

const names = (store: Store, map: FolderMap, q: string, recent: string[] = []) => map.search(q, recent).then(h => h.map(x => x.name))

/** A folder map over a temporary tree, with its own database; nothing watches it unless asked. */
function mapOver(tree: string, o: { watch?: boolean; settleMs?: number } = {}) {
  const store = new Store(':memory:')
  let now = 1_000
  const map = new FolderMap({ roots: () => [tree], store, now: () => now, log: () => {}, watch: o.watch ?? false, settleMs: o.settleMs })
  return { store, map, advance: (ms: number) => (now += ms) }
}

/** A tree: a monorepo (git) with packages, a plain folder of projects, deep in a path. */
function projects() {
  const tree = makeTree()
  for (const dir of ['mono/.git', 'mono/packages/web/src/components/ui', 'mono/packages/api/src', 'plain/inner/app/src/deep/deeper', 'plain/inner/lib']) mkdirSync(join(tree, dir), { recursive: true })
  writeFileSync(join(tree, 'mono/packages/web/package.json'), '{}')
  writeFileSync(join(tree, 'mono/packages/api/pyproject.toml'), '')
  writeFileSync(join(tree, 'plain/inner/app/CLAUDE.md'), '# app')
  return tree
}

describe('what a folder is', () => {
  test('from the names inside it', () => {
    expect(kindOf(['package.json', 'src'])).toBe('node')
    expect(kindOf(['pyproject.toml'])).toBe('python')
    expect(kindOf(['Cargo.toml'])).toBe('rust')
    expect(kindOf(['go.mod'])).toBe('go')
    expect(kindOf(['App.xcodeproj'])).toBe('swift')
    expect(kindOf(['CLAUDE.md'])).toBe('claude')
    expect(kindOf(['notes.txt'])).toBeNull()
  })

  test('browsing says what each folder is', () => {
    const tree = projects()
    const web = listChildren(join(tree, 'mono', 'packages')).map(c => [c.name, c.kind])
    expect(web).toEqual([['api', 'python'], ['web', 'node']])
  })
})

describe('how far down the map goes', () => {
  test('as deep as the tree, but only two levels inside a project', async () => {
    const tree = projects()
    const { folders } = await walkFolders([{ path: tree, depth: 0, levels: null }], new Map(), { force: true })
    const rel = new Set(folders.map(f => relativeToRoots(f.path, [tree])))
    // Outside a project: every level (plain/inner/app is a project, found at depth 3).
    expect(rel.has('plain/inner/app')).toBe(true)
    // Inside it: two levels, then stop.
    expect(rel.has('plain/inner/app/src')).toBe(true)
    expect(rel.has('plain/inner/app/src/deep')).toBe(true)
    expect(rel.has('plain/inner/app/src/deep/deeper')).toBe(false)
    // A monorepo's packages are projects of their own, so their folders are found too.
    expect(rel.has('mono/packages/web')).toBe(true)
    expect(rel.has('mono/packages/web/src/components')).toBe(true)
    expect(rel.has('mono/packages/web/src/components/ui')).toBe(false)
  })
})

describe('a map that stays true', () => {
  test('a folder made, renamed or removed shows after the next look; only what changed is read', async () => {
    const tree = projects()
    const { map, store } = mapOver(tree)
    await map.refresh()
    expect(await names(store, map, 'newthing')).toEqual([])
    mkdirSync(join(tree, 'plain', 'newthing'))
    await Bun.sleep(5)
    await map.refresh()
    expect(await names(store, map, 'newthing')).toEqual(['newthing'])
    renameSync(join(tree, 'plain', 'newthing'), join(tree, 'plain', 'renamed'))
    await map.refresh()
    expect(await names(store, map, 'newthing')).toEqual([])
    expect(await names(store, map, 'renamed')).toEqual(['renamed'])
    rmSync(join(tree, 'plain', 'renamed'), { recursive: true })
    await map.refresh()
    expect(await names(store, map, 'renamed')).toEqual([])
  })

  test('a look at an unchanged tree reads nothing', async () => {
    const tree = projects()
    const { map, store } = mapOver(tree)
    await map.refresh()
    const first = store.kvGet<{ read: number }>('folders.scan')!.read
    expect(first).toBeGreaterThan(5)
    await map.refresh()
    expect(store.kvGet<{ read: number }>('folders.scan')!.read).toBe(0)
    mkdirSync(join(tree, 'beta', 'extra'))
    await map.refresh()
    expect(store.kvGet<{ read: number }>('folders.scan')!.read).toBe(2) // beta, and the new folder
  })

  test('one folder looked at again (what a watch does) updates just its place', async () => {
    const tree = projects()
    const { map, store } = mapOver(tree)
    await map.refresh()
    mkdirSync(join(tree, 'mono', 'packages', 'web', 'fresh'))
    await map.refreshDirs([join(tree, 'mono', 'packages', 'web')])
    expect(await names(store, map, 'fresh')).toEqual(['fresh'])
    // The rest is as it was.
    expect(await names(store, map, 'api')).toEqual(['api'])
  })

  test('the snapshot is in the database: a restarted engine has it at once', async () => {
    const tree = projects()
    const store = new Store(':memory:')
    const first = new FolderMap({ roots: () => [tree], store, now: () => 1, log: () => {}, watch: false })
    await first.refresh()
    const second = new FolderMap({ roots: () => [tree], store, now: () => 2, log: () => {}, watch: false })
    expect(second.size).toBe(first.size)
    expect((await second.search('web', [])).map(h => h.name)).toContain('web')
  })

  test('what is gone is never offered, even before the map knows', async () => {
    const tree = projects()
    const { map } = mapOver(tree)
    await map.refresh()
    rmSync(join(tree, 'beta'), { recursive: true })
    expect((await map.search('docs', [])).map(h => h.name)).toEqual([])
  })

  test('stale after 15 minutes, or when the roots change', async () => {
    const tree = projects()
    const { map, store, advance } = mapOver(tree)
    await map.refresh()
    const at = map.builtAt
    advance(14 * 60_000)
    map.refreshIfStale()
    await Bun.sleep(20)
    expect(map.builtAt).toBe(at)
    advance(2 * 60_000)
    map.refreshIfStale()
    for (let i = 0; i < 50 && map.builtAt === at; i++) await Bun.sleep(40)
    expect(map.builtAt).toBeGreaterThan(at!)
    void store
  })

  test('the project folders and what is outside them', () => {
    expect(within('/a/b/c', ['/a/b'])).toBe(true)
    expect(within('/a/bc', ['/a/b'])).toBe(false)
    expect(within('/a/b', ['/a/b'])).toBe(true)
  })

  if (process.platform === 'darwin') {
    test('a watch sees a new folder within seconds', async () => {
      const tree = projects()
      const { map, store } = mapOver(tree, { watch: true, settleMs: 100 })
      await map.refresh()
      map.refreshIfStale() // starts the watch
      mkdirSync(join(tree, 'plain', 'watched-new'))
      let found: string[] = []
      for (let i = 0; i < 40 && found.length === 0; i++) {
        await Bun.sleep(100)
        found = await names(store, map, 'watched-new')
      }
      map.stopWatching()
      expect(found).toEqual(['watched-new'])
    })
  }
})
