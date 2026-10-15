// What apps may read: inside one folder, never through `..` or a symlink, never secrets.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSecretName, isSecretPath, listFolder, MAX_TEXT_BYTES, readFileInside, resolveInside, searchFiles } from '../src/daemon/files'

let root: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'cq-files-'))
  root = join(base, 'shop')
  outside = join(base, 'elsewhere')
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# Shop\n')
  writeFileSync(join(root, 'src', 'orders.tsx'), 'export function Orders() {}\n')
  writeFileSync(join(root, 'src', 'lib', 'csv.ts'), 'export const csv = 1\n')
  writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_live_secret\n')
  writeFileSync(join(root, '.env.example'), 'STRIPE_KEY=\n')
  writeFileSync(join(root, 'config', 'server.pem'), '-----BEGIN PRIVATE KEY-----\n')
  writeFileSync(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  writeFileSync(join(root, 'data.bin'), new Uint8Array([1, 0, 2, 0, 3]))
  writeFileSync(join(outside, 'private.txt'), 'not yours to read\n')
  symlinkSync(outside, join(root, 'link-out'))
})
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

test('secret names', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'tls.key', '.ssh', '.aws', '.git', '.netrc', '.npmrc', 'credentials.json', '.git-credentials', 'secrets.yaml', 'vault.kdbx']) {
    expect(isSecretName(name)).toBe(true)
  }
  for (const name of ['.env.example', '.env.sample', 'id_rsa.pub', 'README.md', 'keyboard.ts', 'orders.tsx', '.github', '.claude', 'environment.ts']) {
    expect(isSecretName(name)).toBe(false)
  }
  expect(isSecretPath('config/.ssh/known_hosts')).toBe(true)
  expect(isSecretPath('src/lib/csv.ts')).toBe(false)
})

test('nothing outside the root: not through .., not through a symlink, not secrets', () => {
  expect(resolveInside(root, 'src/orders.tsx')?.rel).toBe('src/orders.tsx')
  expect(resolveInside(root, '../elsewhere/private.txt')).toBeNull()
  expect(resolveInside(root, 'link-out/private.txt')).toBeNull()
  expect(resolveInside(root, '.env')).toBeNull()
  expect(resolveInside(root, '.git/config')).toBeNull()
  expect(resolveInside(root, 'missing.txt')).toBeNull()
})

test('a folder lists folders first, without secrets or git', () => {
  const listed = listFolder(root, '')!
  expect(listed.path).toBe('')
  expect(listed.entries.map(e => `${e.kind}:${e.name}`)).toEqual([
    'dir:config',
    'dir:src',
    'file:.env.example',
    'file:data.bin',
    'file:logo.png',
    'file:README.md',
  ])
  expect(listFolder(root, 'config')!.entries).toEqual([])
  expect(listFolder(root, 'src')!.entries.map(e => e.path)).toEqual(['src/lib', 'src/orders.tsx'])
  expect(listFolder(root, 'link-out')).toBeNull()
})

test('reading: text, images as base64, binary as such, long text cut', () => {
  expect(readFileInside(root, 'README.md')).toEqual({ path: 'README.md', kind: 'text', size: 7, text: '# Shop\n', truncated: false })
  const image = readFileInside(root, 'logo.png')!
  expect(image).toMatchObject({ kind: 'image', mime: 'image/png', truncated: false })
  expect(Buffer.from(image.base64!, 'base64')[1]).toBe(0x50)
  expect(readFileInside(root, 'data.bin')).toEqual({ path: 'data.bin', kind: 'binary', size: 5, truncated: false })
  writeFileSync(join(root, 'big.log'), 'line of the log\n'.repeat(MAX_TEXT_BYTES / 8))
  const big = readFileInside(root, 'big.log')!
  expect(big.truncated).toBe(true)
  expect(big.text!.length).toBeLessThanOrEqual(MAX_TEXT_BYTES)
  expect(big.text!.endsWith('\n')).toBe(true)
  expect(readFileInside(root, '.env')).toBeNull()
  expect(readFileInside(root, 'src')).toBeNull()
})

test('searching names: name starts, contains, path, then loosely; never secrets', async () => {
  const hits = (await searchFiles(root, 'or')).map(h => h.path)
  expect(hits[0]).toBe('src/orders.tsx')
  expect((await searchFiles(root, 'csv')).map(h => h.path)).toEqual(['src/lib/csv.ts'])
  expect((await searchFiles(root, 'srcsv')).map(h => h.path)).toEqual(['src/lib/csv.ts'])
  expect((await searchFiles(root, 'env')).map(h => h.path)).toEqual(['.env.example'])
  expect(await searchFiles(root, '   ')).toEqual([])
})
