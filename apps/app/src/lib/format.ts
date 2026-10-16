// Times, durations and labels, worded the way the bot words them.

import type { Effort, JobInfo, MachineStatus, Role } from '@afterhours/protocol'

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function ago(at: number, now: number): string {
  const ms = now - at
  if (ms < 45_000) return 'just now'
  return `${duration(ms).split(' ')[0]} ago`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function time(d: Date): string {
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "4:30 PM" today, "Thu 9:00 AM" within the week, else "Oct 21". */
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return time(d)
  if (Math.abs(at - now) < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${time(d)}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/** A path cut from the front, at a folder, so the end (the part that says the most) stays: "…/shop/web". */
export function shortPath(path: string, max = 40): string {
  const home = path.replace(/^\/(Users|home)\/[^/]+/, '~')
  if (home.length <= max) return home
  const tail = home.slice(home.length - max + 1)
  const slash = tail.indexOf('/')
  return `…${slash >= 0 ? tail.slice(slash) : tail}`
}

/** How a task plans: the plan approved for you, approved by you, or no plan. */
export function planLabel(j: Pick<JobInfo, 'plan' | 'review' | 'mode'>): string {
  if (j.mode === 'plan' || !j.plan) return 'None'
  return j.review ? 'You approve it' : 'Approved for you'
}

/** What a task may do without asking. */
export function permissionsLabel(mode: JobInfo['mode']): string {
  return { auto: 'Auto', acceptEdits: 'Accept edits', bypassPermissions: 'No prompts', plan: 'Read only' }[mode]
}

/** A task's state, in a word or three. */
export function phaseLabel(j: Pick<JobInfo, 'status' | 'phase' | 'holdReason'>): string {
  switch (j.status) {
    case 'held':
      return 'Paused'
    case 'queued':
      return 'Queued'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
  switch (j.phase) {
    case 'launching':
      return 'Starting'
    case 'planning':
      return 'Planning'
    case 'limited':
      return 'Waiting for the limit'
    case 'finishing':
      return 'Finishing'
    default:
      return 'Working'
  }
}

export function statusLabel(status: MachineStatus, detail?: string): string {
  switch (status) {
    case 'connected':
      return 'Online'
    case 'connecting':
      return 'Connecting…'
    case 'offline':
      return 'Offline'
    case 'refused':
      return detail === 'not-paired' || !detail ? 'Removed this device' : `Refused (${detail})`
  }
}

/** Claude's aliases as Anthropic writes them (Opus); a full model name stays as it is. */
export function modelLabel(model: string): string {
  return /^[a-z]+$/.test(model) ? model[0]!.toUpperCase() + model.slice(1) : model
}

export function effortLabel(effort: Effort): string {
  return { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' }[effort]
}

export function roleLabel(role: Role): string {
  return { owner: 'Owner', operator: 'Operator', viewer: 'Viewer' }[role]
}

/** 30 → "30 min", 90 → "1 h 30 min", 120 → "2 h". */
export function minutes(n: number): string {
  if (n < 60) return `${n} min`
  const h = Math.floor(n / 60)
  return n % 60 ? `${h} h ${n % 60} min` : `${h} h`
}

/** Minutes after midnight as a clock time: 150 → "2:30 AM". */
export function timeOfDay(min: number): string {
  const d = new Date(2026, 0, 1, Math.floor(min / 60), min % 60)
  return time(d)
}

/** "2:30", "14:30", "2:30 pm", "2pm", "0230" → minutes after midnight; null when it isn't a time. */
export function parseTimeOfDay(text: string): number | null {
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*([ap])\.?\s*m?\.?\s*$/i.exec(text) ?? /^\s*(\d{1,2})(?::?(\d{2}))?\s*$/.exec(text)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const half = m[3]?.toLowerCase()
  if (min > 59) return null
  if (half) {
    if (h < 1 || h > 12) return null
    h = (h % 12) + (half === 'p' ? 12 : 0)
  } else if (h > 23) {
    return null
  }
  return h * 60 + min
}

/** The next time the clock shows `min` (minutes after midnight), from `now`. */
export function nextAt(min: number, now: number): number {
  const d = new Date(now)
  d.setHours(Math.floor(min / 60), min % 60, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** When a waiting task starts, in words: "Every day at 2:00 AM", "At Thu 9:00 AM", "After #14". */
export function whenLabel(j: Pick<JobInfo, 'notBefore' | 'afterJob' | 'repeatDaily'>, now: number): string | null {
  const parts: string[] = []
  if (j.repeatDaily !== null && j.repeatDaily !== undefined) parts.push(`Every day at ${timeOfDay(j.repeatDaily)}`)
  else if (j.notBefore && j.notBefore > now) parts.push(`At ${clock(j.notBefore, now)}`)
  if (j.afterJob !== null && j.afterJob !== undefined) parts.push(`after #${j.afterJob}`)
  if (parts.length === 0) return null
  const text = parts.join(', ')
  return text[0]!.toUpperCase() + text.slice(1)
}

/** 1234 → "1.2k", 3400000 → "3.4M". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 0.4213 → "$0.42"; under a cent, "<$0.01". */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(usd < 100 ? 2 : 0)}`
}

/** One line of text from a longer one. */
export function oneLine(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const isEmoji = (cp: number) => (cp >= 0x2190 && cp <= 0x2bff) || cp >= 0x1f000

/** A reply without the emoji the bot puts in it ("✅ Approved #14's request." → "Approved #14's request."). */
export function plainReply(text: string): string {
  return [...text]
    .filter(ch => !isEmoji(ch.codePointAt(0) ?? 0) && ch !== '\uFE0F')
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** The machine words its notices like the Telegram bot, emoji first; the app shows an icon instead. */
export function withoutEmoji(text: string): string {
  const space = text.indexOf(' ')
  const first = text.codePointAt(0)
  return space > 0 && space <= 8 && first !== undefined && isEmoji(first) ? text.slice(space + 1) : text
}
