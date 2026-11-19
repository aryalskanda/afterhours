import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountSwitched, claudeAccount } from '../src/daemon/claude-info'

const NOW = Date.UTC(2026, 10, 19, 7, 0)

/** A ~/.claude.json signed in to `account` (or signed out), its profile fetched at `fetched`. */
function claudeJson(account: string | null, fetched = NOW - 3_600_000): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cq-acct-')), '.claude.json')
  writeFileSync(path, JSON.stringify(account ? { oauthAccount: { accountUuid: account, emailAddress: 'someone@example.com', profileFetchedAt: fetched } } : {}))
  return path
}

function kv(start: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(start))
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v), m }
}

test('the account is a stable id, never the email; none when signed out', () => {
  expect(claudeAccount(claudeJson('acct-1'))).toBe('acct-1')
  expect(claudeAccount(claudeJson(null))).toBeNull()
  expect(claudeAccount('/definitely/not/here.json')).toBeNull()
})

test('signing in to another account is a switch; the same one, or signing out, is not', () => {
  const store = kv({ 'claude.account': 'acct-1' })
  expect(accountSwitched({ claudeJson: claudeJson('acct-1'), kv: store, now: NOW })).toBe(false)
  expect(accountSwitched({ claudeJson: claudeJson(null), kv: store, now: NOW })).toBe(false)
  expect(accountSwitched({ claudeJson: claudeJson('acct-2'), kv: store, now: NOW })).toBe(true)
  expect(store.m.get('claude.account')).toBe('acct-2')
  expect(accountSwitched({ claudeJson: claudeJson('acct-2'), kv: store, now: NOW })).toBe(false)
})

test('the first look: a limit block read before this account signed in came from the old one', () => {
  // Read yesterday, signed in an hour ago: stale.
  const stale = kv({ limits: { blockedUntil: NOW + 13 * 3_600_000, updatedAt: NOW - 24 * 3_600_000 } })
  expect(accountSwitched({ claudeJson: claudeJson('acct-2'), kv: stale, now: NOW })).toBe(true)
  // Read after signing in: this account's own.
  const own = kv({ limits: { blockedUntil: NOW + 3_600_000, updatedAt: NOW - 60_000 } })
  expect(accountSwitched({ claudeJson: claudeJson('acct-2'), kv: own, now: NOW })).toBe(false)
  // No block at all: nothing to clear.
  expect(accountSwitched({ claudeJson: claudeJson('acct-2'), kv: kv(), now: NOW })).toBe(false)
})
