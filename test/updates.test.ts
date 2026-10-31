import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForUpdate, isNewer, latestRelease, pendingUpdate, updateCommand, updateNotice, type UpdateCheck } from '../src/daemon/updates'
import { updateView } from '../src/telegram/ui'

const release = (tag: string): typeof fetch => (async () => Response.json({ tag_name: tag, assets: [{ name: 'cq-linux-x64', browser_download_url: 'https://example.test/cq' }] })) as unknown as typeof fetch

function check(over: Partial<UpdateCheck> = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'cq-upd-')), 'update.json')
  const told: string[] = []
  const logs: string[] = []
  let announced: string | undefined
  const o: UpdateCheck = {
    current: '0.6.0',
    command: 'cq update',
    file,
    now: () => 1_000,
    fetch: release('v0.7.0'),
    announced: { get: () => announced, set: v => (announced = v) },
    announce: latest => (told.push(latest), true),
    log: line => logs.push(line),
    ...over,
  }
  return { o, file, told, logs, announcedNow: () => announced }
}

test('versions compare as numbers', () => {
  expect(isNewer('0.10.0', '0.9.0')).toBe(true)
  expect(isNewer('1.0.0', '0.99.99')).toBe(true)
  expect(isNewer('0.6.0', '0.6.0')).toBe(false)
  expect(isNewer('0.5.9', '0.6.0')).toBe(false)
  expect(isNewer('nightly', '0.6.0')).toBe(false)
})

test('the latest release comes from GitHub, and errors are errors', async () => {
  expect(await latestRelease(release('v0.7.0'))).toMatchObject({ version: '0.7.0', tag: 'v0.7.0' })
  await expect(latestRelease((async () => new Response('no', { status: 403 })) as unknown as typeof fetch)).rejects.toThrow('403')
  await expect(latestRelease(release('nightly'))).rejects.toThrow('without a version')
})

test('what to type: cq update, brew upgrade for Homebrew, nothing from source', () => {
  expect(updateCommand(['/home/me/.afterhours/bin/cq'])).toBe('cq update')
  expect(updateCommand(['/usr/local/bin/bun', '/code/src/cli/cq.ts'])).toBeNull()
  const cellar = mkdtempSync(join(tmpdir(), 'cq-brew-'))
  require('node:fs').mkdirSync(join(cellar, 'bin'), { recursive: true })
  require('node:fs').mkdirSync(join(cellar, 'Cellar', 'afterhours', '0.6.0', 'bin'), { recursive: true })
  writeFileSync(join(cellar, 'bin', 'cq'), '')
  expect(updateCommand([join(cellar, 'Cellar', 'afterhours', '0.6.0', 'bin', 'cq')])).toBe('brew upgrade afterhours')
})

test('a newer release is saved and announced once per version', async () => {
  const t = check()
  await checkForUpdate(t.o)
  expect(JSON.parse(readFileSync(t.file, 'utf8'))).toEqual({ latest: '0.7.0', checkedAt: 1_000 })
  expect(t.told).toEqual(['0.7.0'])
  expect(t.announcedNow()).toBe('0.7.0')
  // Looking again says nothing more; a still newer one is announced.
  await checkForUpdate(t.o)
  expect(t.told).toEqual(['0.7.0'])
  await checkForUpdate({ ...t.o, fetch: release('v0.8.0') })
  expect(t.told).toEqual(['0.7.0', '0.8.0'])
})

test('nothing is announced for the same or an older release, or from source', async () => {
  const same = check({ fetch: release('v0.6.0') })
  await checkForUpdate(same.o)
  expect(same.told).toEqual([])
  expect(pendingUpdate('0.6.0', same.file)).toBeNull()
  const older = check({ fetch: release('v0.5.0') })
  await checkForUpdate(older.o)
  expect(older.told).toEqual([])
  const source = check({ command: null })
  await checkForUpdate(source.o)
  expect(source.told).toEqual([])
})

test('with nobody to tell yet, it is tried again next time', async () => {
  let ready = false
  const t = check({ announce: latest => ready && (t.told.push(latest), true) })
  await checkForUpdate(t.o)
  expect(t.announcedNow()).toBeUndefined()
  ready = true
  await checkForUpdate(t.o)
  expect(t.told).toEqual(['0.7.0'])
})

test('no network: quiet, logged, and the last answer stays', async () => {
  const t = check()
  await checkForUpdate(t.o)
  await checkForUpdate({ ...t.o, fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch })
  expect(t.logs).toEqual(['update check failed: offline'])
  expect(pendingUpdate('0.6.0', t.file)).toBe('0.7.0')
})

test('the terminal line: only when newer, and only with a way to update', async () => {
  const t = check()
  expect(updateNotice(['/x/cq'], '0.6.0', t.file)).toBeNull()
  expect(existsSync(t.file)).toBe(false)
  await checkForUpdate(t.o)
  expect(updateNotice(['/x/cq'], '0.6.0', t.file)).toBe('Afterhours 0.7.0 is out (you have 0.6.0). Run: cq update')
  expect(updateNotice(['/x/cq'], '0.7.0', t.file)).toBeNull()
  expect(updateNotice(['bun', '/src/cq.ts'], '0.6.0', t.file)).toBeNull()
})

test('the Telegram message says what to run', () => {
  const v = updateView('0.7.0', '0.6.0', 'cq update', 'Afterhours')
  expect(v.html).toContain('<b>Afterhours 0.7.0 is out</b> (this computer has 0.6.0)')
  expect(v.html).toContain('<code>cq update</code>')
  expect(v.silent).toBe(true)
})
