import type { LimitState, LimitWindow } from '../shared/types'

/** Accepts epoch seconds, epoch ms, or a date string. */
export function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return toMs(n)
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

interface RawWindow {
  used_percentage?: unknown
  resets_at?: unknown
}

function toWindow(raw: unknown): LimitWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as RawWindow
  return {
    usedPct: typeof w.used_percentage === 'number' ? w.used_percentage : null,
    resetsAt: toMs(w.resets_at),
  }
}

/** Reads the `rate_limits` block Claude Code passes to the status line command. */
export function windowsFromStatusline(rateLimits: unknown): Pick<LimitState, 'fiveHour' | 'sevenDay'> {
  const rl = (rateLimits ?? {}) as { five_hour?: unknown; seven_day?: unknown }
  return { fiveHour: toWindow(rl.five_hour), sevenDay: toWindow(rl.seven_day) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function offsetMs(timeZone: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map(p => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour! % 24, +parts.minute!, +parts.second!)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** Converts a wall-clock time in `timeZone` to epoch ms (month is 0-based). */
export function wallToUtc(timeZone: string, y: number, month: number, d: number, h: number, min: number): number {
  const guess = Date.UTC(y, month, d, h, min)
  let utc = guess - offsetMs(timeZone, guess)
  const corrected = guess - offsetMs(timeZone, utc)
  if (corrected !== utc) utc = corrected
  return utc
}

function wallDate(timeZone: string, utcMs: number): { y: number; month: number; d: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(new Date(utcMs))
      .map(p => [p.type, p.value]),
  )
  return {
    y: +parts.year!,
    month: +parts.month! - 1,
    d: +parts.day!,
    weekday: WEEKDAYS.indexOf(parts.weekday!.slice(0, 3).toLowerCase()),
  }
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const DAY = 24 * 60 * 60 * 1000

/**
 * Finds the reset time in a usage-limit message such as
 * "You've hit your session limit · resets 3:30pm (America/New_York)".
 */
export function parseResetText(text: string, now: number, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const m = /\bresets?\s+(?:at\s+|on\s+)?([^·\n]+)/i.exec(text)
  if (!m?.[1]) return null
  let rest = m[1].trim()

  let zone = localZone
  const zm = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\)/.exec(rest)
  if (zm?.[1] && validZone(zm[1])) {
    zone = zm[1]
    rest = rest.replace(zm[0], '').trim()
  }

  const rel = /^in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?/i.exec(rest)
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return now + ((+(rel[1] ?? 0) * 24 + +(rel[2] ?? 0)) * 60 + +(rel[3] ?? 0)) * 60 * 1000
  }

  const iso = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s*(UTC|Z)?/i.exec(rest)
  if (iso) {
    const z = iso[6] ? 'UTC' : zone
    return wallToUtc(z, +iso[1]!, +iso[2]! - 1, +iso[3]!, +iso[4]!, +iso[5]!)
  }

  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(\d{1,2}):(\d{2})/i.exec(rest)
  if (!time) return null
  let hour: number
  let minute: number
  if (time[3]) {
    hour = (+time[1]! % 12) + (time[3].toLowerCase() === 'pm' ? 12 : 0)
    minute = +(time[2] ?? 0)
  } else {
    hour = +time[4]!
    minute = +time[5]!
  }
  if (hour > 23 || minute > 59) return null

  const before = rest.slice(0, time.index).toLowerCase()
  const today = wallDate(zone, now)
  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/.exec(before)
  if (monthDay) {
    const month = MONTHS.indexOf(monthDay[1]!)
    let at = wallToUtc(zone, today.y, month, +monthDay[2]!, hour, minute)
    if (at < now - DAY) at = wallToUtc(zone, today.y + 1, month, +monthDay[2]!, hour, minute)
    return at
  }

  let at = wallToUtc(zone, today.y, today.month, today.d, hour, minute)
  const weekday = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/.exec(before)
  if (weekday) {
    let days = (WEEKDAYS.indexOf(weekday[1]!) - today.weekday + 7) % 7
    if (days === 0 && at <= now) days = 7
    return wallToUtc(zone, today.y, today.month, today.d + days, hour, minute)
  }
  if (/\btomorrow\b/.test(before)) return wallToUtc(zone, today.y, today.month, today.d + 1, hour, minute)
  if (at <= now) at = wallToUtc(zone, today.y, today.month, today.d + 1, hour, minute)
  return at
}

export interface ResetPick {
  at: number | null
  source: 'message' | 'status line' | 'unknown'
  window?: 'five_hour' | 'seven_day'
}

/**
 * When will a usage-limit stop clear? Prefers the status line's exact timestamps for an
 * exhausted window, then the text of the error, otherwise unknown.
 */
export function pickResetTime(state: LimitState, failureText: string, now: number): ResetPick {
  const exhausted: { window: 'five_hour' | 'seven_day'; at: number }[] = []
  const windows: ['five_hour' | 'seven_day', LimitWindow | undefined][] = [
    ['five_hour', state.fiveHour],
    ['seven_day', state.sevenDay],
  ]
  for (const [window, w] of windows) {
    if (w?.resetsAt && w.resetsAt > now && (w.usedPct ?? 0) >= 100) exhausted.push({ window, at: w.resetsAt })
  }
  if (exhausted.length > 0) {
    const latest = exhausted.reduce((a, b) => (b.at > a.at ? b : a))
    return { at: latest.at, source: 'status line', window: latest.window }
  }
  const fromText = parseResetText(failureText, now)
  if (fromText && fromText > now - 60_000) {
    const window = /week|7-day|seven/i.test(failureText) ? 'seven_day' : 'five_hour'
    return { at: fromText, source: 'message', window }
  }
  return { at: null, source: 'unknown' }
}

export function formatClock(ms: number, now: number, timeZone?: string): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const a = wallDate(zone, ms)
  const b = wallDate(zone, now)
  if (a.y === b.y && a.month === b.month && a.d === b.d) return time
  if (ms - now < 6 * DAY) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms))
    return `${day} ${time}`
  }
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(new Date(ms))
  return `${date}, ${time}`
}

export function windowLabel(window: string | undefined): string {
  return window === 'seven_day' ? 'weekly limit' : '5-hour limit'
}
