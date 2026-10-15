// Which operating system this is, in the few places where it matters.

import { existsSync, readFileSync } from 'node:fs'

export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

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

/** A desktop to open windows on (always on a Mac; on Linux, an X11 or Wayland session). */
export function hasDisplay(): boolean {
  return isMac || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

/** "macOS 26.1", "Ubuntu 24.04.1 LTS (WSL)", "Debian GNU/Linux 12 (bookworm)". */
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
  return process.platform
}

/** How to install a package here, e.g. "brew install tmux" or "sudo apt install tmux". */
export function installHint(pkg: string): string {
  if (isMac) return `brew install ${pkg}`
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
