// What apps hear: every notice, stored with a sequence number so an app that was offline catches
// up; queue changes as they happen; and approvals answered anywhere else.

import type { Host, HostSession, Notice as WireNotice, Snapshot, State } from '@afterhours/protocol'
import type { Notice } from '../notify'
import type { Runner } from '../runner'
import type { Store } from '../store'
import type { RemoteDb } from './db'
import { jobInfo, limitsInfo, wireNotice } from './wire'

/** At most this many missed events are replayed (the newest); the snapshot that follows covers the rest. */
const REPLAY_LIMIT = 200

export interface FeedDeps {
  db: RemoteDb
  store: Store
  runner: Runner
  host: () => Host | null
  /** Who answered an approval from an app, by approval code. */
  resolvedBy: Map<string, string>
  now: () => number
}

export class Feed {
  private stateKey = ''
  private pending: Map<string, number> | null = null

  constructor(private readonly d: FeedDeps) {}

  /** The notifier sink. */
  record(text: string, notice: Notice): void {
    this.publish(wireNotice(notice), text)
  }

  /** The machine is moving to another relay: apps save its address and follow. */
  relayMoved(url: string): void {
    this.publish({ type: 'relay', url }, `This machine now uses the relay at ${url}.`)
  }

  /** Sends a session what it missed after `since`, then the snapshot. */
  catchUp(session: HostSession, since: number, snapshot: Snapshot): void {
    for (const e of this.d.db.eventsAfter(since, REPLAY_LIMIT)) {
      session.send({ type: 'event', seq: e.seq, at: e.at, notice: JSON.parse(e.notice) as WireNotice, text: e.text })
    }
    session.send(snapshot)
  }

  state(): State {
    const active = this.d.store.active()
    return {
      type: 'state',
      paused: this.d.runner.paused,
      active: active ? jobInfo(active, { brief: true }) : null,
      queued: this.d.store.queued().map(j => jobInfo(j, { brief: true })),
      limits: limitsInfo(this.d.runner.limits()),
    }
  }

  /** Call every few seconds. */
  tick(): void {
    const state = this.state()
    // The status line refreshes `updatedAt` constantly; only real changes are news.
    const key = JSON.stringify({ ...state, limits: { ...state.limits, updatedAt: undefined } })
    if (key !== this.stateKey) {
      const first = this.stateKey === ''
      this.stateKey = key
      if (!first) this.d.host()?.broadcast(state)
    }

    const pendingNow = new Map(this.d.store.pendingApprovals().map(a => [a.code, a.jobId]))
    for (const [code, job] of this.pending ?? []) {
      if (pendingNow.has(code)) continue
      const a = this.d.store.getApproval(code)
      const status = a?.status === 'allowed' || a?.status === 'denied' || a?.status === 'answered' ? a.status : 'expired'
      const by = this.d.resolvedBy.get(code) ?? null
      this.d.resolvedBy.delete(code)
      const verb = { allowed: 'allowed', denied: 'declined', answered: 'answered', expired: 'expired' }[status]
      this.publish({ type: 'resolved', code, job, status, by }, `#${job}'s request ${code} was ${verb}${by ? ` from ${by}` : ''}.`)
    }
    this.pending = pendingNow
  }

  private publish(notice: WireNotice, text: string): void {
    const at = this.d.now()
    const seq = this.d.db.addEvent(at, JSON.stringify(notice), text)
    this.d.host()?.broadcast({ type: 'event', seq, at, notice, text })
  }
}
