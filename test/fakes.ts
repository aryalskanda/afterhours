import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaneInfo, TmuxDriver } from '../src/daemon/tmux'

/** root/{alpha(repo)/src/components, alpha/node_modules/x, beta/docs, beta/build/out, gamma-web/web/app, .hidden/x} */
export function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-tree-'))
  for (const dir of ['alpha/.git', 'alpha/src/components', 'alpha/node_modules/x', 'beta/docs', 'gamma-web/web/app', '.hidden/x', 'beta/build/out']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  writeFileSync(join(root, 'beta', 'README.md'), '# beta')
  return root
}

export interface FakeWindow {
  cwd: string
  env: Record<string, string>
  argv: string[]
  dead: boolean
  deadStatus: number | null
  screen: string
  input: string[]
}

/** Records what the runner does to tmux; tests set `screen`/`dead` to play Claude's side. */
export class FakeTmux implements TmuxDriver {
  windows = new Map<string, FakeWindow>()

  async spawnWindow(name: string, cwd: string, env: Record<string, string>, argv: string[]): Promise<void> {
    this.windows.set(name, { cwd, env, argv, dead: false, deadStatus: null, screen: '', input: [] })
  }
  async pane(name: string): Promise<PaneInfo | null> {
    const w = this.windows.get(name)
    return w ? { dead: w.dead, deadStatus: w.deadStatus, pid: 4242 } : null
  }
  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    this.must(name).input.push(...keys)
  }
  async sendText(name: string, text: string): Promise<void> {
    this.must(name).input.push(`text:${text}`)
  }
  async capture(name: string): Promise<string> {
    return this.windows.get(name)?.screen ?? ''
  }
  async killWindow(name: string): Promise<void> {
    this.windows.delete(name)
  }
  private must(name: string): FakeWindow {
    const w = this.windows.get(name)
    if (!w) throw new Error(`no window ${name}`)
    return w
  }
}
