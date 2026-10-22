// ⏰ Later: the times the bot understands when you type one.

import { expect, test } from 'bun:test'
import { LATER, nextClock, parseWhen } from '../src/telegram/when'

// Thursday 22 October 2026, 20:30 local time.
const now = new Date(2026, 9, 22, 20, 30).getTime()
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()

test('a clock time: today if it is still ahead, else tomorrow', () => {
  expect(parseWhen('23:00', now)).toBe(at(22, 23))
  expect(parseWhen('11pm', now)).toBe(at(22, 23))
  expect(parseWhen('7:30am', now)).toBe(at(23, 7, 30))
  expect(parseWhen('at 9', now)).toBe(at(23, 9))
  expect(parseWhen('20:15', now)).toBe(at(23, 20, 15))
  expect(parseWhen('12am', now)).toBe(at(23, 0))
  expect(parseWhen('12pm', now)).toBe(at(23, 12))
})

test('tomorrow, and in a while', () => {
  expect(parseWhen('tomorrow 9am', now)).toBe(at(23, 9))
  expect(parseWhen('tomorrow 23:00', now)).toBe(at(23, 23))
  expect(parseWhen('in 2h', now)).toBe(now + 2 * 3600_000)
  expect(parseWhen('in 45 minutes', now)).toBe(now + 45 * 60_000)
  expect(parseWhen('In 1 hour', now)).toBe(now + 3600_000)
})

test("what isn't a time", () => {
  for (const text of ['soonish', '7', '25:00', '13pm', '9:75', 'in 0h', 'tomorrow', '']) expect(parseWhen(text, now)).toBeNull()
})

test('the presets: in an hour, tonight at 23:00, 07:00 in the morning', () => {
  expect(LATER.hour(now)).toBe(now + 3600_000)
  expect(LATER.tonight(now)).toBe(at(22, 23))
  expect(LATER.tonight(at(22, 23, 30))).toBe(at(23, 23))
  expect(LATER.morning(now)).toBe(at(23, 7))
  expect(LATER.morning(at(22, 6))).toBe(at(22, 7))
  expect(nextClock(now, 20, 30)).toBe(at(23, 20, 30))
})
