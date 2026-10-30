// Browsing for a folder: where it starts, going up to the top, pages, and Windows drives.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browse, browseLabel, canChoose, parentOf, startFolder, startNear, THIS_PC } from '../src/daemon/browse'

const made: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-browse-'))
  made.push(dir)
  return dir
}
afterAll(() => made.forEach(d => rmSync(d, { recursive: true, force: true })))
const unix = { wsl: false, windows: false }

describe('browsing', () => {
  test('a folder lists its subfolders, sorted, without hidden ones or files', () => {
    const home = tmp()
    for (const n of ['zeta', 'Alpha', 'beta 10', 'beta 2', '.hidden', 'node_modules']) mkdirSync(join(home, n))
    writeFileSync(join(home, 'file.txt'), 'x')
    mkdirSync(join(home, 'Alpha', '.git'), { recursive: true })
    const v = browse(home, 0, 8, { ...unix, home })
    expect(v.items.map(i => i.name)).toEqual(['Alpha', 'beta 2', 'beta 10', 'zeta'])
    expect(v.items[0]).toMatchObject({ isRepo: true, title: 'Alpha' })
    expect(v.label).toBe('~')
    expect(v.total).toBe(4)
  })

  test('pages: eight at a time, the last page partial, an out-of-range page clamps', () => {
    const home = tmp()
    for (let i = 0; i < 19; i++) mkdirSync(join(home, `f${String(i).padStart(2, '0')}`))
    const o = { ...unix, home }
    const first = browse(home, 0, 8, o)
    expect([first.pages, first.items.length, first.items[0]!.name]).toEqual([3, 8, 'f00'])
    expect(browse(home, 2, 8, o).items.map(i => i.name)).toEqual(['f16', 'f17', 'f18'])
    expect(browse(home, 99, 8, o).page).toBe(2)
    expect(browse(home, -3, 8, o).page).toBe(0)
    expect(browse(tmp(), 0, 8, o)).toMatchObject({ pages: 1, total: 0, items: [] })
  })

  test('up goes as far as the top of the disk, then there is no more up', () => {
    expect(parentOf('/Users/me/code', unix)).toBe('/Users/me')
    expect(parentOf('/Users', unix)).toBe('/')
    expect(parentOf('/', unix)).toBeNull()
    expect(startFolder({ home: '/Users/me' })).toBe('/Users/me')
    // Opening near a folder already chosen shows its neighbours; unknown means home.
    const home = tmp()
    mkdirSync(join(home, 'proj'))
    expect(startNear(join(home, 'proj'), { ...unix, home })).toBe(home)
    expect(startNear('/not/there', { ...unix, home })).toBe(home)
    expect(startNear(undefined, { ...unix, home })).toBe(home)
  })

  test('the top of a disk can be browsed but not chosen; a file or missing folder cannot', () => {
    const home = tmp()
    writeFileSync(join(home, 'f'), 'x')
    mkdirSync(join(home, 'ok'))
    expect(canChoose(join(home, 'ok'), unix)).toBe(true)
    expect(canChoose('/', unix)).toBe(false)
    expect(canChoose(join(home, 'f'), unix)).toBe(false)
    expect(canChoose(join(home, 'gone'), unix)).toBe(false)
    expect(canChoose(THIS_PC, unix)).toBe(false)
  })
})

describe('Windows', () => {
  const win = { windows: true, wsl: false, home: 'C:\\Users\\me', drives: () => ['C', 'D'] }

  test('above C:\\ is This PC, which lists the drives; nothing is above that', () => {
    expect(parentOf('C:\\Users', win)).toBe('C:\\')
    expect(parentOf('C:\\', win)).toBe(THIS_PC)
    expect(parentOf('D:\\', win)).toBe(THIS_PC)
    expect(parentOf(THIS_PC, win)).toBeNull()
    const pc = browse(THIS_PC, 0, 8, win)
    expect(pc.label).toBe('This PC')
    expect(pc.items.map(i => i.title)).toEqual(['C:\\', 'D:\\'])
    expect(pc.parent).toBeNull()
    expect(browse('C:\\nowhere-here', 0, 8, win).parent).toBe('C:\\')
  })

  test('a whole drive is browsable, not choosable', () => {
    expect(canChoose('C:\\', win)).toBe(false)
    expect(canChoose(THIS_PC, win)).toBe(false)
  })

  test('inside WSL the Windows drives show as C:\\ and D:\\, and Windows folders by their Windows names', () => {
    const mnt = tmp()
    // The real /mnt can't be faked, so the labels are checked on paths.
    const wsl = { wsl: true, windows: false, home: '/home/me' }
    expect(browseLabel('/mnt/d', wsl)).toBe('D:\\')
    expect(browseLabel('/mnt/d/IT Works', wsl)).toBe('D:\\IT Works')
    expect(browseLabel('/home/me/code', wsl)).toBe('~/code')
    expect(parentOf('/mnt/d', wsl)).toBe('/mnt')
    void mnt
  })
})
