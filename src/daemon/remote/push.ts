// Push notifications for paired phones, through Expo's push service (which hands them to Apple and
// Google). Pushes leave the end-to-end encryption, so each device chooses what's in them: the
// request itself, or only that a task needs you. Each device also picks which notices, and quiet
// hours in its own time zone. A device removed from the machine gets nothing more.

import type { PushPrefs } from '@afterhours/protocol'
import type { Notice } from '../notify'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'

export type PushGroup = keyof PushPrefs['events']

/** Which switch a notice falls under; null: never pushed. */
export function pushGroup(type: Notice['type']): PushGroup | null {
  switch (type) {
    case 'permission':
    case 'question':
    case 'plan_review':
    case 'trust':
      return 'requests'
    case 'done':
    case 'link':
      return 'done'
    case 'failed':
    case 'held':
    case 'conflict':
    case 'setup_warning':
      return 'failed'
    case 'limit':
    case 'session_limit':
      return 'limits'
    default:
      return null
  }
}

/** Minutes after midnight at `at` in time zone `tz` (the machine's own zone if `tz` is unknown). */
export function localMinutes(at: number, tz: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  } catch {
    const d = new Date(at)
    return d.getHours() * 60 + d.getMinutes()
  }
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0)
  return (get('hour') % 24) * 60 + get('minute')
}

/** Whether `at` falls in the device's quiet hours (which may run past midnight). */
export function inQuietHours(prefs: PushPrefs, at: number): boolean {
  const q = prefs.quiet
  if (!q || q.start === q.end) return false
  const m = localMinutes(at, q.tz)
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end
}

/** The notice's text without the emoji the bot starts it with, on one line, short enough for a lock screen. */
function plain(text: string): string {
  const t = text.replace(/^[\p{Extended_Pictographic}️‍]+\s*/u, '').replace(/\s+/g, ' ').trim()
  return t.length > 178 ? `${t.slice(0, 177).trimEnd()}…` : t
}

function jobOf(notice: Notice): number | null {
  return 'job' in notice && notice.job && typeof notice.job === 'object' && 'id' in notice.job ? notice.job.id : null
}

/** Without details: only what happened, never what the task or the request says. */
function generic(notice: Notice): string {
  const job = jobOf(notice)
  const task = job !== null ? `#${job}` : 'A task'
  switch (pushGroup(notice.type)) {
    case 'requests':
      return `${task} needs you.`
    case 'done':
      return notice.type === 'link' ? `A live link for ${task} is ready.` : `${task} finished.`
    case 'failed':
      return notice.type === 'setup_warning' ? 'The machine needs a look.' : `${task} stopped and needs a look.`
    case 'limits':
      return notice.type === 'session_limit' ? 'A chat reached a usage limit.' : `${task} reached a usage limit.`
    default:
      return 'Something happened.'
  }
}

export interface PushMessage {
  to: string
  title: string
  body: string
  /** What the app needs to open the right screen, or to answer from the notification. */
  data: { machine: string; type: string; job: number | null; code: string | null }
  sound: 'default'
  priority: 'high' | 'normal'
  /** Seconds Expo and Apple or Google keep trying to deliver it. */
  ttl: number
  /** Android: the app's channel. */
  channelId: 'requests' | 'updates'
  /** The notification's buttons: Allow and Deny on a permission, Approve on a plan. */
  categoryId?: 'permission' | 'plan'
}

export function pushMessage(o: { token: string; prefs: PushPrefs; machine: { id: string; name: string }; notice: Notice; text: string; now: number }): PushMessage {
  const { notice } = o
  const requests = pushGroup(notice.type) === 'requests'
  const code = 'code' in notice && typeof notice.code === 'string' ? notice.code : null
  const minutes = 'minutes' in notice && typeof notice.minutes === 'number' ? notice.minutes : 15
  return {
    to: o.token,
    title: o.machine.name,
    body: o.prefs.details ? plain(o.text) : generic(notice),
    data: { machine: o.machine.id, type: notice.type, job: jobOf(notice), code },
    sound: 'default',
    priority: requests ? 'high' : 'normal',
    // A request is settled for you after its minutes; news is old after a day.
    ttl: requests ? Math.max(60, minutes * 60) : 86_400,
    channelId: requests ? 'requests' : 'updates',
    ...(notice.type === 'permission' ? { categoryId: 'permission' as const } : notice.type === 'plan_review' ? { categoryId: 'plan' as const } : {}),
  }
}

export interface PushTarget {
  device: string
  token: string
  prefs: PushPrefs
}

/** Which devices get a notice, and what each one gets. */
export function pushesFor(targets: PushTarget[], o: { machine: { id: string; name: string }; notice: Notice; text: string; now: number }): PushMessage[] {
  const group = pushGroup(o.notice.type)
  if (!group) return []
  return targets.filter(t => t.prefs.events[group] && !inQuietHours(t.prefs, o.now)).map(t => pushMessage({ ...o, token: t.token, prefs: t.prefs }))
}

interface Ticket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

export interface PushSenderDeps {
  url?: string
  receiptsUrl?: string
  fetch?: typeof fetch
  /** A token Expo says is no longer valid (the app was removed): forget it. */
  gone: (token: string) => void
  log: (line: string) => void
  now: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Expo takes at most 100 messages a request. */
const BATCH = 100
/** Receipts are ready some minutes after sending; Expo keeps them a day. */
const RECEIPT_AFTER = 15 * 60_000

/**
 * Sends pushes to Expo: retries when Expo is busy or down (three tries, backing off), forgets
 * tokens Expo rejects, and later checks the receipts for tokens Apple or Google rejected.
 */
export class PushSender {
  /** Sent, waiting for their receipts: ticket id → token, when. */
  private tickets = new Map<string, { token: string; at: number }>()

  constructor(private readonly d: PushSenderDeps) {}

  private get fetch(): typeof fetch {
    return this.d.fetch ?? fetch
  }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? (t => new Promise(r => setTimeout(r, t))))(ms)
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    let wait = 1000
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null
      try {
        res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      } catch (err) {
        if (attempt >= 3) throw err
      }
      if (res?.ok) return res.json()
      // Busy (429) or down (5xx): try again. Anything else won't get better.
      if (res && res.status !== 429 && res.status < 500) throw new Error(`Expo said ${res.status}: ${(await res.text()).slice(0, 200)}`)
      if (attempt >= 3) throw new Error(`Expo said ${res?.status ?? 'nothing'} three times`)
      await this.sleep(wait)
      wait *= 4
    }
  }

  async send(messages: PushMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH)
      let tickets: Ticket[]
      try {
        tickets = ((await this.post(this.d.url ?? EXPO_PUSH_URL, batch)) as { data?: Ticket[] }).data ?? []
      } catch (err) {
        this.d.log(`push: not sent (${err instanceof Error ? err.message : err})`)
        continue
      }
      tickets.forEach((t, j) => {
        const token = batch[j]?.to
        if (!token) return
        if (t.status === 'ok' && t.id) this.tickets.set(t.id, { token, at: this.d.now() })
        else if (t.details?.error === 'DeviceNotRegistered') this.d.gone(token)
        else if (t.status === 'error') this.d.log(`push: refused (${t.details?.error ?? t.message ?? 'no reason'})`)
      })
    }
  }

  /** Call now and then: asks for the receipts of pushes sent a while ago. */
  async checkReceipts(): Promise<void> {
    const now = this.d.now()
    const ready = [...this.tickets.entries()].filter(([, t]) => now - t.at >= RECEIPT_AFTER).slice(0, 1000)
    if (ready.length === 0) return
    for (const [id] of ready) this.tickets.delete(id)
    let receipts: Record<string, Ticket>
    try {
      receipts = ((await this.post(this.d.receiptsUrl ?? EXPO_RECEIPTS_URL, { ids: ready.map(([id]) => id) })) as { data?: Record<string, Ticket> }).data ?? {}
    } catch (err) {
      this.d.log(`push: receipts not checked (${err instanceof Error ? err.message : err})`)
      return
    }
    for (const [id, t] of ready) {
      const r = receipts[id]
      if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') this.d.gone(t.token)
      else if (r?.status === 'error') this.d.log(`push: not delivered (${r.details?.error ?? r.message ?? 'no reason'})`)
    }
  }

  /** Pushes still waiting for their receipts (tests). */
  get waiting(): number {
    return this.tickets.size
  }
}
