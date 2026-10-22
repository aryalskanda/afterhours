// The relay the tests talk to: the one in this repository, or, with AFTERHOURS_RELAY_BIN set,
// another program that speaks the same protocol (a hosted relay, say), started on a free port with
// the same limits. The same tests then show that both behave alike.

import type { Subprocess } from 'bun'
import { startRelay, type RelayLimits } from '../src/server'

type Stats = { peers: number; connections: number; links: number; offers: number }

export interface TestRelay {
  url: string
  port: number
  stats(): Promise<Stats>
  stop(): Promise<void>
}

/** Another relay program to test instead of this repository's. */
export const OTHER_RELAY = process.env.AFTERHOURS_RELAY_BIN || null

export async function testRelay(o: { port?: number; db?: string; limits?: Partial<RelayLimits> } = {}): Promise<TestRelay> {
  if (!OTHER_RELAY) {
    const relay = startRelay({ port: o.port ?? 0, db: o.db, limits: o.limits })
    return { url: relay.url, port: relay.port, stats: async () => relay.stats(), stop: () => relay.stop() }
  }
  // connectionsPerPeer → -connections-per-peer
  const flags = Object.entries(o.limits ?? {}).flatMap(([name, value]) => [`-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, String(value)])
  const proc = Bun.spawn([OTHER_RELAY, '-host', '127.0.0.1', '-port', String(o.port ?? 0), ...flags], { stdout: 'pipe', stderr: 'inherit' })
  const port = await listening(proc)
  const base = `127.0.0.1:${port}`
  return {
    url: `ws://${base}/v1`,
    port,
    stats: async () => (await (await fetch(`http://${base}/health`)).json()) as Stats,
    async stop() {
      proc.kill('SIGTERM')
      await proc.exited
    },
  }
}

/** The port from the program's "relay listening on <host>:<port>"; its output is read on after. */
async function listening(proc: Subprocess<'ignore', 'pipe', 'inherit'>): Promise<number> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const timer = setTimeout(() => proc.kill(), 5000)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    const m = /relay listening on [^\s]+:(\d+)/.exec(text)
    if (m) {
      clearTimeout(timer)
      void (async () => {
        while (!(await reader.read()).done) {}
      })()
      return Number(m[1])
    }
  }
  clearTimeout(timer)
  throw new Error(`${OTHER_RELAY} didn't start: ${text.trim() || 'no output'}`)
}
