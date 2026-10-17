// `cq app setup`: what it reads from Tailscale, and what it changes in config.json.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appConfig, installWeb, tailscaleInfo } from '../src/cli/app'
import { DEFAULT_CONFIG } from '../src/shared/config'

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
