import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUpload, MAX_UPLOAD_BYTES, pruneUploads, safeName, saveUpload, withAttachments } from '../src/daemon/uploads'

test('names lose their folders and odd characters', () => {
  expect(safeName('Screen Shot 2026-10-16 at 9.41.png')).toBe('Screen-Shot-2026-10-16-at-9.41.png')
  expect(safeName('../../etc/passwd')).toBe('passwd')
  expect(safeName('...')).toBe('file')
})

test('saved under the day, readable only by you; too big or empty says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-up-'))
  const now = Date.UTC(2026, 9, 16)
  const saved = saveUpload(dir, 'crash.png', Buffer.from('x').toString('base64'), now) as { path: string }
  expect(saved.path.startsWith(join(dir, '2026-10-16'))).toBe(true)
  expect(isUpload(dir, saved.path)).toBe(true)
  expect(isUpload(dir, '/etc/hosts')).toBe(false)
  expect(isUpload(dir, join(dir, '2026-10-16', '..', '..', 'nope'))).toBe(false)
  expect(saveUpload(dir, 'big.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'), now)).toEqual({ error: 'The file is bigger than 5 MB.' })
  expect(saveUpload(dir, 'none.txt', '', now)).toEqual({ error: 'The file is empty.' })
})

test('days older than two weeks go', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-up-'))
  for (const day of ['2026-09-20', '2026-10-10']) {
    mkdirSync(join(dir, day))
    writeFileSync(join(dir, day, 'a.png'), 'x')
  }
  pruneUploads(dir, Date.UTC(2026, 9, 16))
  expect([existsSync(join(dir, '2026-09-20')), existsSync(join(dir, '2026-10-10'))]).toEqual([false, true])
})

test('the first prompt names what was attached', () => {
  expect(withAttachments('Why does it crash?', ['/u/a.png'])).toBe('Why does it crash?\n\nAttached from the phone (read it):\n- /u/a.png')
  expect(withAttachments('x', null)).toBe('x')
})
