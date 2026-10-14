import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { listChildren, parentWithin, relativeToRoots, scanFolders, searchFolders, skipFolder } from '../src/daemon/folders'
import { makeTree } from './fakes'

const root = makeTree()

test('skipFolder', () => {
  for (const name of ['.git', '.venv', 'node_modules', 'dist', 'build', 'Pods', 'Assets.xcassets', 'App.xcodeproj']) expect(skipFolder(name)).toBe(true)
  for (const name of ['src', 'web', 'nacho', 'research']) expect(skipFolder(name)).toBe(false)
})

describe('listChildren', () => {
  test('lists real subfolders with repo and has-children markers', () => {
    expect(listChildren(root)).toEqual([
      { path: join(root, 'alpha'), name: 'alpha', isRepo: true, hasChildren: true },
      { path: join(root, 'beta'), name: 'beta', isRepo: false, hasChildren: true },
      { path: join(root, 'gamma-web'), name: 'gamma-web', isRepo: false, hasChildren: true },
    ])
  })

  test('skips dependencies and build output', () => {
    expect(listChildren(join(root, 'alpha')).map(c => c.name)).toEqual(['src'])
    expect(listChildren(join(root, 'beta'))).toEqual([{ path: join(root, 'beta', 'docs'), name: 'docs', isRepo: false, hasChildren: false }])
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
