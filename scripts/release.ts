#!/usr/bin/env bun
// One command for a release on every system:
//
//   bun run release [patch|minor|major|X.Y.Z] [--dry-run] [--yes]
//
// main is protected, so a release goes through a pull request, like any change:
//   1. checks (gh signed in, the version is new, the tag is free),
//   2. a release/X.Y.Z branch that bumps `version` in package.json, in a scratch worktree (your own
//      checkout and branch are left alone), and a pull request for it,
//   3. waits for the required checks, then merges it,
//   4. tags the merge commit vX.Y.Z and pushes the tag,
//   5. watches the Release workflow, which builds macOS (arm64, x64), Linux (arm64, x64) and Windows
//      from that one tag and publishes them together with the checksums and the install scripts,
//   6. checks the release has every file, and that "latest" (what the install commands download) is it.
// Anyone who installs after that gets this version, on any system; running installs are told by
// their daemon within hours to run `cq update`.
//
// The tests run in the pull request's checks and again in the Release workflow, so they are not run
// here. Run `bun run compat` yourself first: it needs your Claude sign-in.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNewer, parseVersion } from '../src/daemon/updates'

/** Every file a release must have: the five builds, the checksums and the two install scripts. */
export const REQUIRED_ASSETS = [
  'cq-darwin-arm64',
  'cq-darwin-x64',
  'cq-linux-arm64',
  'cq-linux-x64',
  'cq-windows-x64.exe',
  'SHA256SUMS',
  'install.sh',
  'install.ps1',
]

/** The builds each listed in SHA256SUMS (the installers check their download against it). */
export const CHECKSUMMED = REQUIRED_ASSETS.filter(a => a.startsWith('cq-'))

export type Bump = 'patch' | 'minor' | 'major'

/** The version after `current`, for a bump word or an exact version; null when the choice isn't one. */
export function nextVersion(current: string, choice: string): string | null {
  const v = parseVersion(current)
  if (!v) return null
  const [major, minor, patch] = v
  if (choice === 'patch') return `${major}.${minor}.${patch + 1}`
  if (choice === 'minor') return `${major}.${minor + 1}.0`
  if (choice === 'major') return `${major + 1}.0.0`
  const exact = parseVersion(choice)
  return exact && isNewer(choice, current) ? exact.join('.') : null
}

/** The files from REQUIRED_ASSETS that `have` doesn't include. */
export function missingAssets(have: string[], required: string[] = REQUIRED_ASSETS): string[] {
  return required.filter(name => !have.includes(name))
}

/** package.json's text with only its version changed. */
export function withVersion(packageJson: string, version: string): string {
  if (!/"version":\s*"[^"]*"/.test(packageJson)) throw new Error('package.json has no version')
  return packageJson.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
}

/** The files SHA256SUMS lists (`sha256sum` format). */
export function checksummedNames(sums: string): string[] {
  return sums
    .split('\n')
    .map(line => /^[0-9a-f]{64}\s+\*?(\S+)$/i.exec(line.trim())?.[1])
    .filter((name): name is string => !!name)
}

// --- running it ---------------------------------------------------------------------------------

interface Run {
  code: number
  out: string
  err: string
}

function sh(cmd: string[], o: { cwd?: string } = {}): Run {
  const r = Bun.spawnSync(cmd, { cwd: o.cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

function must(cmd: string[], o: { cwd?: string } = {}): string {
  const r = sh(cmd, o)
  if (r.code !== 0) throw new Error(`${cmd.join(' ')} failed:\n${r.err || r.out}`)
  return r.out
}

/** A long command whose output you watch (gh run watch, gh pr checks --watch). */
function live(cmd: string[]): number {
  return Bun.spawnSync(cmd, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }).exitCode
}

const step = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`)
const say = (text: string) => console.log(`  ${text}`)

class Stop extends Error {}
const stop = (text: string): never => {
  throw new Stop(text)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry-run')
  const yes = args.includes('--yes')
  const choice = args.find(a => !a.startsWith('--'))

  step('Checking')
  if (sh(['gh', 'auth', 'status']).code !== 0) stop('gh is not signed in: run  gh auth login')
  const repo = must(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  must(['git', 'fetch', '--quiet', 'origin', 'main'])
  const current = (JSON.parse(must(['git', 'show', 'origin/main:package.json'])) as { version: string }).version
  say(`${repo}: main is at ${current}`)

  let version = choice ? nextVersion(current, choice) : null
  if (choice && !version) stop(`"${choice}" isn't patch, minor, major or a version newer than ${current}.`)
  if (!version) {
    const options = (['patch', 'minor', 'major'] as Bump[]).map(b => nextVersion(current, b)!)
    const names = ['fixes only', 'new features', 'a big change']
    console.log('\nWhich release?')
    options.forEach((v, i) => console.log(`  ${i + 1}) ${v}  ${names[i]}`))
    const answer = prompt('Number, or an exact version:')?.trim() ?? ''
    version = options[Number(answer) - 1] ?? nextVersion(current, answer) ?? stop(`"${answer}" isn't one of the choices.`)
  }
  const tag = `v${version}`
  if (sh(['git', 'tag', '-l', tag]).out) stop(`The tag ${tag} already exists here.`)
  if (must(['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) stop(`The tag ${tag} already exists on GitHub.`)
  const branch = `release/${version}`
  if (must(['git', 'ls-remote', '--heads', 'origin', branch])) stop(`The branch ${branch} already exists on GitHub: finish or delete it first.`)
  say(`This will release ${tag} for macOS, Linux and Windows.`)
  say('Have you run  bun run compat  against the newest Claude Code? It needs your Claude sign-in, so this script cannot.')
  if (dry) {
    step('Dry run: nothing changed. A real run would')
    for (const line of [
      `make ${branch} from origin/main with package.json at ${version}, and open a pull request`,
      'wait for its required checks, then merge it',
      `tag the merge commit ${tag} and push the tag`,
      `watch the Release workflow, then check ${REQUIRED_ASSETS.length} files and that "latest" is ${tag}`,
    ]) say(`- ${line}`)
    return
  }
  if (!yes && !/^y(es)?$/i.test(prompt(`Release ${tag}? [y/N]`)?.trim() ?? '')) stop('Cancelled.')

  step(`The pull request (${branch})`)
  const scratch = mkdtempSync(join(tmpdir(), 'afterhours-release-'))
  let pr = ''
  try {
    // A scratch worktree, so whatever you have checked out is untouched.
    must(['git', 'worktree', 'add', '--quiet', '-b', branch, scratch, 'origin/main'])
    const file = join(scratch, 'package.json')
    writeFileSync(file, withVersion(readFileSync(file, 'utf8'), version))
    must(['git', 'add', 'package.json'], { cwd: scratch })
    must(['git', 'commit', '--quiet', '-m', `Version ${version}`], { cwd: scratch })
    must(['git', 'push', '--quiet', '-u', 'origin', branch], { cwd: scratch })
    pr = must(['gh', 'pr', 'create', '--base', 'main', '--head', branch, '--title', `Version ${version}`, '--body', `Release ${tag}: bumps the version. The Release workflow builds every system once ${tag} is tagged.`])
    say(pr)
  } finally {
    sh(['git', 'worktree', 'remove', '--force', scratch])
    rmSync(scratch, { recursive: true, force: true })
    sh(['git', 'branch', '-D', branch])
  }

  step('Waiting for the pull request’s required checks (macOS and Ubuntu)')
  // The first moments after a push report no checks yet.
  await Bun.sleep(8000)
  let waited = live(['gh', 'pr', 'checks', pr, '--watch', '--required'])
  if (waited !== 0 && sh(['gh', 'pr', 'checks', pr, '--required']).err.includes('no required checks')) waited = live(['gh', 'pr', 'checks', pr, '--watch'])
  if (waited !== 0) stop(`A check failed. Fix it on ${branch} (${pr}); nothing was tagged. Run this again once it is merged or closed.`)

  step('Merging')
  const merged = sh(['gh', 'pr', 'merge', pr, '--merge', '--delete-branch'])
  if (merged.code !== 0) stop(`The pull request could not be merged: ${merged.err}\nMerge it yourself (${pr}), then tag:  git tag ${tag} <merge commit> && git push origin ${tag}`)
  say('Merged.')

  step(`Tagging ${tag}`)
  must(['git', 'fetch', '--quiet', 'origin', 'main'])
  const released = (JSON.parse(must(['git', 'show', 'origin/main:package.json'])) as { version: string }).version
  if (released !== version) stop(`main says ${released} after the merge, not ${version}; nothing was tagged.`)
  const commit = must(['git', 'rev-parse', 'origin/main'])
  must(['git', 'tag', '-a', tag, commit, '-m', `Afterhours ${tag}`])
  must(['git', 'push', '--quiet', 'origin', tag])
  say(`${tag} is on ${commit.slice(0, 7)}.`)

  step('The Release workflow (builds for every system and publishes)')
  let runId = ''
  for (let i = 0; i < 24 && !runId; i++) {
    runId = must(['gh', 'run', 'list', '--workflow', 'Release', '--branch', tag, '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId // empty'])
    if (!runId) await Bun.sleep(5000)
  }
  if (!runId) stop(`The Release workflow didn't start for ${tag}. Look at https://github.com/${repo}/actions`)
  if (live(['gh', 'run', 'watch', runId, '--exit-status']) !== 0) {
    stop(`The Release workflow failed: https://github.com/${repo}/actions/runs/${runId}\nThe tag ${tag} exists. Fix the cause, then delete the tag (git push origin :refs/tags/${tag}) and run this again with ${version}.`)
  }

  step('Checking the release')
  const info = JSON.parse(must(['gh', 'release', 'view', tag, '--json', 'assets,url,isDraft'])) as { assets: { name: string }[]; url: string; isDraft: boolean }
  const missing = missingAssets(info.assets.map(a => a.name))
  if (info.isDraft || missing.length > 0) stop(`The release is incomplete (${info.isDraft ? 'still a draft' : `missing ${missing.join(', ')}`}): ${info.url}`)
  say(`All ${REQUIRED_ASSETS.length} files are there.`)
  // What the install commands download: .../releases/latest/download/<file>.
  const latest = must(['gh', 'api', `repos/${repo}/releases/latest`, '-q', '.tag_name'])
  if (latest !== tag) stop(`"latest" is ${latest}, not ${tag}, so new installs would get ${latest}: ${info.url}`)
  const sums = await (await fetch(`https://github.com/${repo}/releases/latest/download/SHA256SUMS`)).text()
  const unlisted = missingAssets(checksummedNames(sums), CHECKSUMMED)
  if (unlisted.length > 0) stop(`The checksums on "latest" don't list ${unlisted.join(', ')}.`)
  say(`"latest" is ${tag}: new installs get it on macOS, Linux and Windows.`)

  console.log(`\n\x1b[32mReleased ${tag}.\x1b[0m ${info.url}\n`)
  console.log(`  macOS / Linux:  curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`)
  console.log(`  Windows:        irm https://github.com/${repo}/releases/latest/download/install.ps1 | iex`)
  console.log(`  Already installed: their daemon tells them within hours, or: cq update`)
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`\n\x1b[31m${err instanceof Stop ? err.message : err}\x1b[0m`)
    process.exit(1)
  })
}
