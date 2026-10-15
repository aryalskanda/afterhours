import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import launcherSource from '../../bin/cq-launcher.c' with { type: 'text' }
import { selfCommand, VERSION } from '../daemon/main'
import { BRAND, LEGACY } from '../shared/brand'
import { CQ_HOME, ensureHome, findExecutable, LAUNCH_AGENT_LABEL, loadConfig, paths, writeFileAtomic } from '../shared/config'
import { isMac, isWsl } from '../platform/os'
import { launchAgentsDir, launchDomain, service, type Service } from '../platform/service'
import { migrateLegacy } from './migrate'
import { run } from './util'

/** macOS: the small launcher that holds Full Disk Access, so updates don't undo it. */
export const launcherPath = join(paths.bin, 'cq-launcher')

/** For a binary inside a Homebrew Cellar, the stable link Homebrew keeps pointing at the current version. */
export function homebrewLink(execPath: string): string | null {
  const m = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/cq$/.exec(execPath)
  if (!m) return null
  const link = join(m[1]!, 'bin', 'cq')
  return existsSync(link) ? link : null
}

/** Moves a pre-rename install over (macOS only). False if it can't happen yet (a job is running). */
export function migrateIfNeeded(): boolean {
  if (!isMac) return true
  const result = migrateLegacy({
    home: CQ_HOME,
    legacyHome: join(homedir(), LEGACY.homeDir),
    agentsDir: launchAgentsDir,
    domain: launchDomain(),
    run,
    tmuxBin: findExecutable('tmux'),
  })
  if (result.message) console.log(result.message)
  return result.moved || result.message === null
}

/**
 * Compiles the small launcher the LaunchAgent runs (bin/cq-launcher.c) when it's missing or
 * its source changed. Full Disk Access is granted to it, so updating cq doesn't undo that.
 */
export function buildLauncher(): { path: string; built: boolean } | null {
  const stamp = `${launcherPath}.sha256`
  const hash = new Bun.CryptoHasher('sha256').update(launcherSource).digest('hex')
  if (existsSync(launcherPath) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
    return { path: launcherPath, built: false }
  }
  const clang = findExecutable('clang')
  if (!clang) {
    console.log(`No C compiler (install Xcode's command line tools to get one), so ${BRAND.name} runs without its launcher.`)
    return null
  }
  const source = join(paths.bin, 'cq-launcher.c')
  writeFileAtomic(source, launcherSource)
  const build = run([clang, '-O2', '-Wall', '-o', launcherPath, source])
  rmSync(source, { force: true })
  if (!build.ok) {
    console.log(`Couldn't build the launcher, so ${BRAND.name} runs without it:\n${build.out}`)
    return null
  }
  run(['codesign', '--force', '--sign', '-', '--identifier', `${LAUNCH_AGENT_LABEL}.launcher`, launcherPath])
  writeFileAtomic(stamp, hash + '\n')
  console.log(`Built the launcher (${launcherPath}).`)
  return { path: launcherPath, built: true }
}

/** Puts the cq binary at paths.binary: built from source, copied, or linked to Homebrew's. */
function placeBinary(): void {
  const binary = paths.binary
  const self = selfCommand()
  if (self.length > 1) {
    const entry = resolve(self[1]!)
    console.log(`Building ${binary} from ${entry} …`)
    const build = Bun.spawnSync([self[0]!, 'build', entry, '--compile', '--outfile', binary], { stdio: ['inherit', 'inherit', 'inherit'] })
    if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
  } else {
    const brew = homebrewLink(self[0]!)
    if (brew) {
      // `brew upgrade` swaps the version behind this link; the daemon notices and restarts.
      rmSync(binary, { force: true })
      symlinkSync(brew, binary)
      console.log(`Using Homebrew's cq (${brew}).`)
      return
    }
    if (resolve(self[0]!) !== binary) {
      const tmp = `${binary}.${process.pid}.new`
      copyFileSync(self[0]!, tmp)
      chmodSync(tmp, 0o755)
      renameSync(tmp, binary)
    }
  }
  if (!isMac) return
  const identity = process.env.CQ_SIGN_IDENTITY ?? '-'
  const sign = run(['codesign', '--force', '--sign', identity, '--identifier', LAUNCH_AGENT_LABEL, binary])
  if (!sign.ok) console.log(`codesign failed: ${sign.out}`)
}

function linkOntoPath(): void {
  const link = join(homedir(), '.local', 'bin', 'cq')
  if (!existsSync(dirname(link))) return
  try {
    const st = lstatSync(link)
    if (st.isSymbolicLink() && readlinkSync(link) === paths.binary) return
    if (!st.isSymbolicLink()) {
      console.log(`Left ${link} alone (it isn't a symlink). Add ${paths.bin} to your PATH instead.`)
      return
    }
    rmSync(link)
  } catch {
    // doesn't exist yet
  }
  symlinkSync(paths.binary, link)
  console.log(`cq is on your PATH via ${link}.`)
}

export interface InstallResult {
  program: string
  /** macOS: Full Disk Access must be granted (again): the launcher is new or its path changed. */
  needsAccess: boolean
  /** How it runs in the background ('none': you start `cq daemon` yourself). */
  service: Service['kind']
  /** False when the service manager failed to start it (not when there's no service manager). */
  started: boolean
}

export async function install(): Promise<InstallResult | null> {
  if (!migrateIfNeeded()) return null
  ensureHome()
  const svc = service()
  // Stop a running daemon first: overwriting the binary under a live process can crash it.
  svc.stop()
  placeBinary()
  linkOntoPath()
  const launcher = isMac ? buildLauncher() : null
  const program = launcher?.path ?? paths.binary
  const started = await svc.install(program)
  console.log(started.message)
  return { program, needsAccess: isMac && (!launcher || launcher.built), service: svc.kind, started: started.ok || svc.kind === 'none' }
}

/** The steps printed after `cq install` (cq setup walks through them instead). */
export function nextSteps(result: InstallResult): string {
  const config = loadConfig()
  const steps = [
    ...(result.needsAccess
      ? [
          `Give ${BRAND.name} Full Disk Access, so the Claude sessions it starts can work in your folders unattended:\n` +
            `     System Settings → Privacy & Security → Full Disk Access → + → press ⌘⇧G and enter\n     ${result.program}\n` +
            (result.program === launcherPath
              ? '     (Once only: updating later keeps this permission.)'
              : '     (Without the launcher this has to be redone after each update.)'),
          'Restart it so the permission takes effect: cq restart',
        ]
      : []),
    ...(result.service === 'none' ? [`Start it: cq daemon (see above for keeping it running${isWsl() ? ', or turn on systemd in WSL' : ''})`] : []),
    ...(config.telegram.enabled ? [] : ['Connect your phone: create a bot with @BotFather in Telegram, then run cq telegram <token>']),
    'Check everything: cq doctor',
  ]
  const intro = isMac && !result.needsAccess ? 'Full Disk Access on the launcher still applies.\n' : ''
  return `${intro}\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
}

export function uninstall(): void {
  service().uninstall()
  const link = join(homedir(), '.local', 'bin', 'cq')
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === paths.binary) rmSync(link)
  } catch {
    // no link
  }
  console.log(`Stopped ${BRAND.name} and removed it from what starts by itself. Your queue and settings stay in ${CQ_HOME}.`)
}

/** Updates a direct (non-Homebrew) install from the latest GitHub release. */
export async function update(): Promise<void> {
  const self = selfCommand()
  if (homebrewLink(self[0]!)) {
    console.log(`Installed with Homebrew: run  brew upgrade ${BRAND.formula}`)
    return
  }
  if (self.length > 1) {
    console.log('Running from source: pull the latest code, then run  bun src/cli/cq.ts install')
    return
  }
  if (!BRAND.repo) {
    console.log(`Updates will come from ${BRAND.name}'s GitHub releases once they're published.`)
    return
  }
  const res = await fetch(`https://api.github.com/repos/${BRAND.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  if (release.tag_name.replace(/^v/, '') === VERSION) {
    console.log(`Already on the latest version (${VERSION}).`)
    return
  }
  const asset = release.assets.find(a => a.name === releaseAsset())
  if (!asset) throw new Error(`release ${release.tag_name} has no build for ${process.platform} ${process.arch}`)
  const sums = release.assets.find(a => a.name === 'SHA256SUMS')
  if (!sums) throw new Error(`release ${release.tag_name} has no SHA256SUMS to check the download against`)
  const expected = checksumFor(await (await fetch(sums.browser_download_url)).text(), asset.name)
  const bytes = new Uint8Array(await (await fetch(asset.browser_download_url)).arrayBuffer())
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (!expected || actual !== expected) throw new Error(`the download of ${asset.name} doesn't match its checksum; nothing was changed`)
  // Next to the binary, so the final rename stays on one volume and is atomic.
  const tmp = `${paths.binary}.${process.pid}.download`
  writeFileSync(tmp, bytes, { mode: 0o755 })
  renameSync(tmp, paths.binary)
  console.log(`Updated to ${release.tag_name}. ${BRAND.name} restarts itself with it in a moment.`)
}

/** The release file for this computer: cq-darwin-arm64, cq-linux-x64… */
export function releaseAsset(platform: string = process.platform, arch: string = process.arch): string {
  return `cq-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

/** The SHA-256 a SHA256SUMS file (`sha256sum` format) lists for `name`. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (m && m[2] === name) return m[1]!.toLowerCase()
  }
  return null
}
