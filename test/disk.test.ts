import { expect, test } from 'bun:test'
import { DiskWatch, freeBytes, gb, isDiskFull, LOW_BYTES } from '../src/daemon/disk'
import { tmpdir } from 'node:os'

function watch(free: { bytes: number | null }) {
  let now = 1_000_000
  const said: string[] = []
  const w = new DiskWatch({ free: () => free.bytes, notify: m => said.push(m), word: 'Mac', now: () => now, log: () => {} })
  return { w, said, advance: (ms: number) => (now += ms) }
}

test('low on space: said once an hour while it stays low, and once when there is room again', () => {
  const free = { bytes: 1.2 * 1024 ** 3 as number | null }
  const t = watch(free)
  t.w.check()
  expect(t.said).toHaveLength(1)
  expect(t.said[0]).toContain('almost full (1.2 GB free)')
  expect(t.said[0]).toContain('System Settings → General → Storage')
  t.advance(30 * 60_000)
  t.w.check()
  expect(t.said).toHaveLength(1)
  t.advance(31 * 60_000)
  t.w.check()
  expect(t.said).toHaveLength(2)
  free.bytes = 160 * 1024 ** 3
  t.w.check()
  t.w.check()
  expect(t.said).toHaveLength(3)
  expect(t.said[2]).toContain('has room again (160 GB free)')
})

test('plenty of room: nothing said; a write that failed for space says so at once', () => {
  const t = watch({ bytes: LOW_BYTES * 4 })
  t.w.check()
  expect(t.said).toEqual([])
  t.w.check({ full: true })
  expect(t.said[0]).toContain('disk is full')
})

test('what counts as a full disk, and reading free space', () => {
  expect(isDiskFull(Object.assign(new Error('no space left on device, open x'), { code: 'ENOSPC' }))).toBe(true)
  expect(isDiskFull(new Error('SQLiteError: database or disk is full'))).toBe(true)
  expect(isDiskFull(new Error('ENOENT: no such file'))).toBe(false)
  expect(freeBytes(tmpdir())).toBeGreaterThan(0)
  expect(freeBytes('/definitely/not/here')).toBeNull()
  expect([gb(1.24 * 1024 ** 3), gb(160 * 1024 ** 3)]).toEqual(['1.2 GB', '160 GB'])
})
