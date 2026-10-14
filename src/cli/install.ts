import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import launcherSource from '../../bin/cq-launcher.c' with { type: 'text' }
import { selfCommand, VERSION } from '../daemon/main'
import { BRAND, LEGACY } from '../shared/brand'
import {
  CQ_HOME,
  ensureHome,
  findExecutable,
  LAUNCH_AGENT_LABEL,
  loadConfig,
  paths,
  searchPath,
  writeFileAtomic,
} from '../shared/config'
import { migrateLegacy } from './migrate'
import { launchDomain, run } from './util'

const agentsDir = join(homedir(), 'Library', 'LaunchAgents')
export const plistPath = join(agentsDir, `${LAUNCH_AGENT_LABEL}.plist`)
export const launcherPath = join(paths.bin, 'cq-launcher')

/** For a binary inside a Homebrew Cellar, the stable link Homebrew keeps pointing at the current version. */
export function homebrewLink(execPath: string): string | null {
  const m = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/cq$/.exec(execPath)
  if (!m) return null
  const link = join(m[1]!, 'bin', 'cq')
  return existsSync(link) ? link : null
}

/** Moves a pre-rename install over. False if it can't happen yet (a job is running). */
export function migrateIfNeeded(): boolean {
  const result = migrateLegacy({
    home: CQ_HOME,
    legacyHome: join(homedir(), LEGACY.homeDir),
    agentsDir,
    domain: launchDomain(),
    run,
    tmuxBin: findExecutable('tmux'),
  })
  if (result.message) console.log(result.message)
  return result.moved || result.message === null
}

function plist(program: string): string {
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
  /** Full Disk Access must be granted (again): the launcher is new or its path changed. */
  needsAccess: boolean
}

export async function install(): Promise<InstallResult | null> {
  if (!migrateIfNeeded()) return null
  ensureHome()
  const domain = launchDomain()
  // Stop a running daemon first: overwriting the binary under a live process can crash it.
  run(['launchctl', 'bootout', `${domain}/${LAUNCH_AGENT_LABEL}`])
  placeBinary()
  linkOntoPath()
  const launcher = buildLauncher()
  const program = launcher?.path ?? paths.binary

  mkdirSync(agentsDir, { recursive: true })
  writeFileAtomic(plistPath, plist(program))
  // launchd can still be tearing down the old instance for a moment after bootout.
  let boot = run(['launchctl', 'bootstrap', domain, plistPath])
  for (let i = 0; i < 5 && !boot.ok; i++) {
    await Bun.sleep(1000)
    boot = run(['launchctl', 'bootstrap', domain, plistPath])
  }
  console.log(boot.ok ? `Started ${BRAND.name} in the background (starts at login).` : `launchctl bootstrap failed: ${boot.out}`)
  return { program, needsAccess: !launcher || launcher.built }
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
    ...(config.telegram.enabled ? [] : ['Connect your phone: create a bot with @BotFather in Telegram, then run cq telegram <token>']),
    'Check everything: cq doctor',
  ]
  const intro = result.needsAccess ? '' : 'Full Disk Access on the launcher still applies.\n'
  return `${intro}\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
}

export function uninstall(): void {
  run(['launchctl', 'bootout', `${launchDomain()}/${LAUNCH_AGENT_LABEL}`])
  rmSync(plistPath, { force: true })
  const link = join(homedir(), '.local', 'bin', 'cq')
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === paths.binary) rmSync(link)
  } catch {
    // no link
  }
  console.log(`Stopped ${BRAND.name} and removed it from login items. Your queue and settings stay in ${CQ_HOME}.`)
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
  const asset = release.assets.find(a => a.name === `cq-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`)
  if (!asset) throw new Error(`release ${release.tag_name} has no build for this Mac`)
  // Next to the binary, so the final rename stays on one volume and is atomic.
  const tmp = `${paths.binary}.${process.pid}.download`
  writeFileSync(tmp, new Uint8Array(await (await fetch(asset.browser_download_url)).arrayBuffer()), { mode: 0o755 })
  renameSync(tmp, paths.binary)
  console.log(`Updated to ${release.tag_name}. ${BRAND.name} restarts itself with it in a moment.`)
}
