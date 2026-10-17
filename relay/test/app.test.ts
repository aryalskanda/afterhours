// The relay serving the app's web build next to /v1: for a machine that runs its own relay, so the
// app opens inside Telegram from the same address.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRelay, type Relay } from '../src/server'

let relay: Relay | null = null
let dir = ''

afterEach(async () => {
  await relay?.stop()
  relay = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function serve() {
  dir = mkdtempSync(join(tmpdir(), 'relay-app-'))
  const app = join(dir, 'web')
  mkdirSync(join(app, '_expo', 'static', 'js', 'web'), { recursive: true })
  writeFileSync(join(app, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(join(app, '_expo', 'static', 'js', 'web', 'entry-abc123.js'), 'console.log(1)')
  writeFileSync(join(app, 'favicon.ico'), 'icon')
  writeFileSync(join(dir, 'secret.txt'), 'outside the app')
  relay = startRelay({ port: 0, hostname: '127.0.0.1', appDir: app })
  return `http://127.0.0.1:${relay.port}`
}

test('every screen is the app; files are files, cached when their name has their hash', async () => {
  const base = serve()
  const screen = await fetch(`${base}/pair?r=wss%3A%2F%2Fmac%2Fv1&s=secret`)
  expect(screen.status).toBe(200)
  expect(await screen.text()).toContain('id="root"')
  expect(screen.headers.get('cache-control')).toBe('no-cache')
  expect(screen.headers.get('referrer-policy')).toBe('no-referrer')
  const csp = screen.headers.get('content-security-policy')!
  expect(csp).toContain("script-src 'self' https://telegram.org")
  expect(csp).toContain('frame-ancestors')
  expect(csp).not.toContain('unsafe-eval')

  const bundle = await fetch(`${base}/_expo/static/js/web/entry-abc123.js`)
  expect(await bundle.text()).toBe('console.log(1)')
  expect(bundle.headers.get('cache-control')).toContain('immutable')
  expect((await fetch(`${base}/favicon.ico`)).headers.get('cache-control')).toBe('no-cache')
  expect((await fetch(`${base}/missing.js`)).status).toBe(404)
  expect((await fetch(`${base}/machine/abc/task/14`)).status).toBe(200)
})

test("nothing outside the app's folder; only reading", async () => {
  const base = serve()
  for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/_expo/..%2f..%2fsecret.txt']) {
    const res = await fetch(`${base}${path}`)
    expect(await res.text()).not.toContain('outside the app')
  }
  expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
})

test('the relay itself is unchanged: /health answers and /v1 takes apps and machines', async () => {
  const base = serve()
  expect(((await (await fetch(`${base}/health`)).json()) as { ok: boolean }).ok).toBe(true)
  const ws = new WebSocket(relay!.url)
  const first = await new Promise<string>((resolve, reject) => {
    ws.onmessage = e => resolve(String(e.data))
    ws.onerror = () => reject(new Error('no connection'))
  })
  ws.close()
  expect(JSON.parse(first).t).toBe('challenge')
})
