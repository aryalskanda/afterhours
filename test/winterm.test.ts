// Windows' terminals (the terminal host, in place of tmux): the key names, the screen as tmux would
// capture it, and, on Windows itself, real programs in real pseudo consoles.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { captureScreen, COLS, ROWS, vtKeys } from '../src/daemon/winterm'
import { pathKey, samePath, within } from '../src/shared/paths'
import { parseQueueText } from '../src/daemon/commands'
import { DEFAULT_CONFIG } from '../src/shared/config'

const windows = process.platform === 'win32'

describe('keys', () => {
  test('tmux key names become what a terminal sends; anything else is typed as it is', () => {
    expect(vtKeys(['Enter'])).toBe('\r')
    expect(vtKeys(['Escape'])).toBe('\x1b')
    expect(vtKeys(['Down', 'Down', 'Enter'])).toBe('\x1b[B\x1b[B\r')
    expect(vtKeys(['Up', 'Left', 'Right'])).toBe('\x1b[A\x1b[D\x1b[C')
    expect(vtKeys(['Tab', 'BTab', 'Space', 'BSpace'])).toBe('\t\x1b[Z \x7f')
    expect(vtKeys(['C-c'])).toBe('\x03')
    expect(vtKeys(['C-d'])).toBe('\x04')
    expect(vtKeys(['1'])).toBe('1')
    expect(vtKeys(['continue'])).toBe('continue')
  })
})

describe('the screen, as capture-pane gives it', () => {
  const write = (term: Terminal, text: string) => new Promise<void>(resolve => term.write(text, resolve))

  test('a line longer than the window comes back whole; trailing blanks are dropped', async () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    await write(term, 'short\r\n' + 'x'.repeat(30) + '\r\nlast')
    const lines = (await captureScreen(term, null, 60)).split('\n')
    expect(lines.slice(0, 3)).toEqual(['short', 'x'.repeat(30), 'last'])
    term.dispose()
  })

  test('only the last lines of the scrollback, then the screen', async () => {
    const term = new Terminal({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true })
    await write(term, Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\r\n'))
    const lines = (await captureScreen(term, null, 2)).trimEnd().split('\n')
    expect(lines).toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9'])
    term.dispose()
  })
})

describe('paths, compared as the system does', () => {
  test('Windows ignores case and takes either slash; macOS and Linux compare as they are', () => {
    expect(pathKey('D:\\IT Works\\App\\', true)).toBe('d:/it works/app')
    expect(pathKey('C:\\', true)).toBe('c:/')
    expect(samePath('D:/IT Works/app', 'd:\\it works\\app', true)).toBe(true)
    expect(samePath('/Users/me/App', '/Users/me/app', false)).toBe(false)
    expect(within('D:\\Code', 'd:/code/shop/web', true)).toBe(true)
    expect(within('D:\\Code', 'D:\\Codes', true)).toBe(false)
    expect(within('/home/me/code', '/home/me/code/shop', false)).toBe(true)
    expect(within('/home/me/code', '/home/me/codes', false)).toBe(false)
  })

  test("a drive's colon isn't the end of the options", () => {
    const parsed = parseQueueText('plan: open C:\\Code\\notes.txt and fix it', DEFAULT_CONFIG, true)
    expect(parsed.options.plan).toBe(true)
    expect(parsed.prompt).toBe('open C:\\Code\\notes.txt and fix it')
    expect(parseQueueText('fix: the login bug', DEFAULT_CONFIG, true).prompt).toBe('fix: the login bug')
  })

  test.skipIf(!windows)('Windows: a folder typed as D:\\… before the options', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-q-'))
    const parsed = parseQueueText(`${dir} review opus: refactor the parser`, DEFAULT_CONFIG, true)
    expect(parsed.options).toMatchObject({ project: dir, plan: true, review: true, model: 'opus' })
    expect(parsed.prompt).toBe('refactor the parser')
  })
})

describe.skipIf(!windows)('Windows: real pseudo consoles', () => {
  test('a program runs, prints, and ends with its exit code', async () => {
    const { PseudoConsole } = await import('../src/platform/win32')
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
    const pty = new PseudoConsole({ argv: ['cmd.exe', '/d', '/c', 'echo hello from conpty& exit /b 7'], cwd: tmpdir(), env, cols: 80, rows: 10 })
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    term.onData(data => pty.write(data))
    let flushed = Promise.resolve()
    const deadline = Date.now() + 10_000
    while (pty.exitCode() === null && Date.now() < deadline) {
      const data = pty.read()
      if (data.length) flushed = new Promise(resolve => term.write(data, resolve))
      await Bun.sleep(30)
    }
    await Bun.sleep(200)
    const rest = pty.read()
    if (rest.length) flushed = new Promise(resolve => term.write(rest, resolve))
    expect(pty.exitCode()).toBe(7)
    expect(await captureScreen(term, null, 60, flushed)).toContain('hello from conpty')
    pty.dispose()
    term.dispose()
  })

  test('the host: a window gets typed into, captured, its exit seen, and closed', async () => {
    // A host of its own, in a throwaway home, run as `cq term-host` is.
    const home = mkdtempSync(join(tmpdir(), 'cq-term-'))
    const entry = join(import.meta.dir, '..', 'src', 'cli', 'cq.ts')
    const host = Bun.spawn([process.execPath, entry, 'term-host'], { env: { ...process.env, CQ_HOME: home }, stdout: 'ignore', stderr: 'ignore' })
    try {
      let address: { port: number } | null = null
      for (let i = 0; i < 100 && !address; i++) {
        await Bun.sleep(100)
        try {
          address = JSON.parse(readFileSync(join(home, 'term.json'), 'utf8'))
        } catch {
          // not yet
        }
      }
      expect(address).not.toBeNull()
      const token = readFileSync(join(home, 'token'), 'utf8').trim()
      const base = `http://127.0.0.1:${address!.port}`
      const call = (path: string, body?: unknown) =>
        fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-cq-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      expect((await fetch(`${base}/panes`)).status).toBe(401)

      const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
      const spawned = await call('/spawn', { name: 'job-1', cwd: tmpdir(), env, argv: ['cmd.exe', '/d', '/q', '/k', 'prompt $G'], cols: COLS, rows: ROWS })
      expect(spawned.status).toBe(200)
      await call('/text', { name: 'job-1', text: 'echo typed-%COMPUTERNAME%-ok' })
      await call('/keys', { name: 'job-1', keys: ['Enter'] })
      let screen = ''
      for (let i = 0; i < 100 && !/typed-.+-ok\s*$/m.test(screen); i++) {
        await Bun.sleep(100)
        screen = await (await call('/capture?name=job-1&lines=40')).text()
      }
      expect(screen).toMatch(new RegExp(`^typed-${process.env.COMPUTERNAME}-ok`, 'im'))
      type Pane = { name: string; dead: boolean; status: number | null; pid: number }
      let panes = (await (await call('/panes')).json()) as Pane[]
      expect(panes).toMatchObject([{ name: 'job-1', dead: false }])

      // Exits like a program in it would; the window stays, dead, with the exit code.
      await call('/text', { name: 'job-1', text: 'exit 3' })
      await call('/keys', { name: 'job-1', keys: ['Enter'] })
      for (let i = 0; i < 100 && !panes[0]?.dead; i++) {
        await Bun.sleep(100)
        panes = (await (await call('/panes')).json()) as Pane[]
      }
      expect(panes).toMatchObject([{ name: 'job-1', dead: true, status: 3 }])

      await call('/kill', { name: 'job-1' })
      expect(await (await call('/panes')).json()).toEqual([])
    } finally {
      host.kill()
    }
  }, 30_000)
})
