// What you want to hear about when the app isn't in front, as push notifications on a phone and
// system notifications in a browser or the desktop app: which notices, quiet hours, and whether
// they say what the task asks (pushes leave the end-to-end encryption). Also what a notification
// opens, and what its buttons answer.

import type { PushPrefs } from '@afterhours/protocol'
import type { RequestBody } from './hub'

export interface NotifyPrefs {
  events: PushPrefs['events']
  /** Minutes after midnight, this device's time. */
  quiet: { start: number; end: number } | null
  details: boolean
}

export const DEFAULT_NOTIFY: NotifyPrefs = { events: { requests: true, done: true, failed: true, limits: true }, quiet: null, details: true }

export type NoticeGroup = keyof NotifyPrefs['events']

/** Which switch a notice falls under (as the machine decides for pushes); null: never notified. */
export function noticeGroup(type: string): NoticeGroup | null {
  if (['permission', 'question', 'plan_review', 'trust'].includes(type)) return 'requests'
  if (type === 'done') return 'done'
  if (['failed', 'held', 'conflict', 'setup_warning'].includes(type)) return 'failed'
  if (['limit', 'session_limit'].includes(type)) return 'limits'
  return null
}

/** Whether `minute` (after midnight) falls in quiet hours that may run past midnight. */
export function quietAt(quiet: NotifyPrefs['quiet'], minute: number): boolean {
  if (!quiet || quiet.start === quiet.end) return false
  return quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end
}

/** Whether to show a system notification for a notice now. */
export function wantsNotice(prefs: NotifyPrefs, type: string, at: Date): boolean {
  const group = noticeGroup(type)
  return group !== null && prefs.events[group] && !quietAt(prefs.quiet, at.getHours() * 60 + at.getMinutes())
}

/** A notification's text without details: what happened, not what the task asks. */
export function genericText(type: string, job: number | null): string {
  const task = job !== null ? `#${job}` : 'A task'
  switch (noticeGroup(type)) {
    case 'requests':
      return `${task} needs you.`
    case 'done':
      return `${task} finished.`
    case 'failed':
      return type === 'setup_warning' ? 'The machine needs a look.' : `${task} stopped and needs a look.`
    case 'limits':
      return type === 'session_limit' ? 'A chat reached a usage limit.' : `${task} reached a usage limit.`
    default:
      return 'Something happened.'
  }
}

/** The choices as a machine keeps them: quiet hours in this device's time zone. */
export function toPushPrefs(p: NotifyPrefs, tz: string): PushPrefs {
  return { events: p.events, details: p.details, quiet: p.quiet ? { ...p.quiet, tz } : null }
}

/** What a push carries for the app (the machine sets it). */
export interface PushData {
  machine: string
  type: string
  job: number | null
  code: string | null
}

export function pushData(raw: unknown): PushData | null {
  const d = raw as Partial<PushData> | null
  if (!d || typeof d.machine !== 'string' || typeof d.type !== 'string') return null
  return { machine: d.machine, type: d.type, job: typeof d.job === 'number' ? d.job : null, code: typeof d.code === 'string' ? d.code : null }
}

/** Where tapping a notification goes: requests to Needs you, a task to its screen, else its machine. */
export function pushRoute(d: PushData): string {
  if (noticeGroup(d.type) === 'requests') return '/inbox'
  if (d.job !== null) return `/machine/${d.machine}/task/${d.job}`
  return `/machine/${d.machine}`
}

/** A notification's button as an answer to the machine: Allow and Deny on a permission, Approve on a plan. */
export function pushAnswer(action: string, d: PushData): Extract<RequestBody, { type: 'answer' }> | null {
  if (!d.code) return null
  if (d.type === 'permission' && (action === 'allow' || action === 'deny')) return { type: 'answer', code: d.code, decision: action }
  if (d.type === 'plan_review' && action === 'approve') return { type: 'answer', code: d.code, decision: 'allow' }
  return null
}
