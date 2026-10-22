// `cq app setup | status | off`: the Afterhours app inside Telegram. This machine runs the relay
// itself (remote.serve) and serves the app's web build from it; Tailscale Funnel gives both a public
// https address, which Telegram needs. The bot then opens the app from its menu button.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RemoteStatus } from '../daemon/remote'
import { BRAND } from '../shared/brand'
import { findExecutable, isOwnRelay, loadConfig, paths, readToken, saveConfig, type Config } from '../shared/config'
import { daemonUrl } from './util'

/** The port of 127.0.0.1 the relay listens on (next to the engine's own). */
export const DEFAULT_APP_PORT = 7788

export interface TailscaleInfo {
  running: boolean
  /** This machine's name in the tailnet, e.g. mac.tail1234.ts.net. */
  dnsName: string | null
  /** Whether the tailnet allows HTTPS certificates and Funnel for this machine (when it says). */
  https: boolean
  funnel: boolean
}

/** Reads `tailscale status --json`. */
export function tailscaleInfo(json: string): TailscaleInfo {
  let status: { BackendState?: string; Self?: { DNSName?: string; CapMap?: Record<string, unknown>; Capabilities?: string[] } }
  try {
    status = JSON.parse(json)
  } catch {
    return { running: false, dnsName: null, https: false, funnel: false }
  }
  const caps = [...Object.keys(status.Self?.CapMap ?? {}), ...(status.Self?.Capabilities ?? [])]
  const dns = (status.Self?.DNSName ?? '').replace(/\.$/, '')
  return {
    running: status.BackendState === 'Running',
    dnsName: dns || null,
    https: caps.some(c => c === 'https' || c.endsWith('/cap/https')),
    funnel: caps.some(c => c === 'funnel' || c.includes('/cap/funnel')),
  }
}

/** What `cq app setup` changes in config.json: the relay runs here, and apps reach it at `publicUrl`. */
export function appConfig(config: Config, o: { dnsName: string; port: number }): Config {
  return {
    ...config,
    remote: {
      ...config.remote,
      enabled: true,
      serve: { port: o.port },
      publicUrl: `https://${o.dnsName}`,
      relay: `wss://${o.dnsName}/v1`,
    },
  }
}

/**
 * The app's own folder, to build and copy its web build from: AFTERHOURS_APP_DIR, else (when cq
 * runs from source) the apps' repository next to this one (../afterhours-app/app).
 */
export function appSource(env: Record<string, string | undefined> = process.env, here = import.meta.dir): string | null {
  for (const dir of [env.AFTERHOURS_APP_DIR, resolve(here, '../../../afterhours-app/app')]) {
    if (dir && existsSync(join(dir, 'app.json'))) return resolve(dir)
  }
  return null
}

/** Copies the app's web build to where the relay serves it. */
export function installWeb(from: string, to = paths.web): void {
  if (!existsSync(join(from, 'index.html'))) throw new Error(`${from} has no index.html: it isn't the app's web build.`)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true, mode: 0o700 })
  cpSync(from, to, { recursive: true })
}

function tailscalePath(): string | null {
  return findExecutable('tailscale') ?? (existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : null)
}

/** Runs a command, giving up after `ms`; its output either way. */
async function runFor(argv: string[], ms: number, cwd?: string): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, ms)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  clearTimeout(timer)
  return { ok: code === 0 && !timedOut, out: `${out}${err}`.trim(), timedOut }
}

async function remoteStatus(): Promise<RemoteStatus | null> {
  try {
    const res = await fetch(daemonUrl('/api/remote'), { headers: { 'x-cq-token': readToken() ?? '' }, signal: AbortSignal.timeout(5000) })
    return res.ok ? ((await res.json()) as RemoteStatus) : null
  } catch {
    return null
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) })
    return res.ok
  } catch {
    return false
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export async function appCommand(args: string[]): Promise<boolean> {
  const [sub = 'status', ...rest] = args
  if (sub === 'setup') return setup(rest)
  if (sub === 'status') return status()
  if (sub === 'off') return off()
  console.error('cq app setup | status | off')
  return false
}

async function setup(args: string[]): Promise<boolean> {
  const port = Number(flag(args, '--port') ?? loadConfig().remote.serve?.port ?? DEFAULT_APP_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('--port is a number from 1024 to 65535.')
    return false
  }

  // 1. The app's web build, where the relay serves it.
  const webArg = flag(args, '--web')
  const source = appSource()
  const from = webArg ? resolve(webArg) : source ? join(source, 'dist-web') : null
  if (!webArg && source && !existsSync(join(source, 'dist-web', 'index.html'))) {
    console.log('Building the app for the web (npm run export:web) …')
    const built = await runFor(['npm', 'run', 'export:web'], 10 * 60_000, source)
    if (!built.ok) {
      console.error(`Couldn't build it:\n${built.out.split('\n').slice(-15).join('\n')}\nIn ${source}: npm install, then npm run export:web, then cq app setup again.`)
      return false
    }
  }
  if (from && existsSync(join(from, 'index.html'))) {
    installWeb(from)
    console.log(`✓ The app: copied from ${from}`)
  } else if (existsSync(join(paths.web, 'index.html'))) {
    console.log(`✓ The app: ${paths.web}`)
  } else {
    console.error(`The app's web build isn't here. Build it in the apps' repository (in app/: npm run export:web), then run: cq app setup --web <that app/dist-web>`)
    return false
  }

  // 2. Tailscale: running, and this machine's name.
  const ts = tailscalePath()
  if (!ts) {
    console.error('Tailscale gives the app its public https address, and it isn\'t installed. Get it at https://tailscale.com/download, sign in, then run cq app setup again.')
    return false
  }
  const info = tailscaleInfo((await runFor([ts, 'status', '--json'], 15_000)).out)
  if (!info.running || !info.dnsName) {
    console.error('Tailscale isn\'t connected. Open Tailscale, sign in and connect, then run cq app setup again.')
    return false
  }
  console.log(`✓ Tailscale: ${info.dnsName}`)
  if (!info.https || !info.funnel) {
    console.log(
      'Your tailnet needs HTTPS certificates and Funnel for this. If the next step stops, turn them on once:\n' +
        '  HTTPS: https://login.tailscale.com/admin/dns → HTTPS Certificates → Enable\n' +
        '  Funnel: the link Tailscale shows below (or https://tailscale.com/kb/1223/funnel)',
    )
  }

  // 3. Config: the relay runs here; apps reach it (and the app) at the public address.
  const config = loadConfig()
  const next = appConfig(config, { dnsName: info.dnsName, port })
  const oldRelay = config.remote.relay
  if (oldRelay && oldRelay !== next.remote.relay) {
    console.log(`Note: devices paired through ${oldRelay} need to pair again (cq pair, or /app in Telegram).`)
  }
  saveConfig(next)
  console.log(`✓ ${BRAND.name} runs the relay on 127.0.0.1:${port} and serves the app from it`)

  // 4. Funnel: the public https address, to that port only.
  // In the terminal itself: Tailscale prints its link to allow Funnel only to a terminal, and waits.
  console.log('Opening it to the internet with Tailscale Funnel. If Tailscale shows a link, open it; this goes on once you allow it …')
  const funnel = Bun.spawn([ts, 'funnel', '--bg', '--yes', String(port)], { stdio: ['inherit', 'inherit', 'inherit'] })
  const timer = setTimeout(() => funnel.kill(), 10 * 60_000)
  const code = await funnel.exited
  clearTimeout(timer)
  if (code !== 0) {
    console.error('Tailscale Funnel didn\'t start. Do what Tailscale asks above, then run cq app setup again.')
    return false
  }
  console.log(`✓ Funnel: https://${info.dnsName} → 127.0.0.1:${port}`)

  // 5. The engine picks the change up; then check it from outside.
  let s: RemoteStatus | null = null
  for (let i = 0; i < 15; i++) {
    s = await remoteStatus()
    if (s?.serving && s.serving.port === port && (s.connected || s.serving.error)) break
    await Bun.sleep(1000)
  }
  if (!s) {
    console.log(`${BRAND.name} isn't running: start it (cq install, or cq daemon). It serves the app once it runs.`)
  } else if (s.serving?.error) {
    console.error(`${BRAND.name} couldn't run the relay: ${s.serving.error}`)
    return false
  } else if (!s.connected) {
    console.log(`${BRAND.name} hasn't connected to its relay yet; check cq logs if it doesn't within a minute.`)
  }
  const url = `https://${info.dnsName}`
  let ok = false
  for (let i = 0; i < 6 && !ok; i++) {
    ok = await reachable(url)
    if (!ok) await Bun.sleep(5000)
  }
  console.log(ok ? `✓ Reachable at ${url}` : `⚠️ ${url} isn't reachable from here yet. A new Funnel address can take a few minutes; cq app status checks again.`)
  console.log(
    `\nNext, in Telegram: send /app to your bot and tap Finish setup. After that, ${BRAND.name} opens from the button next to the text box, and the bot's messages turn short, with Open ↗.`,
  )
  return true
}

async function status(): Promise<boolean> {
  const config = loadConfig()
  const r = config.remote
  if (!r.serve || !r.publicUrl) {
    console.log(`The app inside Telegram isn't set up. Run: cq app setup`)
    return true
  }
  console.log(`Address: ${r.publicUrl}\nRelay: on 127.0.0.1:${r.serve.port} (apps use ${r.relay})`)
  console.log(`App files: ${existsSync(join(paths.web, 'index.html')) ? paths.web : 'missing (run cq app setup)'}`)
  const s = await remoteStatus()
  if (!s) console.log(`${BRAND.name}: not running`)
  else console.log(`${BRAND.name}: ${s.serving?.error ? `can't run the relay: ${s.serving.error}` : s.connected ? 'connected to its relay' : 'not connected to its relay yet'} · ${s.devices} device${s.devices === 1 ? '' : 's'}`)
  console.log(`From the internet: ${(await reachable(r.publicUrl)) ? 'reachable' : 'not reachable (is Tailscale connected? tailscale funnel status)'}`)
  return true
}

async function off(): Promise<boolean> {
  const config = loadConfig()
  const port = config.remote.serve?.port
  const wasPublic = isOwnRelay(config.remote)
  config.remote.serve = null
  config.remote.publicUrl = null
  // Its public address only worked while the relay ran here.
  if (wasPublic) config.remote.relay = null
  saveConfig(config)
  console.log(`${BRAND.name} stopped running the relay and serving the app. The bot's messages are in full again.`)
  const ts = tailscalePath()
  if (ts && port) {
    const r = await runFor([ts, 'funnel', '--https=443', 'off'], 15_000)
    console.log(r.ok ? '✓ Funnel is off.' : `Turn Funnel off yourself if you like: tailscale funnel --https=443 off (${r.out.split('\n')[0] || 'it did not answer'})`)
  }
  if (wasPublic) console.log('Apps paired through it need a relay again: cq pair --relay wss://…')
  return true
}
