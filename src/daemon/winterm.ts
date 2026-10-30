// Tasks' terminals on Windows, which has no tmux. A small host process (`cq term-host`) plays the
// tmux server: it runs each task in its own pseudo console (ConPTY), keeps the screen in a headless
// terminal, and answers the daemon over 127.0.0.1 with the same token as everything else. It lives
// apart from the daemon, so Claude sessions keep running while the daemon restarts or updates, as
// they do in tmux elsewhere. `WinTerm` is the daemon's side, the same TmuxDriver the runner uses.

import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import type { ServerWebSocket } from 'bun'
import { ensureToken, paths, readToken, writeFileAtomic } from '../shared/config'
import type { PaneInfo, TmuxDriver } from './tmux'

/** The size tmux windows get elsewhere (new-session -x 200 -y 50). */
export const COLS = 200
export const ROWS = 50
const SCROLLBACK = 20_000
/** With no task for this long, the host goes; the next task starts it again. */
const IDLE_MS = 10 * 60_000

/** tmux's key names, as the runner and the apps send them, in the bytes a terminal sends for them. */
const KEYS: Record<string, string> = {
  Enter: '\r',
  Escape: '\x1b',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Tab: '\t',
  BTab: '\x1b[Z',
  Space: ' ',
  BSpace: '\x7f',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  DC: '\x1b[3~',
}

/** Like `tmux send-keys`: a key name becomes its bytes (C-c → Ctrl-C), anything else is typed as it is. */
export function vtKeys(keys: string[]): string {
  return keys
    .map(key => KEYS[key] ?? (/^C-[a-z@[\\\]^_]$/i.test(key) ? String.fromCharCode(key.toUpperCase().charCodeAt(2) & 0x1f) : key))
    .join('')
}

interface HostAddress {
  port: number
  pid: number
}

function readAddress(): HostAddress | null {
  try {
    const a = JSON.parse(readFileSync(paths.termHost, 'utf8')) as HostAddress
    return typeof a.port === 'number' ? a : null
  } catch {
    return null
  }
}

/** The running host's address, if one answers. */
export async function findHost(): Promise<{ url: string; pid: number } | null> {
  const a = readAddress()
  if (!a) return null
  const url = `http://127.0.0.1:${a.port}`
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? { url, pid: a.pid } : null
  } catch {
    return null
  }
}

// --- the host ---------------------------------------------------------------------------------

interface Pane {
  name: string
  pty: import('../platform/win32').PseudoConsole | null
  term: Terminal
  serializer: SerializeAddon
  pid: number
  status: number | null
  exitSeenAt: number | null
  /** Settles once everything read so far is on the screen. */
  flushed: Promise<void>
  clients: Set<ServerWebSocket<{ name: string }>>
  startedAt: number
}

interface SpawnRequest {
  name: string
  cwd: string
  env: Record<string, string>
  argv: string[]
  cols?: number
  rows?: number
}

/** The screen as `tmux capture-pane -p -J -S -<lines>` gives it: the last `lines` of scrollback, then the screen. */
export async function captureScreen(term: Terminal, serializer: SerializeAddon | null, lines: number, flushed: Promise<void> = Promise.resolve()): Promise<string> {
  await flushed
  const buf = term.buffer.active
  const start = Math.max(0, buf.baseY - lines)
  if (serializer) return serializer.serialize({ scrollback: buf.baseY - start }).replace(/\r\n/g, '\n') + '\n'
  const out: string[] = []
  let current = ''
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    // A line that runs on into the next (wrapped) is joined to it, as -J does.
    const runsOn = buf.getLine(i + 1)?.isWrapped ?? false
    current += line.translateToString(!runsOn)
    if (!runsOn) {
      out.push(current)
      current = ''
    }
  }
  if (current) out.push(current)
  return out.join('\n') + '\n'
}

function hostLog(line: string): void {
  try {
    appendFileSync(join(paths.logs, 'term-host.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // nowhere to say it
  }
}

/** `cq term-host`: runs until it has had no task for a while. */
export async function runTermHost(): Promise<void> {
  if (await findHost()) return // one is running already
  const token = ensureToken()
  const { PseudoConsole } = await import('../platform/win32')
  const panes = new Map<string, Pane>()
  let idleSince = Date.now()

  const feed = (pane: Pane, data: Uint8Array) => {
    pane.flushed = new Promise(resolve => pane.term.write(data, resolve))
    for (const ws of pane.clients) ws.sendBinary(data)
  }
  const kill = (pane: Pane) => {
    pane.pty?.dispose()
    pane.pty = null
    for (const ws of pane.clients) ws.close()
    pane.term.dispose()
    panes.delete(pane.name)
  }

  const pump = setInterval(() => {
    const now = Date.now()
    for (const pane of panes.values()) {
      if (!pane.pty) continue
      const data = pane.pty.read()
      if (data.length > 0) feed(pane, data)
      const code = pane.pty.exitCode()
      if (code === null) continue
      // The console can still be passing on the last of the output: one more look before it closes.
      if (pane.exitSeenAt === null) {
        pane.exitSeenAt = now
      } else if (now - pane.exitSeenAt > 250) {
        pane.pty.dispose()
        pane.pty = null
        pane.status = code
        for (const ws of pane.clients) ws.close()
      }
    }
    if (panes.size > 0) idleSince = now
    else if (now - idleSince > IDLE_MS) stop()
  }, 30)

  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const named = (name: string | null) => (name ? panes.get(name) : undefined)

  const server = Bun.serve<{ name: string }, never>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return json({ ok: true, pid: process.pid, panes: panes.size })
      if (req.headers.get('x-cq-token') !== token && url.searchParams.get('token') !== token) return json({ error: 'unauthorized' }, 401)
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {}
      switch (url.pathname) {
        case '/spawn': {
          const r = body as unknown as SpawnRequest
          const old = panes.get(r.name)
          if (old) kill(old)
          const cols = r.cols ?? COLS
          const rows = r.rows ?? ROWS
          const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
          const serializer = new SerializeAddon()
          term.loadAddon(serializer)
          let pty: InstanceType<typeof PseudoConsole>
          try {
            pty = new PseudoConsole({ argv: r.argv, cwd: r.cwd, env: r.env, cols, rows })
          } catch (err) {
            term.dispose()
            return json({ error: err instanceof Error ? err.message : String(err) }, 500)
          }
          const pane: Pane = { name: r.name, pty, term, serializer, pid: pty.pid, status: null, exitSeenAt: null, flushed: Promise.resolve(), clients: new Set(), startedAt: Date.now() }
          // The terminal's answers to what the program asks it (cursor position, device attributes).
          term.onData(data => pane.pty?.write(data))
          panes.set(r.name, pane)
          hostLog(`started ${r.name} (pid ${pty.pid})`)
          return json({ pid: pty.pid })
        }
        case '/panes':
          return json([...panes.values()].map(p => ({ name: p.name, dead: p.pty === null, status: p.status, pid: p.pid })))
        case '/keys':
        case '/text': {
          const pane = named(body.name as string)
          if (!pane) return json({ error: `no window ${body.name}` }, 404)
          pane.pty?.write(url.pathname === '/keys' ? vtKeys(body.keys as string[]) : (body.text as string))
          return json({ ok: true })
        }
        case '/capture': {
          const pane = named(url.searchParams.get('name'))
          if (!pane) return json({ error: 'no such window' }, 404)
          const lines = Number(url.searchParams.get('lines') ?? 60)
          const escapes = url.searchParams.get('escapes') === '1'
          return new Response(await captureScreen(pane.term, escapes ? pane.serializer : null, lines, pane.flushed))
        }
        case '/kill': {
          const pane = named(body.name as string)
          if (pane) {
            kill(pane)
            hostLog(`closed ${pane.name}`)
          }
          return json({ ok: true })
        }
        case '/attach': {
          // A window by name, else the one started last that still runs.
          const pane = named(url.searchParams.get('name')) ?? [...panes.values()].filter(p => p.pty).sort((a, b) => b.startedAt - a.startedAt)[0]
          if (!pane) return json({ error: 'nothing is running' }, 404)
          return srv.upgrade(req, { data: { name: pane.name } }) ? undefined : json({ error: 'not a websocket' }, 400)
        }
      }
      return json({ error: 'not found' }, 404)
    },
    websocket: {
      async open(ws) {
        const pane = panes.get(ws.data.name)
        if (!pane) return ws.close()
        await pane.flushed
        ws.send(pane.serializer.serialize())
        pane.clients.add(ws)
      },
      close(ws) {
        panes.get(ws.data.name)?.clients.delete(ws)
      },
      message() {
        // Read-only: what a watcher types goes nowhere.
      },
    },
  })

  writeFileAtomic(paths.termHost, JSON.stringify({ port: server.port, pid: process.pid }) + '\n', 0o600)
  hostLog(`listening on 127.0.0.1:${server.port} (pid ${process.pid})`)

  function stop(): void {
    clearInterval(pump)
    for (const pane of [...panes.values()]) kill(pane)
    if (readAddress()?.pid === process.pid) rmSync(paths.termHost, { force: true })
    hostLog('no tasks for a while; stopping')
    server.stop(true)
    process.exit(0)
  }
}

// --- the daemon's side ------------------------------------------------------------------------

/** The runner's terminals on Windows: windows in the terminal host, started on first use. */
export class WinTerm implements TmuxDriver {
  private url: string | null = null
  private starting: Promise<string> | null = null

  constructor(
    /** How to run cq (`cq.exe`, or `bun src/cli/cq.ts`), to start the host. */
    readonly program: string[],
    /** The environment the windows' programs get, under each window's own. */
    readonly env: Record<string, string>,
    readonly timeoutMs = 10_000,
  ) {}

  private async host(): Promise<string> {
    const found = await findHost()
    if (found) return found.url
    this.starting ??= (async () => {
      // Detached and hidden: it outlives this daemon, like the tmux server does. Not with spawn():
      // it would hand the host this daemon's listening socket, and the port would stay taken.
      const { spawnDetached } = await import('../platform/win32')
      spawnDetached([...this.program, 'term-host'], { cwd: homedir(), env: this.env })
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(100)
        const up = await findHost()
        if (up) return up.url
      }
      throw new Error("the terminal host didn't start (see ~/.afterhours/logs/term-host.log)")
    })().finally(() => (this.starting = null))
    return this.starting
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const token = readToken() ?? ''
    const send = (base: string) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'x-cq-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    try {
      this.url ??= await this.host()
      return await send(this.url)
    } catch {
      // The host went (idle, or the PC restarted): find or start it, once.
      this.url = await this.host()
      return send(this.url)
    }
  }

  private async must(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const res = await this.call(method, path, body)
    if (!res.ok) throw new Error(`terminal host ${path} failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`)
    return res
  }

  async spawnWindow(name: string, cwd: string, env: Record<string, string>, argv: string[]): Promise<void> {
    await this.must('POST', '/spawn', { name, cwd, env: { ...this.env, ...env }, argv, cols: COLS, rows: ROWS } satisfies SpawnRequest)
  }

  async pane(name: string): Promise<PaneInfo | null> {
    try {
      const res = await this.call('GET', '/panes')
      if (!res.ok) return null
      const pane = ((await res.json()) as { name: string; dead: boolean; status: number | null; pid: number }[]).find(p => p.name === name)
      return pane ? { dead: pane.dead, deadStatus: pane.status, pid: pane.pid } : null
    } catch {
      return null
    }
  }

  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    await this.must('POST', '/keys', { name, keys })
  }

  async sendText(name: string, text: string): Promise<void> {
    await this.must('POST', '/text', { name, text })
  }

  async capture(name: string, lines = 60, escapes = false): Promise<string> {
    try {
      const res = await this.call('GET', `/capture?name=${encodeURIComponent(name)}&lines=${lines}${escapes ? '&escapes=1' : ''}`)
      return res.ok ? await res.text() : ''
    } catch {
      return ''
    }
  }

  async killWindow(name: string): Promise<void> {
    try {
      await this.call('POST', '/kill', { name })
    } catch {
      // nothing to close
    }
  }
}
