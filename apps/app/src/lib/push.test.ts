import { describe, expect, test } from 'bun:test'
import { DEFAULT_NOTIFY, genericText, noticeGroup, pushAnswer, pushData, pushRoute, quietAt, toPushPrefs, wantsNotice } from './push'

describe('what you hear about', () => {
  test('notices by group, quiet hours across midnight', () => {
    expect(['permission', 'done', 'held', 'limit', 'started'].map(noticeGroup)).toEqual(['requests', 'done', 'failed', 'limits', null])
    const night = { start: 22 * 60, end: 7 * 60 }
    expect([23 * 60, 3 * 60, 7 * 60, 12 * 60].map(m => quietAt(night, m))).toEqual([true, true, false, false])
    expect(quietAt({ start: 9 * 60, end: 17 * 60 }, 12 * 60)).toBe(true)
    expect(quietAt(null, 0)).toBe(false)
    const prefs = { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, done: false }, quiet: night }
    expect(wantsNotice(prefs, 'permission', new Date(2026, 9, 16, 12, 0))).toBe(true)
    expect(wantsNotice(prefs, 'permission', new Date(2026, 9, 16, 23, 30))).toBe(false)
    expect(wantsNotice(prefs, 'done', new Date(2026, 9, 16, 12, 0))).toBe(false)
    expect(wantsNotice(prefs, 'started', new Date(2026, 9, 16, 12, 0))).toBe(false)
  })

  test('without details, only what happened', () => {
    expect(genericText('permission', 14)).toBe('#14 needs you.')
    expect(genericText('failed', 3)).toBe('#3 stopped and needs a look.')
    expect(genericText('session_limit', null)).toBe('A chat reached a usage limit.')
    expect(genericText('setup_warning', null)).toBe('The machine needs a look.')
  })

  test('as a machine keeps them: quiet hours in this device’s zone', () => {
    expect(toPushPrefs({ ...DEFAULT_NOTIFY, quiet: { start: 1320, end: 420 } }, 'Asia/Kathmandu')).toEqual({ events: DEFAULT_NOTIFY.events, details: true, quiet: { start: 1320, end: 420, tz: 'Asia/Kathmandu' } })
  })
})

describe('a notification', () => {
  const permission = pushData({ machine: 'm1', type: 'permission', job: 14, code: 'k3x9' })!

  test('opens where it’s about', () => {
    expect(pushRoute(permission)).toBe('/inbox')
    expect(pushRoute({ machine: 'm1', type: 'done', job: 14, code: null })).toBe('/machine/m1/task/14')
    expect(pushRoute({ machine: 'm1', type: 'session_limit', job: null, code: null })).toBe('/machine/m1')
    expect(pushData({ type: 'done' })).toBeNull()
  })

  test('its buttons answer: Allow, Deny, Approve; nothing else answers', () => {
    expect(pushAnswer('allow', permission)).toEqual({ type: 'answer', code: 'k3x9', decision: 'allow' })
    expect(pushAnswer('deny', permission)).toEqual({ type: 'answer', code: 'k3x9', decision: 'deny' })
    expect(pushAnswer('approve', { machine: 'm1', type: 'plan_review', job: 14, code: 'p1' })).toEqual({ type: 'answer', code: 'p1', decision: 'allow' })
    expect(pushAnswer('approve', permission)).toBeNull()
    expect(pushAnswer('expo.modules.notifications.actions.DEFAULT', permission)).toBeNull()
    expect(pushAnswer('allow', { ...permission, code: null })).toBeNull()
  })
})
