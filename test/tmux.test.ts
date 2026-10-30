import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tmux } from '../src/daemon/tmux'

describe('tmux commands', () => {
  // tmux is macOS and Linux (Windows uses the terminal host, test/winterm.test.ts); the fake is a sh script.
  test.skipIf(process.platform === 'win32')('a command that hangs is given up on instead of stalling supervision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-tmux-'))
    const bin = join(dir, 'tmux')
    writeFileSync(bin, '#!/bin/sh\nsleep 30\n')
    chmodSync(bin, 0o755)
    const tmux = new Tmux(bin, 'sock', '/dev/null', { PATH: '/usr/bin:/bin' }, 200)
    const started = Date.now()
    expect(await tmux.pane('job-1')).toBeNull()
    await expect(tmux.sendKeys('job-1', 'Enter')).rejects.toThrow('timed out after 0.2s')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
