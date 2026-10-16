// How the machine is doing, for apps: Claude Code's version, disk, battery, load, the log's tail.
// Read-only; nothing here touches a task.

import { closeSync, fstatSync, openSync, readFileSync, readSync, statfsSync } from 'node:fs'
import { cpus, homedir, loadavg } from 'node:os'
import type { HealthInfo } from '@afterhours/protocol'
import { cleanEnv } from '../shared/config'

/** "85%; charging" from `pmset -g batt`, or a Linux battery's capacity and status. */
export function parseBattery(pmset: string | null, linux: { capacity: string; status: string } | null): HealthInfo['battery'] {
  if (pmset) {
    const m = /(\d+)%;\s*([a-z ]+)/i.exec(pmset)
    if (!m) return null
    const state = m[2]!.trim().toLowerCase()
    return { pct: Number(m[1]), charging: state === 'charging' || state === 'charged' || state.startsWith('finishing') || /AC Power/.test(pmset) }
  }
  if (linux) {
    const pct = Number(linux.capacity.trim())
    return Number.isFinite(pct) ? { pct, charging: /^(charging|full|not charging)$/i.test(linux.status.trim()) } : null
  }
  return null
}

function battery(): HealthInfo['battery'] {
  if (process.platform === 'darwin') {
    const r = Bun.spawnSync(['pmset', '-g', 'batt'], { stdout: 'pipe', stderr: 'ignore' })
    const out = r.exitCode === 0 ? r.stdout.toString() : ''
    return /InternalBattery/.test(out) ? parseBattery(out, null) : null
  }
  try {
    return parseBattery(null, { capacity: readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf8'), status: readFileSync('/sys/class/power_supply/BAT0/status', 'utf8') })
  } catch {
    return null // a server or a desktop: no battery
  }
}

let claudeVersionCache: { at: number; version: string | null } | null = null

/** "2.1.301", from `claude --version` (asked at most every 10 minutes). */
export function claudeVersion(claudePath: string, now: number): string | null {
  if (claudeVersionCache && now - claudeVersionCache.at < 600_000) return claudeVersionCache.version
  const r = Bun.spawnSync([claudePath, '--version'], { stdout: 'pipe', stderr: 'ignore', env: cleanEnv() })
  const version = r.exitCode === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout.toString())?.[1] ?? null) : null
  claudeVersionCache = { at: now, version }
  return version
}

/** The last `n` lines of a log file. */
export function logTail(path: string, n: number): string[] {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 64 * 1024)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

export function health(o: { version: string; os: string; claudePath: string; logPath: string; owner: boolean; now: number }): HealthInfo {
  let disk: { free: number; total: number } | null = null
  try {
    const s = statfsSync(homedir())
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
  } catch {
    disk = null
  }
  const cores = cpus().length || 1
  return {
    version: o.version,
    uptimeSec: Math.round(process.uptime()),
    claudeVersion: claudeVersion(o.claudePath, o.now),
    os: o.os,
    diskFreeBytes: disk?.free ?? null,
    diskTotalBytes: disk?.total ?? null,
    battery: battery(),
    load: Math.round((loadavg()[0]! / cores) * 100) / 100,
    ...(o.owner ? { logs: logTail(o.logPath, 40) } : {}),
  }
}
