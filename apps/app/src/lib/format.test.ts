import { describe, expect, test } from 'bun:test'
import { basename, bytes, clock, duration, effortLabel, minutes, plainReply, modelLabel, nextAt, parseTimeOfDay, permissionsLabel, phaseLabel, planLabel, roleLabel, shortPath, timeOfDay, whenLabel, withoutEmoji } from './format'

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
    expect(planLabel({ plan: true, review: false, mode: 'auto' })).toBe('Approved for you')
    expect(planLabel({ plan: true, review: true, mode: 'acceptEdits' })).toBe('You approve it')
    expect(planLabel({ plan: false, review: false, mode: 'auto' })).toBe('None')
    expect(planLabel({ plan: true, review: false, mode: 'plan' })).toBe('None')
    expect(permissionsLabel('bypassPermissions')).toBe('No prompts')
    expect(permissionsLabel('plan')).toBe('Read only')
    expect(phaseLabel({ status: 'running', phase: 'limited', holdReason: null })).toBe('Waiting for the limit')
    expect(phaseLabel({ status: 'held', phase: null, holdReason: 'stopped by you' })).toBe('Paused')
    expect(roleLabel('operator')).toBe('Operator')
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(effortLabel('xhigh')).toBe('X-high')
  })
})

describe('when a task starts', () => {
  test('times of day, typed the ways people type them', () => {
    expect(['2:30', '14:30', '2:30 pm', '2pm', '0230', '12 am', '12:15 PM', '7 a.m.'].map(parseTimeOfDay)).toEqual([150, 870, 870, 840, 150, 0, 735, 420])
    expect(['25:00', '2:75', '13 pm', 'soon', ''].map(parseTimeOfDay)).toEqual([null, null, null, null, null])
    expect([timeOfDay(150), timeOfDay(870), timeOfDay(0)]).toEqual(['2:30 AM', '2:30 PM', '12:00 AM'])
    expect([minutes(30), minutes(90), minutes(120)]).toEqual(['30 min', '1 h 30 min', '2 h'])
  })

  test('the next 2:30, and a waiting task in words', () => {
    const now = new Date(2026, 9, 16, 14, 0).getTime()
    expect(nextAt(150, now)).toBe(new Date(2026, 9, 17, 2, 30).getTime())
    expect(nextAt(15 * 60, now)).toBe(new Date(2026, 9, 16, 15, 0).getTime())
    expect(whenLabel({ notBefore: new Date(2026, 9, 16, 17, 0).getTime(), afterJob: null, repeatDaily: null }, now)).toBe('At 5:00 PM')
    expect(whenLabel({ notBefore: null, afterJob: 14, repeatDaily: null }, now)).toBe('After #14')
    expect(whenLabel({ notBefore: nextAt(150, now), afterJob: 14, repeatDaily: 150 }, now)).toBe('Every day at 2:30 AM, after #14')
    expect(whenLabel({ notBefore: now - 1000, afterJob: null, repeatDaily: null }, now)).toBeNull()
  })
})

test('replies without the bot’s emoji', () => {
  expect(plainReply("✅ Approved #14's request.")).toBe("Approved #14's request.")
  expect(plainReply('❌ Declined #14’s plan.')).toBe('Declined #14’s plan.')
  expect(plainReply('Queued #21.')).toBe('Queued #21.')
})

describe('sizes', () => {
  test('as df -h counts them', () => {
    expect(bytes(512)).toBe('512 bytes')
    expect(bytes(850_000)).toBe('830 KB')
    expect(bytes(2.4 * 1024 * 1024)).toBe('2.4 MB')
    expect(bytes(120e9)).toBe('112 GB')
    expect(bytes(2e12)).toBe('1.8 TB')
  })
})
