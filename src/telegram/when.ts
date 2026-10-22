// ⏰ Later: when a task should start, from a preset (in an hour, tonight, tomorrow morning) or a time
// you type: 23:00, 11pm, 7:30am, in 2h, in 45m, tomorrow 9am.

const HOUR = 3600_000

/** The next time the clock shows hh:mm (today, or tomorrow if that's passed). */
export function nextClock(now: number, hours: number, minutes = 0, o: { tomorrow?: boolean } = {}): number {
  const d = new Date(now)
  d.setHours(hours, minutes, 0, 0)
  if (o.tomorrow) d.setDate(d.getDate() + 1)
  else if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export const LATER = {
  /** In an hour. */
  hour: (now: number) => now + HOUR,
  /** Tonight at 23:00 (tomorrow's, if that's passed). */
  tonight: (now: number) => nextClock(now, 23),
  /** Tomorrow at 07:00 (today's, before 07:00). */
  morning: (now: number) => nextClock(now, 7),
}

/** A time you typed, as when to start; null if it isn't one. */
export function parseWhen(text: string, now: number): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const rel = /^in (\d{1,3}) ?(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(t)
  if (rel) {
    const n = Number(rel[1])
    if (n <= 0) return null
    return now + n * (rel[2]!.startsWith('h') ? HOUR : 60_000)
  }
  const m = /^(tomorrow |at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/.exec(t)
  if (!m) return null
  let hours = Number(m[2])
  const minutes = m[3] ? Number(m[3]) : 0
  const half = m[4]
  if (minutes > 59) return null
  if (half) {
    if (hours < 1 || hours > 12) return null
    hours = (hours % 12) + (half === 'pm' ? 12 : 0)
  } else if (hours > 23 || (!m[3] && !m[1])) {
    // A bare number ("7") is too easy to mean something else: it needs :mm, am/pm or "at".
    return null
  }
  return nextClock(now, hours, minutes, { tomorrow: m[1] === 'tomorrow ' })
}
