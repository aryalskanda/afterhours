import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  // #244: has-session said no session, then new-session found one ("duplicate session").
  test.skipIf(process.platform === 'win32')('a session that appears between the check and the start gets a window instead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-tmux-'))
    const bin = join(dir, 'tmux')
    const calls = join(dir, 'calls')
    writeFileSync(
      bin,
      `#!/bin/sh
shift 4
echo "$1" >> ${calls}
case "$1" in
  has-session) exit 1 ;;
  new-session) echo "duplicate session: afterhours" >&2; exit 1 ;;
  new-window) exit 0 ;;
esac
exit 2
`,
    )
    chmodSync(bin, 0o755)
    const tmux = new Tmux(bin, 'sock', '/dev/null', { PATH: '/usr/bin:/bin' })
    await tmux.spawnWindow('job-1', dir, {}, ['claude'])
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['has-session', 'new-session', 'new-window'])
  })

  test.skipIf(process.platform === 'win32')('any other failure to start a window is reported, not retried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-tmux-'))
    const bin = join(dir, 'tmux')
    writeFileSync(bin, '#!/bin/sh\nshift 4\n[ "$1" = has-session ] && exit 0\necho "create window failed: index in use" >&2\nexit 1\n')
    chmodSync(bin, 0o755)
    const tmux = new Tmux(bin, 'sock', '/dev/null', { PATH: '/usr/bin:/bin' })
    await expect(tmux.spawnWindow('job-1', dir, {}, ['claude'])).rejects.toThrow('tmux new-window failed: create window failed: index in use')
  })
})
