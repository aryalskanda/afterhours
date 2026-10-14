import { BRAND } from '../shared/brand'
import { TMUX_SESSION } from '../shared/config'

export interface PaneInfo {
  dead: boolean
  deadStatus: number | null
  pid: number | null
}

/** The slice of tmux the runner needs; tests swap in a fake. */
export interface TmuxDriver {
  spawnWindow(name: string, cwd: string, env: Record<string, string>, argv: string[]): Promise<void>
  pane(name: string): Promise<PaneInfo | null>
  sendKeys(name: string, ...keys: string[]): Promise<void>
  sendText(name: string, text: string): Promise<void>
  capture(name: string, lines?: number): Promise<string>
  killWindow(name: string): Promise<void>
}

export const TMUX_CONF = `# Written by ${BRAND.name}. Applies to its private tmux server only (tmux -L ${BRAND.slug}).
set -g remain-on-exit on
set -g history-limit 20000
set -g default-terminal "xterm-256color"
set -g focus-events on
set -g status-left "[${BRAND.slug}] "
set -g status-left-length 20
set -g status-right "read-only view · detach: Ctrl-b d"
`

export class Tmux implements TmuxDriver {
  constructor(
    readonly bin: string,
    readonly socket: string,
    readonly conf: string,
    readonly env: Record<string, string>,
    /** A tmux command that never returns would stall all supervision (usage-limit restarts included). */
    readonly timeoutMs = 10_000,
  ) {}

  private async run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([this.bin, '-L', this.socket, '-f', this.conf, ...args], {
      env: this.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), this.timeoutMs)))
    // Raced as a whole: after a kill, a process it started can still hold the output open.
    const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    try {
      const r = await Promise.race([done, deadline])
      if (r) return { code: r[2], out: r[0], err: r[1] }
      proc.kill('SIGKILL')
      return { code: -1, out: '', err: `timed out after ${this.timeoutMs / 1000}s` }
    } finally {
      clearTimeout(timer)
    }
  }

  private async must(args: string[]): Promise<string> {
    const r = await this.run(args)
    if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.err.trim() || `exit ${r.code}`}`)
    return r.out
  }

  private target(name: string): string {
    return `=${TMUX_SESSION}:=${name}`
  }

  async hasSession(): Promise<boolean> {
    return (await this.run(['has-session', '-t', `=${TMUX_SESSION}`])).code === 0
  }

  async spawnWindow(name: string, cwd: string, env: Record<string, string>, argv: string[]): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const common = ['-d', '-n', name, '-c', cwd, ...envArgs]
    if (await this.hasSession()) {
      await this.must(['new-window', '-t', `=${TMUX_SESSION}:`, ...common, '--', ...argv])
    } else {
      await this.must(['new-session', '-s', TMUX_SESSION, '-x', '200', '-y', '50', ...common, '--', ...argv])
    }
  }

  // Not display-message: for a missing target it falls back to some other window instead of failing.
  async pane(name: string): Promise<PaneInfo | null> {
    const r = await this.run([
      'list-windows',
      '-t',
      `=${TMUX_SESSION}`,
      '-F',
      '#{window_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}',
    ])
    if (r.code !== 0) return null
    for (const line of r.out.split('\n')) {
      const [windowName, dead, status, pid] = line.split('\t')
      if (windowName !== name) continue
      return {
        dead: dead === '1',
        deadStatus: status ? Number(status) : null,
        pid: pid ? Number(pid) : null,
      }
    }
    return null
  }

  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    await this.must(['send-keys', '-t', this.target(name), ...keys])
  }

  /** Types text literally. Newlines would submit early, so callers pass single-line text. */
  async sendText(name: string, text: string): Promise<void> {
    await this.must(['send-keys', '-t', this.target(name), '-l', '--', text])
  }

  async capture(name: string, lines = 60): Promise<string> {
    const r = await this.run(['capture-pane', '-p', '-J', '-t', this.target(name), '-S', `-${lines}`])
    return r.code === 0 ? r.out : ''
  }

  async killWindow(name: string): Promise<void> {
    await this.run(['kill-window', '-t', this.target(name)])
  }
}

/** Trailing blank lines and padding removed; keeps the last `n` non-empty lines. */
export function tail(screen: string, n: number): string {
  const lines = screen
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.length > 0)
  return lines.slice(-n).join('\n')
}
