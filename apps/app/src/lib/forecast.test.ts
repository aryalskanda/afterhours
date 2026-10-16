import { describe, expect, test } from 'bun:test'
import { forecast, forecastLabel, usageBars } from './forecast'

const MIN = 60_000
const now = new Date(2026, 9, 16, 14, 0).getTime()
const at = (minAgo: number, fiveHour: number | null, sevenDay: number | null = 20) => ({ at: now - minAgo * MIN, fiveHour, sevenDay })

describe('forecast', () => {
  test('the pace over the last hour says when the 5-hour limit runs out', () => {
    // 30 points in the last hour: 60 used, 40 to go at 30 an hour is 80 minutes.
    const samples = [at(200, 10), at(60, 30), at(30, 45), at(5, 58)]
    const f = forecast(samples, 'fiveHour', now, { usedPct: 60, resetsAt: now + 3 * 60 * MIN })
    expect(f.perHour).toBe(30)
    expect(f.fullAt).toBe(now + 80 * MIN)
    expect(forecastLabel(f, now + 3 * 60 * MIN, now)).toBe('At this rate you reach it at 3:20 PM.')
  })

  test('it lasts when the limit resets first, and a reset starts the count again', () => {
    const resetsAt = now + 30 * MIN
    const lasts = forecast([at(50, 40), at(10, 45)], 'fiveHour', now, { usedPct: 46, resetsAt })
    expect(lasts).toEqual({ perHour: 7.2, fullAt: null })
    expect(forecastLabel(lasts, resetsAt, now)).toBe('At this rate it lasts until it resets at 2:30 PM.')
    // 90 → 5 is a reset: the pace is from 5, not from 90.
    const after = forecast([at(55, 90), at(40, 5), at(10, 20)], 'fiveHour', now, { usedPct: 20, resetsAt: now + 4 * 60 * MIN })
    expect(after.perHour).toBe(22.5)
  })

  test('too little to tell, or nothing used', () => {
    expect(forecast([at(5, 50)], 'fiveHour', now, { usedPct: 52, resetsAt: null })).toEqual({ perHour: null, fullAt: null })
    expect(forecast([], 'fiveHour', now)).toEqual({ perHour: null, fullAt: null })
    const idle = forecast([at(50, 12), at(20, 12)], 'fiveHour', now, { usedPct: 12, resetsAt: null })
    expect(forecastLabel(idle, null, now)).toBe('Not used lately.')
    expect(forecastLabel({ perHour: null, fullAt: null }, null, now)).toBeNull()
  })

  test('the weekly limit is paced over a day', () => {
    const f = forecast([at(24 * 60, null, 40), at(12 * 60, null, 50)], 'sevenDay', now, { usedPct: 64, resetsAt: now + 5 * 24 * 60 * MIN })
    expect(f.perHour).toBe(1)
    expect(f.fullAt).toBe(now + 36 * 60 * MIN)
  })
})

describe('bars', () => {
  test('the highest use in each slice, gaps left empty', () => {
    const samples = [at(170, 10), at(160, 30), at(100, 40), at(10, 5)]
    expect(usageBars(samples, 'fiveHour', now - 180 * MIN, now, 3)).toEqual([30, 40, 5])
    expect(usageBars(samples, 'fiveHour', now - 240 * MIN, now, 4)).toEqual([null, 30, 40, 5])
  })
})
