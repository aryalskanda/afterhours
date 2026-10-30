// Finding where your projects are without typing a path, the Telegram token from the clipboard, and
// the folders a person can add from their phone. Real temp folders; nothing outside them is read.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findToken, maskToken } from '../src/cli/clipboard'
import { chooseFolders } from '../src/cli/setup'
import { folderLabel, fromChats, suggestProjectFolders, windowsHomes, windowsName } from '../src/daemon/folder-suggest'
import { projectStoreDir } from '../src/daemon/sessions'

// Not under the system temp folder: the conversation lister hides chats that ran there.
const made: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(import.meta.dir, '.onb-'))
  made.push(dir)
  return dir
}
afterAll(() => made.forEach(d => rmSync(d, { recursive: true, force: true })))
const repo = (dir: string) => mkdirSync(join(dir, '.git'), { recursive: true })

/** A Claude Code conversation that ran in `cwd`. */
function chat(claudeDir: string, cwd: string, id: string) {
  const dir = projectStoreDir(cwd, claudeDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  const at = new Date().toISOString()
  const lines = [
    { type: 'user', cwd, timestamp: at, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
  ]
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(path, Date.now() / 1000, Date.now() / 1000)
}

describe('finding your project folders', () => {
  test('folders where you have used Claude Code: several projects under one folder are that folder', () => {
    const home = tmp()
    const code = join(home, 'Work')
    for (const n of ['api', 'web', 'docs']) mkdirSync(join(code, n), { recursive: true })
    mkdirSync(join(home, 'solo'), { recursive: true })
    const found = fromChats([join(code, 'api'), join(code, 'web'), join(code, 'docs'), join(home, 'solo'), join(home, 'gone')], home)
    expect(found).toEqual([
      { path: code, projects: 3 },
      { path: join(home, 'solo'), projects: 1 },
    ])
  })

  test('suggestions come from chats first, then git projects, never the home folder, never twice', () => {
    const home = tmp()
    const claudeDir = tmp()
    // Used in Claude Code: two projects in ~/Work.
    for (const n of ['api', 'web']) {
      mkdirSync(join(home, 'Work', n), { recursive: true })
      chat(claudeDir, join(home, 'Work', n), `s-${n}`)
    }
    // Never used with Claude, but full of git projects.
    for (const n of ['a', 'b', 'c']) repo(join(home, 'Experiments', n))
    // One git project alone, in an unusual place: not enough to suggest.
    repo(join(home, 'Lonely'))
    const found = suggestProjectFolders({ home, claudeDir })
    expect(found.map(f => f.path)).toEqual([join(home, 'Work'), join(home, 'Experiments')])
    expect(found[0]!.why).toBe("2 projects you've used Claude Code in")
    expect(found[1]!.why).toBe('3 git projects')
    // What you already have isn't suggested again, nor what it covers.
    expect(suggestProjectFolders({ home, claudeDir, have: [join(home, 'Work')] }).map(f => f.path)).toEqual([join(home, 'Experiments')])
  })

  test('nothing to suggest when nothing is found', () => {
    expect(suggestProjectFolders({ home: tmp(), claudeDir: tmp() })).toEqual([])
  })

  test('Windows drives and user folders are looked at from WSL, and shown as Windows paths', () => {
    const mnt = tmp()
    for (const n of ['IT Works', 'x']) mkdirSync(join(mnt, 'd', n), { recursive: true })
    for (const n of ['p1', 'p2']) repo(join(mnt, 'd', 'IT Works', n))
    mkdirSync(join(mnt, 'c', 'Users', 'me', 'source'), { recursive: true })
    mkdirSync(join(mnt, 'c', 'Users', 'Public'), { recursive: true })
    expect(windowsHomes(mnt).sort()).toEqual([join(mnt, 'c'), join(mnt, 'c', 'Users', 'me'), join(mnt, 'd')].sort())
    const found = suggestProjectFolders({ home: tmp(), claudeDir: tmp(), wsl: true, mnt })
    expect(found.map(f => f.path)).toEqual([join(mnt, 'd', 'IT Works')])
    expect(windowsName('/mnt/d/IT Works')).toBe('D:\\IT Works')
    expect(windowsName('/mnt/c')).toBe('C:\\')
    expect(folderLabel('/mnt/d/IT Works', { home: '/home/me', wsl: true })).toBe('D:\\IT Works')
    expect(folderLabel('/home/me/code', { home: '/home/me', wsl: true })).toBe('~/code')
  })
})

describe('the Telegram token', () => {
  const token = '9210523850:AAGfQr-7YT_C5bSe_BGHz7TZsUQRmA3jVD4'

  test('found on the clipboard among other text, masked when shown', () => {
    expect(findToken(token)).toBe(token)
    expect(findToken(`Use this token to access the HTTP API:\n${token}\nKeep your token secure`)).toBe(token)
    expect(findToken('just some words 12345')).toBeNull()
    expect(findToken('')).toBeNull()
    expect(maskToken(token)).toBe('9210523850:AAGf…jVD4'.replace('jVD4', 'VD4'))
    expect(maskToken(token)).not.toContain('Qr-7YT')
  })
})

describe('the folders question in setup', () => {
  const found = [
    { path: '/home/me/Work', why: '3 projects' },
    { path: '/home/me/Play', why: '2 git projects' },
    { path: '/home/me/Old', why: '2 git projects' },
  ]
  const answering = (reply: string) => {
    const original = globalThis.prompt
    globalThis.prompt = () => reply
    return () => void (globalThis.prompt = original)
  }
  const quiet = () => {
    const log = console.log
    console.log = () => {}
    return () => void (console.log = log)
  }

  test('Enter takes everything that was found; numbers take some', () => {
    const done = [answering(''), quiet()]
    // The default answer is every number, so Enter (an empty reply) is all of them.
    expect(chooseFolders([], { found, wsl: false })).toEqual(found.map(f => f.path))
    done.forEach(d => d())
    const again = [answering('1, 3'), quiet()]
    expect(chooseFolders([], { found, wsl: false })).toEqual(['/home/me/Work', '/home/me/Old'])
    again.forEach(d => d())
  })

  test('nothing found: no question, the folders already chosen stay (or none, so the home folder is used)', () => {
    const asked: string[] = []
    const original = globalThis.prompt
    globalThis.prompt = (q?: string) => (asked.push(String(q)), '')
    const q = quiet()
    expect(chooseFolders([], { found: [], wsl: false })).toEqual([])
    expect(chooseFolders(['/home/me/code'], { found: [], wsl: false })).toEqual(['/home/me/code'])
    q()
    globalThis.prompt = original
    expect(asked).toEqual([])
  })
})
