import { describe, expect, test } from 'bun:test'
import type { Event } from '@afterhours/protocol'
import { job } from '../../e2e/fake-machine'
import { applyEvent, findJob, machineState, needsYou, timeline } from './state'

const base = () => machineState({ id: 'm1', name: 'box', relay: 'ws://x/v1', role: 'owner', lastSeq: 0, addedAt: 0 })
const event = (seq: number, notice: Event['notice']): Event => ({ type: 'event', seq, at: 1000 * seq, notice, text: notice.type })

describe('machine state', () => {
  test('events are kept once each, in order, and move lastSeq on', () => {
    let m = base()
    m = applyEvent(m, event(2, { type: 'empty' }))
    m = applyEvent(m, event(1, { type: 'empty' }))
    m = applyEvent(m, event(2, { type: 'empty' }))
    expect(m.events.map(e => e.seq)).toEqual([1, 2])
    expect(m.lastSeq).toBe(2)
  })

  test('a request appears with its event and goes when resolved', () => {
    let m = base()
    const j = job(14, { status: 'running' })
    m = applyEvent(m, event(1, { type: 'permission', job: j, code: 'abcde', tool: 'Bash', detail: 'npm test', minutes: 15 }))
    expect(m.approvals).toEqual([expect.objectContaining({ code: 'abcde', kind: 'permission', tool: 'Bash', detail: 'npm test', expiresAt: 1000 + 15 * 60_000 })])
    m = applyEvent(m, event(2, { type: 'resolved', code: 'abcde', job: 14, status: 'allowed', by: 'Phone' }))
    expect(m.approvals).toEqual([])
  })

  test('started and done move tasks; their events make a timeline', () => {
    let m = base()
    m = applyEvent(m, event(1, { type: 'started', job: job(14, { status: 'running' }) }))
    expect(m.active?.id).toBe(14)
    m = applyEvent(m, event(2, { type: 'done', job: job(14, { status: 'done' }), diff: null, next: null }))
    expect(m.active).toBeNull()
    expect(m.recent.map(j => j.id)).toEqual([14])
    expect(timeline(m, 14).map(e => e.notice.type)).toEqual(['started', 'done'])
    expect(findJob(m, 14)?.status).toBe('done')
  })

  test('what needs you: whatever is settled for you soonest first', () => {
    const a = { ...base(), id: 'a', approvals: [{ code: 'late', job: 1, kind: 'permission' as const, payload: null, createdAt: 1, expiresAt: 900 }] }
    const b = { ...base(), id: 'b', approvals: [{ code: 'soon', job: 2, kind: 'question' as const, payload: null, createdAt: 2, expiresAt: 100 }, { code: 'none', job: 3, kind: 'review' as const, payload: null, createdAt: 0 }] }
    expect(needsYou([a, b]).map(n => n.approval.code)).toEqual(['soon', 'late', 'none'])
  })
})
