// `cq app setup`: what it reads from Tailscale, and what it changes in config.json.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appConfig, appSource, installWeb, tailscaleInfo } from '../src/cli/app'
import { healthUrl, relayHealth } from '../src/cli/remote'
import { DEFAULT_CONFIG, isOwnRelay } from '../src/shared/config'

test("Tailscale's status: connected or not, this machine's name, and whether HTTPS and Funnel are allowed", () => {
  const running = JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'mac.tail1234.ts.net.', CapMap: { https: null, 'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null, funnel: null } },
  })
  expect(tailscaleInfo(running)).toEqual({ running: true, dnsName: 'mac.tail1234.ts.net', https: true, funnel: true })
  const stopped = JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'mac.tail1234.ts.net.', CapMap: { 'https://tailscale.com/cap/ssh': null } } })
  expect(tailscaleInfo(stopped)).toEqual({ running: false, dnsName: 'mac.tail1234.ts.net', https: false, funnel: false })
  expect(tailscaleInfo('not json').running).toBe(false)
})

test('setup: the relay runs here on its port, and apps (and the app) use the public address', () => {
  const before = { ...DEFAULT_CONFIG, remote: { ...DEFAULT_CONFIG.remote, relay: 'ws://192.168.1.10:8787/v1', allowBypass: true } }
  const after = appConfig(before, { dnsName: 'mac.tail1234.ts.net', port: 7788 })
  expect(after.remote).toEqual({
    ...before.remote,
    enabled: true,
    serve: { port: 7788 },
    publicUrl: 'https://mac.tail1234.ts.net',
    relay: 'wss://mac.tail1234.ts.net/v1',
  })
  // The machine's own rules stay.
  expect(after.remote.allowBypass).toBe(true)
})

test("the app's web build is copied whole; something that isn't one is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-web-'))
  try {
    const from = join(dir, 'dist-web')
    mkdirSync(join(from, '_expo'), { recursive: true })
    writeFileSync(join(from, 'index.html'), 'app')
    writeFileSync(join(from, '_expo', 'entry.js'), 'js')
    const to = join(dir, 'web')
    mkdirSync(to)
    writeFileSync(join(to, 'old.js'), 'stale')
    installWeb(from, to)
    expect(readFileSync(join(to, '_expo', 'entry.js'), 'utf8')).toBe('js')
    expect(() => readFileSync(join(to, 'old.js'))).toThrow()
    expect(() => installWeb(join(dir, 'nothing'), to)).toThrow("isn't the app's web build")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the app's own folder: AFTERHOURS_APP_DIR, else the apps' repository next to the engine's", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-appsrc-'))
  try {
    const engine = join(dir, 'automate', 'src', 'cli')
    const sibling = join(dir, 'afterhours-app', 'app')
    const elsewhere = join(dir, 'elsewhere')
    for (const d of [engine, sibling, elsewhere]) mkdirSync(d, { recursive: true })
    expect(appSource({}, engine)).toBeNull()
    writeFileSync(join(sibling, 'app.json'), '{}')
    expect(appSource({}, engine)).toBe(sibling)
    writeFileSync(join(elsewhere, 'app.json'), '{}')
    expect(appSource({ AFTERHOURS_APP_DIR: elsewhere }, engine)).toBe(elsewhere)
    // Set but not an app: the one next door still counts.
    expect(appSource({ AFTERHOURS_APP_DIR: join(dir, 'nothing') }, engine)).toBe(sibling)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the relay is this machine's own only at its public address", () => {
  const own = { relay: 'wss://mac.tail1234.ts.net/v1', publicUrl: 'https://mac.tail1234.ts.net' }
  expect(isOwnRelay(own)).toBe(true)
  expect(isOwnRelay({ ...own, publicUrl: 'https://mac.tail1234.ts.net/' })).toBe(true)
  // A hosted relay, or one whose name only starts the same, is another relay.
  expect(isOwnRelay({ ...own, relay: 'wss://afterhours-relay.onrender.com/v1' })).toBe(false)
  expect(isOwnRelay({ ...own, relay: 'wss://mac.tail1234.ts.net.example.com/v1' })).toBe(false)
  expect(isOwnRelay({ ...own, publicUrl: null })).toBe(false)
  expect(isOwnRelay({ relay: 'not a url', publicUrl: own.publicUrl })).toBe(false)
})

test("a relay's health: its /health address, an answer, and waiting while a free host wakes", async () => {
  expect(healthUrl('wss://relay.example.com/v1')).toBe('https://relay.example.com/health')
  expect(healthUrl('ws://192.168.1.10:8787/v1?x=1')).toBe('http://192.168.1.10:8787/health')
  const answer = (res: Response) => (async () => res) as unknown as typeof fetch
  expect(await relayHealth('wss://r.example/v1', { fetch: answer(Response.json({ ok: true, protocol: 1 })) })).toMatchObject({ ok: true })
  expect(await relayHealth('wss://r.example/v1', { fetch: answer(new Response('hello')) })).toEqual({ ok: false, error: 'it answered 200, not as a relay' })
  expect(await relayHealth('wss://r.example/v1', { fetch: answer(new Response('no', { status: 404 })) })).toEqual({ ok: false, error: 'it answered 404, not as a relay' })
  // Asleep at first: it waits, says so once, and takes the answer when it comes.
  let calls = 0
  let waits = 0
  const waking = (async () => {
    if (++calls < 2) throw new Error('connection refused')
    return Response.json({ ok: true })
  }) as unknown as typeof fetch
  expect(await relayHealth('wss://r.example/v1', { fetch: waking, waitMs: 10_000, onWait: () => waits++, sleep: async () => {} })).toMatchObject({ ok: true })
  expect([calls, waits]).toEqual([2, 1])
})
