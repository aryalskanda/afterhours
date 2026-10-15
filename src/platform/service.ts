// Running the daemon in the background, started at login or boot: a LaunchAgent on macOS, a
// systemd user service on Linux. Where neither is available (a container, WSL without systemd),
// it says how to run `cq daemon` instead.

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import { CQ_HOME, LAUNCH_AGENT_LABEL, paths, searchPath, writeFileAtomic } from '../shared/config'
import { isMac, isWsl } from './os'

export interface ServiceResult {
  ok: boolean
  message: string
}

export interface Service {
  readonly kind: 'launchd' | 'systemd' | 'none'
  /** e.g. "LaunchAgent dev.afterhours.agent". */
  readonly name: string
  /** Writes the service for `program` (run as `program daemon`) and starts it, replacing a running one. */
  install(program: string): Promise<ServiceResult>
  /** Stops the running daemon (Claude sessions in tmux keep running). */
  stop(): void
  uninstall(): void
  /** False when it isn't installed. */
  restart(): boolean
  /** Set up to start by itself. */
  installed(): boolean
  /** Linux: whether it keeps running after you log out (and starts at boot). */
  lingers?(): boolean
}

function exec(argv: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(argv, { env: { ...process.env, PATH: searchPath() }, stdout: 'pipe', stderr: 'pipe' })
    return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() }
  } catch (err) {
    // A program that isn't there (no loginctl, say) is a failure like any other.
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

/** Who we are. Bun can't always name the account (no USER in a bare `docker exec`): loginctl takes the uid. */
function account(): { uid: number; name: string } {
  const info = userInfo()
  const known = info.username && info.username !== 'unknown' ? info.username : ''
  return { uid: info.uid, name: process.env.USER || process.env.LOGNAME || known || String(info.uid) }
}

/** Optional settings for the service, one KEY=value per line: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), HTTPS_PROXY… */
export const serviceEnvFile = join(CQ_HOME, 'env')

// --- macOS: a LaunchAgent -------------------------------------------------------------------

export const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents')
export const plistPath = join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`)

export function launchDomain(): string {
  return `gui/${userInfo().uid}`
}

export function launchdPlist(program: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(program)}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>WorkingDirectory</key><string>${esc(homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(searchPath())}</string>
    <key>CQ_HOME</key><string>${esc(CQ_HOME)}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(paths.log)}</string>
  <key>StandardErrorPath</key><string>${esc(paths.log)}</string>
</dict>
</plist>
`
}

const launchd: Service = {
  kind: 'launchd',
  name: `LaunchAgent ${LAUNCH_AGENT_LABEL}`,
  async install(program) {
    mkdirSync(launchAgentsDir, { recursive: true })
    writeFileAtomic(plistPath, launchdPlist(program))
    exec(['launchctl', 'bootout', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`])
    // launchd can still be tearing down the old instance for a moment after bootout.
    let boot = exec(['launchctl', 'bootstrap', launchDomain(), plistPath])
    for (let i = 0; i < 5 && !boot.ok; i++) {
      await Bun.sleep(1000)
      boot = exec(['launchctl', 'bootstrap', launchDomain(), plistPath])
    }
    return boot.ok
      ? { ok: true, message: `Started ${BRAND.name} in the background (starts at login).` }
      : { ok: false, message: `launchctl bootstrap failed: ${boot.out}` }
  },
  stop() {
    exec(['launchctl', 'bootout', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`])
  },
  uninstall() {
    this.stop()
    rmSync(plistPath, { force: true })
  },
  restart() {
    return exec(['launchctl', 'kickstart', '-k', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]).ok
  },
  installed() {
    return exec(['launchctl', 'print', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`]).ok
  },
}

// --- Linux: a systemd user service ----------------------------------------------------------

export const SYSTEMD_UNIT = `${BRAND.slug}.service`

export function systemdUnitPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT)
}

export function systemdUnit(program: string): string {
  // systemd reads % as the start of a specifier, so it's doubled. ExecStart and Environment take
  // quotes (for spaces); WorkingDirectory and the file settings take the path as it is.
  const quote = (s: string) => `"${s.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const plain = (s: string) => s.replace(/%/g, '%%')
  return `# Written by \`cq install\`. Remove it with \`cq uninstall\`.
[Unit]
Description=${BRAND.name}: queue Claude Code tasks and run them while you're away
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${quote(program)} daemon
WorkingDirectory=${plain(homedir())}
Environment=${quote(`PATH=${searchPath()}`)}
Environment=${quote(`CQ_HOME=${CQ_HOME}`)}
# Optional: CLAUDE_CODE_OAUTH_TOKEN=… (from claude setup-token) to sign Claude Code in without a browser.
EnvironmentFile=-${plain(serviceEnvFile)}
StandardOutput=append:${plain(paths.log)}
StandardError=append:${plain(paths.log)}
# A non-zero exit (e.g. 75: a new version was installed) starts it again.
Restart=on-failure
RestartSec=5
# Stopping it stops only the daemon: the tmux server with the running Claude sessions stays, and
# the next start picks them up.
KillMode=process

[Install]
WantedBy=default.target
`
}

function systemctl(...args: string[]): { ok: boolean; out: string } {
  return exec(['systemctl', '--user', ...args])
}

const systemd: Service = {
  kind: 'systemd',
  name: `systemd user service ${SYSTEMD_UNIT}`,
  async install(program) {
    const unit = systemdUnitPath()
    mkdirSync(join(unit, '..'), { recursive: true })
    writeFileAtomic(unit, systemdUnit(program))
    systemctl('daemon-reload')
    const enable = systemctl('enable', SYSTEMD_UNIT)
    const start = systemctl('restart', SYSTEMD_UNIT)
    if (!enable.ok || !start.ok) return { ok: false, message: `systemctl failed: ${(enable.ok ? start : enable).out}` }
    let linger = this.lingers!()
    // Allowed for your own account on most systems; otherwise it takes sudo (said below).
    if (!linger) linger = exec(['loginctl', 'enable-linger', String(account().uid)]).ok && this.lingers!()
    const when = linger
      ? 'starts at boot and keeps running after you log out'
      : `starts when you log in. To keep it running after you log out (a server), run: sudo loginctl enable-linger ${account().name}`
    return { ok: true, message: `Started ${BRAND.name} in the background (${SYSTEMD_UNIT}): it ${when}.` }
  },
  stop() {
    systemctl('stop', SYSTEMD_UNIT)
  },
  uninstall() {
    systemctl('disable', '--now', SYSTEMD_UNIT)
    rmSync(systemdUnitPath(), { force: true })
    systemctl('daemon-reload')
  },
  restart() {
    return existsSync(systemdUnitPath()) && systemctl('restart', SYSTEMD_UNIT).ok
  },
  installed() {
    return systemctl('is-enabled', SYSTEMD_UNIT).out === 'enabled'
  },
  lingers() {
    return /^Linger=yes$/m.test(exec(['loginctl', 'show-user', String(account().uid), '--property=Linger']).out)
  },
}

// --- neither ---------------------------------------------------------------------------------

/** What to do without a service manager. */
export function noServiceHelp(): string {
  const wsl = isWsl()
    ? '\n  In WSL, turn systemd on: add these lines to /etc/wsl.conf, then run `wsl --shutdown` in Windows and open Ubuntu again:\n      [boot]\n      systemd=true\n  Then run cq install again.'
    : ''
  return (
    `There's no systemd user session here, so ${BRAND.name} can't start by itself. Run it yourself:\n` +
    '  • in a container: make `cq daemon` the command (the Docker image does);\n' +
    `  • in a terminal that stays open: tmux new -d -s ${BRAND.slug}-daemon cq daemon` +
    wsl
  )
}

const none: Service = {
  kind: 'none',
  name: 'no service manager',
  async install() {
    return { ok: false, message: noServiceHelp() }
  },
  stop() {},
  uninstall() {},
  restart() {
    return false
  },
  installed() {
    return false
  },
}

/** systemd's user manager answers (not the case in most containers, or WSL without systemd). */
function hasSystemdUser(): boolean {
  return Bun.which('systemctl') !== null && systemctl('show-environment').ok
}

export function service(): Service {
  if (isMac) return launchd
  if (process.platform === 'linux' && hasSystemdUser()) return systemd
  return none
}
