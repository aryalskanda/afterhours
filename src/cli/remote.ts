// `cq pair`, `cq devices`, `cq remote` and `cq audit`: remote access from the Afterhours apps.

import { fingerprint, type OfferView } from '@afterhours/protocol'
import { resolve } from 'node:path'
import { renderUnicodeCompact } from 'uqr'
import type { RemoteStatus } from '../daemon/remote'
import { BRAND } from '../shared/brand'
import { expandHome, loadConfig, readToken, saveConfig } from '../shared/config'
import { daemonUrl } from './util'

type Role = 'owner' | 'operator' | 'viewer'

async function api<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(daemonUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': readToken() ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T }
}

async function status(): Promise<RemoteStatus | null> {
  try {
    const r = await api<RemoteStatus>('/api/remote')
    return r.ok ? r.data : null
  } catch {
    return null
  }
}

const NOT_RUNNING = `${BRAND.name} isn't running. Start it (cq install, or cq daemon in another terminal), then try again.`

/** A relay's /health address, from its wss://…/v1 address. */
export function healthUrl(relay: string): string {
  const url = new URL(relay)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/health'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Asks a relay whether it's up, and how long that took. A relay on a free plan may be asleep and
 * take a minute to wake, so this asks again until `waitMs` is up (`onWait` says it's waiting).
 */
export async function relayHealth(
  relay: string,
  o: { waitMs?: number; onWait?: () => void; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const get = o.fetch ?? fetch
  const pause = o.sleep ?? Bun.sleep
  const end = Date.now() + (o.waitMs ?? 5000)
  let error = 'no answer'
  let told = false
  for (;;) {
    const started = Date.now()
    try {
      const res = await get(healthUrl(relay), { signal: AbortSignal.timeout(Math.max(1000, Math.min(15_000, end - started))) })
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
      if (res.ok && body?.ok === true) return { ok: true, ms: Date.now() - started }
      error = `it answered ${res.status}${body ? '' : ', not as a relay'}`
      // A host waking up answers with a server error, or not at all; any other answer is final.
      if (res.status < 500 && res.status !== 429) return { ok: false, error }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() + 2000 > end) return { ok: false, error }
    if (!told) {
      told = true
      o.onWait?.()
    }
    await pause(2000)
  }
}

/** wss://host → wss://host/v1; anything that isn't ws:// or wss:// is refused. */
export function relayAddress(text: string): string | null {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1'
  return url.toString()
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** White on black whatever the terminal's colours, so phones read it on light themes too. */
function qr(text: string): string {
  const art = renderUnicodeCompact(text, { ecc: 'L', border: 2 })
  if (!process.stdout.isTTY) return art
  return art
    .split('\n')
    .map(line => `  \x1b[97;40m${line}\x1b[0m`)
    .join('\n')
}

/** `cq pair [--relay wss://…] [--role owner|operator|viewer] [--name <this machine>] [--yes]` */
export async function pairCommand(args: string[]): Promise<boolean> {
  const config = loadConfig()
  const relayArg = flag(args, '--relay')
  const role = (flag(args, '--role') ?? 'owner') as Role
  const yes = args.includes('--yes') || args.includes('-y')
  if (!['owner', 'operator', 'viewer'].includes(role)) {
    console.error('--role is owner (everything), operator (tasks and answers) or viewer (read-only).')
    return false
  }
  let changed = false
  if (relayArg) {
    const relay = relayAddress(relayArg)
    if (!relay) {
      console.error(`"${relayArg}" isn't a relay address. It looks like wss://relay.example.com`)
      return false
    }
    if (relay !== config.remote.relay) {
      config.remote.relay = relay
      changed = true
    }
  }
  if (!config.remote.relay) {
    console.error('Which relay? Run: cq pair --relay wss://<your relay>\n(The relay is open source: relay/ in this repository, or its Docker image.)')
    return false
  }
  const name = flag(args, '--name')
  if (name && name !== config.remote.name) {
    config.remote.name = name
    changed = true
  }
  if (!config.remote.enabled) {
    config.remote.enabled = true
    changed = true
  }
  if (changed) saveConfig(config)

  // The daemon picks up config.json within a few seconds.
  let s = await status()
  if (!s) {
    console.error(NOT_RUNNING)
    return false
  }
  for (let i = 0; i < 15; i++) {
    if (s?.error || (s?.machine && s.relay === config.remote.relay && (s.connected || i >= 8))) break
    await Bun.sleep(1000)
    s = await status()
  }
  if (!s?.machine) {
    console.error(`${BRAND.name} didn't start remote access. Check cq logs.`)
    return false
  }
  if (s.error) {
    console.error(`Remote access can't start: ${s.error}`)
    return false
  }
  if (!s.connected) console.log(`⚠️  Can't reach the relay at ${s.relay} yet. The code below works as soon as it connects.\n`)

  const opened = await api<OfferView & { error?: string }>('/api/remote/pair', { role, yes })
  if (!opened.ok) {
    console.error(opened.data.error ?? `Couldn't start pairing (HTTP ${opened.status}).`)
    return false
  }
  const offer = opened.data
  const minutes = Math.round((offer.expires - Date.now()) / 60_000)
  console.log(`Pair a device with ${s.machine!.name} (key ${s.machine!.fingerprint})\n`)
  console.log(qr(offer.link))
  console.log(`\nScan it with the ${BRAND.name} app, or paste this link into it:\n\n${offer.link}\n`)
  console.log(`It works once, for ${minutes} minutes, and makes the device ${role === 'operator' ? 'an' : 'a'} ${role} here. Waiting… (Ctrl-C to stop)`)

  for (;;) {
    await Bun.sleep(1000)
    let view: OfferView
    try {
      const r = await api<OfferView>(`/api/remote/pair/${offer.offer}`)
      if (!r.ok) {
        console.error(`${BRAND.name} restarted, so this code no longer works. Run cq pair again.`)
        return false
      }
      view = r.data
    } catch {
      console.error(NOT_RUNNING)
      return false
    }
    if (view.status === 'confirm' && view.device) {
      const who = `“${view.device.name}” (${view.device.platform}, key ${fingerprint(view.device.id)})`
      if (!yes) {
        const answer = prompt(`\n${who} wants to control this machine as ${role}. Allow? (y/N)`)
        const approve = /^y(es)?$/i.test((answer ?? '').trim())
        if (answer === null) console.log('(No terminal to answer in: run cq pair --yes to pair without asking.)')
        await api(`/api/remote/pair/${offer.offer}`, { approve })
      }
      continue
    }
    if (view.status === 'paired') {
      console.log(`✅ Paired with “${view.device?.name}”. It can reach this machine as ${role}.`)
      return true
    }
    if (view.status === 'denied') {
      console.log('Not paired.')
      return false
    }
    if (view.status === 'expired') {
      console.log('The code expired. Run cq pair again.')
      return false
    }
  }
}

interface DeviceView {
  id: string
  name: string
  platform: string
  role: Role
  addedAt: number
  lastSeen: number | null
  revokedAt: number | null
  addedBy: string
}

function ago(at: number | null): string {
  if (!at) return 'never'
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} days ago`
}

/** `cq devices`, `cq devices remove <name|id>`, `cq devices rename <name|id> <new name>` */
export async function devicesCommand(args: string[]): Promise<boolean> {
  const [sub, target, ...rest] = args
  try {
    if (sub === 'remove' || sub === 'rm' || sub === 'revoke') {
      if (!target) {
        console.error('Usage: cq devices remove <name or id>')
        return false
      }
      const r = await api<{ removed?: string; error?: string }>('/api/remote/devices/remove', { device: target })
      console.log(r.ok ? `Removed “${r.data.removed}”: it can't reach this machine any more.` : r.data.error)
      return r.ok
    }
    if (sub === 'rename') {
      if (!target || rest.length === 0) {
        console.error('Usage: cq devices rename <name or id> <new name>')
        return false
      }
      const r = await api<{ renamed?: string; to?: string; error?: string }>('/api/remote/devices/rename', { device: target, name: rest.join(' ') })
      console.log(r.ok ? `Renamed “${r.data.renamed}” to “${r.data.to}”.` : r.data.error)
      return r.ok
    }
    const all = sub === '--all'
    const r = await api<DeviceView[]>(`/api/remote/devices${all ? '?all=1' : ''}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    if (r.data.length === 0) {
      console.log('No devices are paired. Pair one with cq pair.')
      return true
    }
    for (const d of r.data) {
      const state = d.revokedAt ? `removed ${ago(d.revokedAt)}` : `last seen ${ago(d.lastSeen)}`
      console.log(`${d.name} · ${d.platform} · ${d.role} · ${state} · key ${fingerprint(d.id)} · id ${d.id.slice(0, 10)}`)
    }
    return true
  } catch {
    console.error(NOT_RUNNING)
    return false
  }
}

function onOff(value: string | undefined): boolean | null {
  return value === 'on' || value === 'yes' ? true : value === 'off' || value === 'no' ? false : null
}

/** `cq remote` and its settings. */
export async function remoteCommand(args: string[]): Promise<boolean> {
  const [sub, ...rest] = args
  const config = loadConfig()
  const r = config.remote
  const save = (line: string) => {
    saveConfig(config)
    console.log(line)
    return true
  }
  switch (sub) {
    case undefined:
    case 'status': {
      const s = await status()
      console.log(`Remote access: ${r.enabled ? 'on' : 'off'}${r.relay ? ` · relay ${r.relay}` : ' · no relay set'}`)
      if (s?.machine) console.log(`This machine: ${s.machine.name} · key ${s.machine.fingerprint}`)
      if (r.enabled) console.log(s ? `Relay: ${s.connected ? 'connected' : `not connected${s.error ? ` (${s.error})` : ''}`} · ${s.devices} device(s) paired · ${s.sessions} connected now` : NOT_RUNNING)
      if (r.relay) {
        const health = await relayHealth(r.relay)
        console.log(health.ok ? `The relay answers in ${health.ms} ms (${healthUrl(r.relay)})` : `The relay doesn't answer at ${healthUrl(r.relay)} (${health.error})`)
      }
      console.log(`Apps may run tasks in: ${r.allowedRoots.length ? r.allowedRoots.join(', ') : 'your home folder'}`)
      console.log(`Skip-permission tasks from apps: ${r.allowBypass ? 'allowed' : 'not allowed'} · screens: ${r.allowScreens ? 'shown' : 'hidden'} · typing: ${r.allowTyping ? 'allowed' : 'not allowed'}`)
      console.log(`Quitting apps and sleeping this Mac from owners' apps: ${r.allowMac ? 'allowed' : 'not allowed'}`)
      return true
    }
    case 'on':
    case 'off':
      r.enabled = sub === 'on'
      if (r.enabled && !r.relay) {
        console.error('Set a relay first: cq pair --relay wss://<your relay>')
        return false
      }
      return save(`Remote access is ${sub}.`)
    case 'relay': {
      const relay = rest[0] ? relayAddress(rest[0]) : null
      if (!relay) {
        console.error('Usage: cq remote relay wss://<your relay> [--anyway]')
        return false
      }
      const health = await relayHealth(relay, {
        waitMs: 90_000,
        onWait: () => console.log('No answer yet. A relay on a free plan can take a minute to wake; waiting…'),
      })
      if (!health.ok && !rest.includes('--anyway')) {
        console.error(`The relay at ${relay} doesn't answer (${health.error}). Check the address, or set it anyway: cq remote relay ${relay} --anyway`)
        return false
      }
      r.relay = relay
      return save(
        `Relay set to ${relay}${health.ok ? ` (it answered in ${health.ms} ms)` : ''}.\n` +
          'Apps connected right now follow this machine there by themselves. Any other app pairs again: cq pair.',
      )
    }
    case 'name':
      r.name = rest.join(' ').trim() || null
      return save(r.name ? `Apps call this machine “${r.name}”.` : "Apps call this machine by the computer's name.")
    case 'allow':
    case 'disallow': {
      const folder = rest.join(' ').trim()
      if (!folder) {
        console.error(`Usage: cq remote ${sub} <folder>`)
        return false
      }
      const path = (process.platform === 'win32' ? resolve(expandHome(folder)) : expandHome(folder).replace(/\/+$/, '')) || '/'
      r.allowedRoots = r.allowedRoots.filter(p => p !== path)
      if (sub === 'allow') r.allowedRoots.push(path)
      return save(r.allowedRoots.length ? `Apps may run tasks in: ${r.allowedRoots.join(', ')}` : 'Apps may run tasks anywhere in your home folder.')
    }
    case 'bypass':
    case 'screens':
    case 'typing':
    case 'mac': {
      const value = onOff(rest[0])
      if (value === null) {
        console.error(`Usage: cq remote ${sub} on|off`)
        return false
      }
      if (sub === 'bypass') r.allowBypass = value
      if (sub === 'screens') r.allowScreens = value
      if (sub === 'typing') r.allowTyping = value
      if (sub === 'mac') r.allowMac = value
      const what = { bypass: 'Tasks that skip permission prompts', screens: 'Seeing the running terminal', typing: 'Typing into running tasks', mac: "Quitting this Mac's apps and putting it to sleep" }[sub]
      return save(`${what}: ${value ? 'allowed' : 'not allowed'} from apps.`)
    }
    default:
      console.error('Usage: cq remote [status|on|off|relay <url>|name <name>|allow <folder>|disallow <folder>|bypass on|off|screens on|off|typing on|off|mac on|off]')
      return false
  }
}

/** `cq audit [count]`: what apps did on this machine. */
export async function auditCommand(args: string[]): Promise<boolean> {
  const limit = Math.max(1, Math.min(500, Number(args[0] ?? 30) || 30))
  try {
    const r = await api<{ at: number; deviceName: string | null; action: string; detail: string | null; ok: boolean }[]>(`/api/remote/audit?limit=${limit}`)
    if (!r.ok) throw new Error()
    if (r.data.length === 0) console.log('Nothing yet.')
    for (const e of r.data.reverse()) {
      console.log(`${new Date(e.at).toLocaleString()} · ${e.deviceName ?? 'this machine'} · ${e.action}${e.detail ? ` (${e.detail})` : ''}${e.ok ? '' : ' · refused'}`)
    }
    return true
  } catch {
    console.error(NOT_RUNNING)
    return false
  }
}
