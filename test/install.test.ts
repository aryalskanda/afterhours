// install.sh, the line people paste: its download path, run with the real /bin/sh against a local
// "release", in a throwaway home. Nothing on the machine it runs on is installed.

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(import.meta.dir, '..', 'install.sh')

describe('install.sh', () => {
  test('no variable is followed directly by a non-ASCII character (macOS sh reads it as part of the name)', () => {
    const bad = readFileSync(script, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
    expect(bad).toEqual([])
  })

  // install.sh is for macOS and Linux (Windows has install.ps1), and needs a POSIX sh.
  test.skipIf(process.platform === 'win32')('downloads, checks the checksum, installs and puts cq on the PATH, in a UTF-8 locale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-install-'))
    const home = join(root, 'home')
    const stubs = join(root, 'bin')
    mkdirSync(home)
    mkdirSync(stubs)
    for (const tool of ['tmux', 'claude']) {
      writeFileSync(join(stubs, tool), '#!/bin/sh\nexit 0\n')
      chmodSync(join(stubs, tool), 0o755)
    }
    // The "release": a cq that answers version and install, and its checksums.
    const cq = '#!/bin/sh\ncase "$1" in version) echo 9.9.9 ;; install) mkdir -p "$HOME/.afterhours/bin" && cp "$0" "$HOME/.afterhours/bin/cq" && echo stub-installed ;; esac\n'
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const asset = `cq-${os}-${arch}`
    const sum = new Bun.CryptoHasher('sha256').update(cq).digest('hex')
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === `/${asset}`) return new Response(cq)
        if (path === '/SHA256SUMS') return new Response(`${sum}  ${asset}\n`)
        return new Response('not found', { status: 404 })
      },
    })
    try {
      const run = async (base: string) => {
        const proc = Bun.spawn(['sh', script], {
          env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', AFTERHOURS_REPO: 'owner/repo', AFTERHOURS_BASE_URL: base, AFTERHOURS_NO_SETUP: '1' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { out, err, code }
      }
      const ok = await run(`http://127.0.0.1:${server.port}`)
      expect(ok.err).toBe('')
      expect(ok.code).toBe(0)
      expect(ok.out).toContain(`Downloading ${asset}…`)
      expect(ok.out).toContain('Installing Afterhours 9.9.9')
      expect(ok.out).toContain('stub-installed')
      expect(existsSync(join(home, '.afterhours', 'bin', 'cq'))).toBe(true)
      expect(readFileSync(join(home, '.zshrc'), 'utf8')).toContain('.local/bin')

      // A download that doesn't match its checksum installs nothing.
      rmSync(join(home, '.afterhours'), { recursive: true })
      const wrong = Bun.serve({ port: 0, fetch: req => (new URL(req.url).pathname === '/SHA256SUMS' ? new Response(`${'0'.repeat(64)}  ${asset}\n`) : new Response(cq)) })
      try {
        const bad = await run(`http://127.0.0.1:${wrong.port}`)
        expect(bad.code).not.toBe(0)
        expect(bad.err).toContain("doesn't match its checksum")
        expect(existsSync(join(home, '.afterhours'))).toBe(false)
      } finally {
        wrong.stop(true)
      }
    } finally {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
