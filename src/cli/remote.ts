// `cq pair`, `cq devices`, `cq remote` and `cq audit`: remote access from the Afterhours apps.

import { fingerprint, type OfferView } from '@afterhours/protocol'
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
      console.log(`Apps may run tasks in: ${r.allowedRoots.length ? r.allowedRoots.join(', ') : 'your home folder'}`)
      console.log(`Skip-permission tasks from apps: ${r.allowBypass ? 'allowed' : 'not allowed'} · screens: ${r.allowScreens ? 'shown' : 'hidden'} · typing: ${r.allowTyping ? 'allowed' : 'not allowed'}`)
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
        console.error('Usage: cq remote relay wss://<your relay>')
        return false
      }
      r.relay = relay
      return save(`Relay set to ${relay}. Devices paired through another relay can't reach this machine until you pair them again (cq pair).`)
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
      const path = expandHome(folder).replace(/\/+$/, '') || '/'
      r.allowedRoots = r.allowedRoots.filter(p => p !== path)
      if (sub === 'allow') r.allowedRoots.push(path)
      return save(r.allowedRoots.length ? `Apps may run tasks in: ${r.allowedRoots.join(', ')}` : 'Apps may run tasks anywhere in your home folder.')
    }
    case 'bypass':
    case 'screens':
    case 'typing': {
      const value = onOff(rest[0])
      if (value === null) {
        console.error(`Usage: cq remote ${sub} on|off`)
        return false
      }
      if (sub === 'bypass') r.allowBypass = value
      if (sub === 'screens') r.allowScreens = value
      if (sub === 'typing') r.allowTyping = value
      const what = { bypass: 'Tasks that skip permission prompts', screens: 'Seeing the running terminal', typing: 'Typing into running tasks' }[sub]
      return save(`${what}: ${value ? 'allowed' : 'not allowed'} from apps.`)
    }
    default:
      console.error('Usage: cq remote [status|on|off|relay <url>|name <name>|allow <folder>|disallow <folder>|bypass on|off|screens on|off|typing on|off]')
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
