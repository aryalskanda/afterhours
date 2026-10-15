import { describe, expect, test } from 'bun:test'
import { basename, clock, duration, modeLabel, shortPath, withoutEmoji } from './format'

describe('notices without their emoji', () => {
  test('the emoji the machine starts a sentence with goes', () => {
    expect(withoutEmoji('🔐 #14 wants to use Bash')).toBe('#14 wants to use Bash')
    expect(withoutEmoji('✅ #12 done')).toBe('#12 done')
    expect(withoutEmoji('▶️ #14 started')).toBe('#14 started')
    expect(withoutEmoji('⏸️ #14 paused')).toBe('#14 paused')
  })

  test('anything else stays', () => {
    expect(withoutEmoji('#14 started')).toBe('#14 started')
    expect(withoutEmoji('“Refactor” was sent')).toBe('“Refactor” was sent')
    expect(withoutEmoji('構築 done')).toBe('構築 done')
    expect(withoutEmoji('')).toBe('')
  })
})

describe('times and labels', () => {
  test('durations', () => {
    expect(duration(4_000)).toBe('4s')
    expect(duration(12 * 60_000)).toBe('12m')
    expect(duration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m')
    expect(duration(3 * 86_400_000 + 2 * 3_600_000)).toBe('3d 2h')
  })

  test('a time today, this week, or further off', () => {
    const now = new Date(2026, 9, 15, 16, 0).getTime()
    expect(clock(new Date(2026, 9, 15, 9, 5).getTime(), now)).toBe('9:05 AM')
    expect(clock(new Date(2026, 9, 13, 21, 30).getTime(), now)).toBe('Tue 9:30 PM')
    expect(clock(new Date(2026, 8, 1, 12, 0).getTime(), now)).toBe('Sep 1')
  })

  test('paths', () => {
    expect(basename('/home/me/code/shop/web/')).toBe('web')
    expect(shortPath('/Users/me/code/shop/web')).toBe('~/code/shop/web')
    expect(shortPath('/home/me/a/very/long/path/that/goes/on/and/on/to/the/project', 30)).toBe('…/on/and/on/to/the/project')
  })

  test('how a task runs', () => {
    expect(modeLabel({ plan: true, review: false, mode: 'auto' })).toBe('plan → auto')
    expect(modeLabel({ plan: true, review: true, mode: 'acceptEdits' })).toBe('review → accept edits')
    expect(modeLabel({ plan: false, review: false, mode: 'bypassPermissions' })).toBe('yolo')
    expect(modeLabel({ plan: false, review: false, mode: 'plan' })).toBe('ask')
  })
})
