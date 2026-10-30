import { describe, expect, test } from 'bun:test'
import { checksumFor, releaseAsset } from '../src/cli/install'
import { keepAwakeCommand } from '../src/platform/desktop'
import { installHint, isMac } from '../src/platform/os'
import { launchdPlist, noServiceHelp, serviceEnvFile, systemdUnit } from '../src/platform/service'
import { cleanEnv, CQ_HOME } from '../src/shared/config'

describe('the background service', () => {
  test('systemd: restarts after a crash or an update, but stopping it leaves the Claude sessions running', () => {
    const unit = systemdUnit('/home/me/.afterhours/bin/cq')
    expect(unit).toContain('ExecStart="/home/me/.afterhours/bin/cq" daemon')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain(`Environment="CQ_HOME=${CQ_HOME}"`)
    expect(unit).toContain(`EnvironmentFile=-${serviceEnvFile}`)
    expect(unit).toContain('WantedBy=default.target')
    // systemd refuses a quoted WorkingDirectory ("path is not absolute").
    expect(unit).toMatch(/^WorkingDirectory=\/[^"\n]*$/m)
  })

  test("systemd: paths with % or spaces don't break the unit", () => {
    const unit = systemdUnit('/opt/odd dir/100%/cq')
    expect(unit).toContain('ExecStart="/opt/odd dir/100%%/cq" daemon')
  })

  test('launchd: the plist runs the program as the daemon, escaped', () => {
    const plist = launchdPlist('/Users/me/A&B/cq-launcher')
    expect(plist).toContain('<string>/Users/me/A&amp;B/cq-launcher</string><string>daemon</string>')
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>')
  })

  test('without a service manager it says how to run it instead', () => {
    expect(noServiceHelp()).toContain('cq daemon')
  })
})

describe('updates', () => {
  test('the release file for each system', () => {
    expect(releaseAsset('darwin', 'arm64')).toBe('cq-darwin-arm64')
    expect(releaseAsset('darwin', 'x64')).toBe('cq-darwin-x64')
    expect(releaseAsset('linux', 'arm64')).toBe('cq-linux-arm64')
    expect(releaseAsset('linux', 'x64')).toBe('cq-linux-x64')
  })

  test('checksums are read from a SHA256SUMS file', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const sums = `${a}  cq-darwin-arm64\n${b} *cq-linux-x64\n`
    expect(checksumFor(sums, 'cq-darwin-arm64')).toBe(a)
    expect(checksumFor(sums, 'cq-linux-x64')).toBe(b.toLowerCase())
    expect(checksumFor(sums, 'cq-linux-arm64')).toBeNull()
  })
})

describe('what Claude sessions get from the environment', () => {
  test('a headless sign-in token and proxies pass; nesting markers and anything else stay out', () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok', HTTPS_PROXY: 'http://proxy:3128', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', SECRET_THING: 'x' })
      const env = cleanEnv()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok')
      expect(env.HTTPS_PROXY).toBe('http://proxy:3128')
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
      expect(env.SECRET_THING).toBeUndefined()
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })

  test('a shell and a locale that exist on this system', async () => {
    const saved = { ...process.env }
    try {
      delete process.env.SHELL
      delete process.env.LANG
      const env = cleanEnv()
      expect(await Bun.file(env.SHELL!).exists()).toBe(true)
      expect(env.LANG).toBe(process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8')
    } finally {
      Object.assign(process.env, saved)
    }
  })
})

describe('desktop bits', () => {
  test('staying awake ends with the daemon', () => {
    const argv = keepAwakeCommand(4242)
    if (isMac) expect(argv).toEqual(['caffeinate', '-i', '-w', '4242'])
    else if (argv) expect(argv.join(' ')).toContain('kill -0 4242')
  })

  test('install hints name a package manager', () => {
    expect(installHint('tmux')).toMatch(/tmux/)
    if (isMac) expect(installHint('tmux')).toBe('brew install tmux')
  })
})

import { createTaskArgs, keepTaskCommand, KEEP_TASK } from '../src/platform/wsl'

describe('keeping Ubuntu running on Windows', () => {
  test('the sign-in task holds this distro open with a hidden PowerShell', () => {
    expect(keepTaskCommand('Ubuntu')).toBe('powershell.exe -WindowStyle Hidden -Command wsl.exe -d Ubuntu --exec sleep infinity')
    const args = createTaskArgs('Ubuntu-24.04')
    expect(args.slice(0, 4)).toEqual(['/Create', '/F', '/TN', KEEP_TASK])
    expect(args).toContain('ONLOGON')
    expect(args.at(-1)).toContain('-d Ubuntu-24.04 --exec sleep infinity')
  })
})
