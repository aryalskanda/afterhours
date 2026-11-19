// The Wi-Fi, with what the system itself has: turning it off and on, joining a saved network, and
// listing the saved ones. None of it needs a password: the systems keep the networks' passwords.
//
// - macOS: networksetup. macOS 26 hides the name of the network you're on (without Location
//   access), so "the last one" is whatever macOS rejoins when the Wi-Fi comes back on.
// - Linux: NetworkManager's nmcli.
// - Windows (natively or from WSL): netsh wlan. Turning the adapter off takes an administrator, so
//   there it only joins saved networks.
//
// Behind WifiSystem, so tests use a fake and never touch the network.

import { inContainer, isLinux, isMac, isWindows, isWsl } from './os'

export interface WifiSystem {
  /** The Wi-Fi interface, or null when there is none (a desktop on a cable, a server). */
  device(): Promise<string | null>
  /** Turns the Wi-Fi off and on again; false where that can't be done. */
  cycle(device: string): Promise<boolean>
  /** Joins a saved network by name; false when it didn't. */
  join(device: string, name: string): Promise<boolean>
  /** The saved networks, in the system's own order. */
  saved(device: string): Promise<string[]>
}

async function run(argv: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { code, out }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { code: 1, out: '' }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** The Wi-Fi device from `networksetup -listallhardwareports` (en0 on most Macs). */
export function macWifiDevice(ports: string): string | null {
  const m = /Hardware Port: (?:Wi-Fi|AirPort)\s*\n\s*Device: (\S+)/.exec(ports)
  return m ? m[1]! : null
}

/** The names `networksetup -listpreferredwirelessnetworks` lists, in order. */
export function macSaved(text: string): string[] {
  return text
    .split('\n')
    .slice(1)
    .map(l => l.replace(/^\t/, '').replace(/\s+$/, ''))
    .filter(Boolean)
}

/** Wi-Fi connections from `nmcli -t -f NAME,TYPE connection show` (colons in names are escaped). */
export function nmcliSaved(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^((?:\\.|[^:\\])*):(.*)$/.exec(line.trim())
    if (m && m[2] === '802-11-wireless') out.push(m[1]!.replace(/\\(.)/g, '$1'))
  }
  return out
}

/** Profile names from `netsh wlan show profiles` ("All User Profile     : Home"). */
export function netshSaved(text: string): string[] {
  return [...text.matchAll(/^\s*All User Profile\s*:\s*(.+?)\s*$/gm)].map(m => m[1]!)
}

/** The first Wi-Fi interface `nmcli -t -f DEVICE,TYPE device` lists. */
export function nmcliDevice(text: string): string | null {
  for (const line of text.split('\n')) {
    const [dev, type] = line.trim().split(':')
    if (dev && type === 'wifi') return dev
  }
  return null
}

export const macWifi: WifiSystem = {
  async device() {
    return macWifiDevice((await run(['networksetup', '-listallhardwareports'])).out)
  },
  async cycle(device) {
    if ((await run(['networksetup', '-setairportpower', device, 'off'])).code !== 0) return false
    await sleep(3000)
    return (await run(['networksetup', '-setairportpower', device, 'on'])).code === 0
  },
  async join(device, name) {
    const r = await run(['networksetup', '-setairportnetwork', device, name], 40_000)
    // networksetup says "Could not find network" or "Failed to join" on stdout, with code 0.
    return r.code === 0 && !/could not|failed|error/i.test(r.out)
  },
  async saved(device) {
    return macSaved((await run(['networksetup', '-listpreferredwirelessnetworks', device])).out)
  },
}

export const linuxWifi: WifiSystem = {
  async device() {
    if (!Bun.which('nmcli')) return null
    return nmcliDevice((await run(['nmcli', '-t', '-f', 'DEVICE,TYPE', 'device'])).out)
  },
  async cycle() {
    if ((await run(['nmcli', 'radio', 'wifi', 'off'])).code !== 0) return false
    await sleep(3000)
    return (await run(['nmcli', 'radio', 'wifi', 'on'])).code === 0
  },
  async join(_device, name) {
    return (await run(['nmcli', 'connection', 'up', name], 60_000)).code === 0
  },
  async saved() {
    return nmcliSaved((await run(['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'])).out)
  },
}

function netsh(): string | null {
  return Bun.which('netsh.exe') ?? Bun.which('netsh') ?? (isWsl() ? '/mnt/c/Windows/System32/netsh.exe' : null)
}

export const windowsWifi: WifiSystem = {
  async device() {
    const exe = netsh()
    if (!exe) return null
    const m = /^\s*Name\s*:\s*(.+?)\s*$/m.exec((await run([exe, 'wlan', 'show', 'interfaces'])).out)
    return m ? m[1]! : null
  },
  async cycle() {
    return false // turning the adapter off takes an administrator
  },
  async join(device, name) {
    const exe = netsh()
    if (!exe) return false
    const r = await run([exe, 'wlan', 'connect', `name=${name}`, `interface=${device}`])
    return r.code === 0
  },
  async saved() {
    const exe = netsh()
    return exe ? netshSaved((await run([exe, 'wlan', 'show', 'profiles'])).out) : []
  },
}

/** This computer's Wi-Fi controls; null where there's none to reconnect (a container). */
export function wifiSystem(): WifiSystem | null {
  if (isMac) return macWifi
  if (isWindows || isWsl()) return windowsWifi
  if (isLinux && !inContainer()) return linuxWifi
  return null
}

/** Whether the internet answers: any of `urls` responding at all (any HTTP status) within `ms`. */
export async function reachable(urls: string[], ms = 5000, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const tries = urls.map(async url => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ms)
    try {
      await fetchImpl(url, { method: 'HEAD', signal: ctl.signal })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  })
  return (await Promise.all(tries)).some(Boolean)
}
