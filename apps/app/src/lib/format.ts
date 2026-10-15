// Times, durations and labels, worded the way the bot words them.

import type { JobInfo, MachineStatus } from '@afterhours/protocol'

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

export function modeLabel(j: Pick<JobInfo, 'plan' | 'review' | 'mode'>): string {
  const mode = { auto: 'auto', acceptEdits: 'accept edits', bypassPermissions: 'yolo', plan: 'ask' }[j.mode]
  if (j.mode === 'plan') return 'ask'
  return j.plan ? `${j.review ? 'review' : 'plan'} → ${mode}` : mode
}

export function phaseLabel(j: Pick<JobInfo, 'status' | 'phase' | 'holdReason'>): string {
  if (j.status === 'held') return `paused: ${j.holdReason ?? 'needs you'}`
  if (j.status !== 'running') return j.status
  switch (j.phase) {
    case 'launching':
      return 'starting'
    case 'planning':
      return 'planning'
    case 'limited':
      return 'waiting for the limit reset'
    case 'finishing':
      return 'wrapping up'
    default:
      return 'working'
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
      return detail === 'not-paired' || !detail ? 'Removed: pair again' : `Refused: ${detail}`
  }
}

/** One line of text from a longer one. */
export function oneLine(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const isEmoji = (cp: number) => (cp >= 0x2190 && cp <= 0x2bff) || cp >= 0x1f000

/** The machine words its notices like the Telegram bot, emoji first; the app shows an icon instead. */
export function withoutEmoji(text: string): string {
  const space = text.indexOf(' ')
  const first = text.codePointAt(0)
  return space > 0 && space <= 8 && first !== undefined && isEmoji(first) ? text.slice(space + 1) : text
}
