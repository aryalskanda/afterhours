// Which operating system this is, in the few places where it matters.

import { existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'

export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'
/** Windows itself (not WSL, which is Linux). */
export const isWindows = process.platform === 'win32'

/** Windows' build number (22631, 26100…); 0 elsewhere. */
export function windowsBuild(): number {
  return isWindows ? Number(release().split('.')[2] ?? 0) : 0
}

/** Pseudo consoles (ConPTY), which tasks run in on Windows, arrived in Windows 10 1809 (build 17763). */
export const MIN_WINDOWS_BUILD = 17763

/** Linux inside Windows (WSL2). */
export function isWsl(): boolean {
  if (!isLinux) return false
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Inside a container (Docker, Podman): no service manager, no desktop, nothing that sleeps. */
export function inContainer(): boolean {
  return isLinux && (existsSync('/.dockerenv') || existsSync('/run/.containerenv'))
}

/** A desktop to open windows on (always on a Mac and on Windows; on Linux, an X11 or Wayland session). */
export function hasDisplay(): boolean {
  return isMac || isWindows || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

/** "macOS 26.1", "Windows 11 (build 26100)", "Ubuntu 24.04.1 LTS (WSL)", "Debian GNU/Linux 12 (bookworm)". */
export function osLabel(): string {
  if (isMac) {
    const version = Bun.spawnSync(['sw_vers', '-productVersion'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim()
    return `macOS ${version}`.trim()
  }
  if (isLinux) {
    let name = 'Linux'
    try {
      name = /^PRETTY_NAME="?(.*?)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? name
    } catch {
      // no os-release
    }
    return isWsl() ? `${name} (WSL)` : inContainer() ? `${name} (container)` : name
  }
  if (isWindows) {
    const build = windowsBuild()
    return `Windows ${build >= 22000 ? 11 : 10} (build ${build})`
  }
  return process.platform
}

/** winget's id for the packages Afterhours asks for on Windows. */
const WINGET_IDS: Record<string, string> = { git: 'Git.Git', gh: 'GitHub.cli' }

/** How to install a package here, e.g. "brew install tmux", "sudo apt install tmux" or "winget install --id Git.Git -e". */
export function installHint(pkg: string): string {
  if (isMac) return `brew install ${pkg}`
  if (isWindows) return `winget install --id ${WINGET_IDS[pkg] ?? pkg} -e`
  const managers: [string, string][] = [
    ['apt-get', `sudo apt install ${pkg}`],
    ['dnf', `sudo dnf install ${pkg}`],
    ['yum', `sudo yum install ${pkg}`],
    ['pacman', `sudo pacman -S ${pkg}`],
    ['zypper', `sudo zypper install ${pkg}`],
    ['apk', `sudo apk add ${pkg}`],
  ]
  for (const [bin, hint] of managers) if (Bun.which(bin)) return hint
  return `install ${pkg} with your package manager`
}
