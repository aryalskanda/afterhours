import { describe, expect, test } from 'bun:test'
import { currentLimits, fallbackModel, formatClock, modelFamily, modelLimit, modelLimited, parseResetText, pickResetTime, toMs, wallToUtc, windowLabel, windowsFromStatusline } from '../src/daemon/limits'

const NY = 'America/New_York'
// 2026-10-14 10:00 in New York (EDT, UTC-4)
const now = Date.UTC(2026, 9, 14, 14, 0)

describe('parseResetText', () => {
  test('time with zone, later today', () => {
    const at = parseResetText("You've hit your session limit · resets 3:30pm (America/New_York)", now, 'UTC')
    expect(at).toBe(Date.UTC(2026, 9, 14, 19, 30))
  })

  test('time already passed today means tomorrow', () => {
    expect(parseResetText('resets 9am', now, NY)).toBe(Date.UTC(2026, 9, 15, 13, 0))
  })

  test('month and day', () => {
    expect(parseResetText('Weekly limit reached · resets Oct 16, 9am (America/New_York)', now)).toBe(Date.UTC(2026, 9, 16, 13, 0))
  })

  test('weekday', () => {
    // Oct 14 2026 is a Wednesday; Friday is two days later.
    expect(parseResetText('resets Fri 8:15 AM', now, NY)).toBe(Date.UTC(2026, 9, 16, 12, 15))
  })

  test('relative and ISO forms', () => {
    expect(parseResetText('resets in 2h 5m', now)).toBe(now + (2 * 60 + 5) * 60_000)
    expect(parseResetText('resets 2026-10-15 00:00 UTC', now)).toBe(Date.UTC(2026, 9, 15, 0, 0))
  })

  test('24-hour clock', () => {
    expect(parseResetText('resets 17:45 (America/New_York)', now)).toBe(Date.UTC(2026, 9, 14, 21, 45))
  })

  test('nothing to parse', () => {
    expect(parseResetText('API Error: overloaded', now)).toBeNull()
    expect(parseResetText('resets soon', now)).toBeNull()
  })
})

test('wallToUtc across a DST change', () => {
  // New York leaves DST on 2026-11-01: 9am is 13:00 UTC before and 14:00 UTC after.
  expect(wallToUtc(NY, 2026, 9, 31, 9, 0)).toBe(Date.UTC(2026, 9, 31, 13, 0))
  expect(wallToUtc(NY, 2026, 10, 2, 9, 0)).toBe(Date.UTC(2026, 10, 2, 14, 0))
})

describe('status line windows', () => {
  test('epoch seconds become ms', () => {
    expect(toMs(1791967800)).toBe(1791967800_000)
    expect(toMs(1791967800_000)).toBe(1791967800_000)
    expect(toMs('2026-10-15T00:00:00Z')).toBe(Date.UTC(2026, 9, 15))
    expect(toMs(null)).toBeNull()
  })

  test('windowsFromStatusline', () => {
    expect(
      windowsFromStatusline({ five_hour: { used_percentage: 20, resets_at: 1791967800 }, seven_day: { used_percentage: 4, resets_at: 1792094400 } }),
    ).toEqual({
      fiveHour: { usedPct: 20, resetsAt: 1791967800_000 },
      sevenDay: { usedPct: 4, resetsAt: 1792094400_000 },
    })
  })
})

describe('pickResetTime', () => {
  const fiveAt = now + 90 * 60_000
  const weekAt = now + 3 * 24 * 3600_000

  test('an exhausted window wins over the message', () => {
    const pick = pickResetTime({ fiveHour: { usedPct: 100, resetsAt: fiveAt } }, 'resets 11pm', now)
    expect(pick).toEqual({ at: fiveAt, source: 'status line', window: 'five_hour' })
  })

  test('both exhausted: wait for the later one', () => {
    const pick = pickResetTime(
      { fiveHour: { usedPct: 100, resetsAt: fiveAt }, sevenDay: { usedPct: 100, resetsAt: weekAt } },
      '',
      now,
    )
    expect(pick.at).toBe(weekAt)
    expect(pick.window).toBe('seven_day')
  })

  test('falls back to the message, then unknown', () => {
    expect(pickResetTime({ fiveHour: { usedPct: 80, resetsAt: fiveAt } }, 'resets 3:30pm (America/New_York)', now).source).toBe('message')
    expect(pickResetTime({}, 'nothing here', now)).toEqual({ at: null, source: 'unknown' })
  })
})

test('formatClock', () => {
  expect(formatClock(Date.UTC(2026, 9, 14, 19, 30), now, NY)).toBe('3:30 PM')
  expect(formatClock(Date.UTC(2026, 9, 16, 13, 0), now, NY)).toBe('Fri 9:00 AM')
  expect(formatClock(Date.UTC(2026, 9, 30, 13, 0), now, NY)).toBe('Oct 30, 9:00 AM')
})

test('a window whose reset has passed since the last reading is unknown, not its old percentage', () => {
  const now = Date.UTC(2026, 9, 25, 15, 0)
  const read = { fiveHour: { usedPct: 17, resetsAt: now - 3 * 86_400_000 }, sevenDay: { usedPct: 87, resetsAt: now + 3600_000 }, updatedAt: now - 3 * 86_400_000 }
  const l = currentLimits(read, now)
  expect(l.fiveHour).toEqual({ usedPct: null, resetsAt: null })
  expect(l.sevenDay).toEqual({ usedPct: 87, resetsAt: now + 3600_000 })
  expect(l.updatedAt).toBe(read.updatedAt)
})

describe("one model's own limit", () => {
  const FABLE = "You've hit your Fable limit · resets Nov 20 at 1:45am (Asia/Katmandu)"

  test('names the model; the account limits name none', () => {
    expect(modelLimit(FABLE)).toBe('fable')
    expect(modelLimit("You've hit your Opus weekly limit · resets Fri 3am")).toBe('opus')
    expect(modelLimit("You've hit your session limit · resets 4:55am (Asia/Katmandu)")).toBeNull()
    expect(modelLimit("You've hit your weekly limit · resets Mon 9am")).toBeNull()
    expect(modelLimit("You've hit your usage limit")).toBeNull()
    expect(modelLimit("You've hit your org's monthly limit")).toBeNull()
  })

  test("isn't taken for the 5-hour limit (task #239)", () => {
    const at = Date.UTC(2026, 10, 16, 18, 44)
    const pick = pickResetTime({}, FABLE, at)
    expect(pick).toEqual({ at: Date.UTC(2026, 10, 19, 20, 0), source: 'message', window: 'model:fable' })
    expect(windowLabel(pick.window)).toBe('Fable limit')
  })

  test('an exhausted account window still wins', () => {
    const reset = now + 3600_000
    expect(pickResetTime({ fiveHour: { usedPct: 100, resetsAt: reset } }, FABLE, now).window).toBe('five_hour')
  })

  test('families, and limits that pass', () => {
    expect(modelFamily('claude-opus-4-8[1m]')).toBe('opus')
    expect(modelFamily('fable')).toBe('fable')
    const l = { models: { fable: now + 60_000 } }
    expect(modelLimited(l, 'fable', now)).toBe(now + 60_000)
    expect(modelLimited(l, 'opus', now)).toBeNull()
    expect(currentLimits(l, now + 120_000).models).toEqual({})
  })

  test('the fallback: the other model, then your default, then Claude Code\'s list, skipping any at a limit', () => {
    const offered = ['opus', 'sonnet', 'fable', 'haiku']
    const limits = { models: { fable: now + 60_000 } }
    expect(fallbackModel({ current: 'fable', other: 'haiku', preferred: 'opus', offered, limits, now })).toBe('haiku')
    expect(fallbackModel({ current: 'fable', other: null, preferred: 'opus', offered, limits, now })).toBe('opus')
    expect(fallbackModel({ current: 'fable', other: 'fable', preferred: 'fable', offered, limits, now })).toBe('opus')
    const most = { models: { fable: now + 60_000, opus: now + 60_000 } }
    expect(fallbackModel({ current: 'fable', preferred: 'opus', offered, limits: most, now })).toBe('sonnet')
    const all = { models: Object.fromEntries(offered.map(m => [m, now + 60_000])) }
    expect(fallbackModel({ current: 'fable', preferred: 'opus', offered, limits: all, now })).toBeNull()
  })
})
