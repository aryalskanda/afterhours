// Knowing when a newer release is out, and telling people how to get it.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from '../shared/brand'
import { paths, writeFileAtomic } from '../shared/config'

/** How often the daemon looks for a newer release. */
export const CHECK_EVERY_MS = 6 * 3600_000
/** After it starts, the daemon waits this long before the first look. */
export const FIRST_CHECK_MS = 60_000

/** For a binary inside a Homebrew Cellar, the stable link Homebrew keeps pointing at the current version. */
export function homebrewLink(execPath: string): string | null {
  const m = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/cq$/.exec(execPath)
  if (!m) return null
  const link = join(m[1]!, 'bin', 'cq')
  return existsSync(link) ? link : null
}

/** "0.10.2" or "v0.10.2" as numbers; null when it isn't a plain version. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Whether version `a` is newer than `b`, compared as numbers (0.10.0 is newer than 0.9.0). */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!
  }
  return false
}

export interface LatestRelease {
  /** The version, without the leading v. */
  version: string
  tag: string
  assets: { name: string; browser_download_url: string }[]
}

/** The newest GitHub release. Throws when GitHub can't be reached or answers with an error. */
export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  const res = await fetchImpl(`https://api.github.com/repos/${BRAND.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const release = (await res.json()) as { tag_name?: string; assets?: LatestRelease['assets'] }
  if (!release.tag_name || !parseVersion(release.tag_name)) throw new Error('GitHub sent a release without a version')
  return { version: release.tag_name.replace(/^v/, ''), tag: release.tag_name, assets: release.assets ?? [] }
}

/**
 * What to type to update this install: `cq update`, or `brew upgrade …` for Homebrew. `self` is how
 * this program was started; null when it runs from source, where there is nothing to update.
 */
export function updateCommand(self: string[]): string | null {
  if (self.length > 1) return null
  return homebrewLink(self[0]!) ? `brew upgrade ${BRAND.formula}` : 'cq update'
}

interface Saved {
  latest: string
  checkedAt: number
}

/** What the last look found, saved so the terminal can say so without going online. */
export function readSaved(file: string = paths.update): Saved | null {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    return typeof saved.latest === 'string' && parseVersion(saved.latest) ? { latest: saved.latest, checkedAt: Number(saved.checkedAt) || 0 } : null
  } catch {
    return null
  }
}

/** The newer version the last look found, or null. */
export function pendingUpdate(current: string, file: string = paths.update): string | null {
  const saved = readSaved(file)
  return saved && isNewer(saved.latest, current) ? saved.latest : null
}

/** One sentence for the terminal, or null when there is nothing to update or no way to say how. */
export function updateNotice(self: string[], current: string, file: string = paths.update): string | null {
  const latest = pendingUpdate(current, file)
  const command = updateCommand(self)
  return latest && command ? `${BRAND.name} ${latest} is out (you have ${current}). Run: ${command}` : null
}

export interface UpdateCheck {
  current: string
  command: string | null
  announced: { get(): string | undefined; set(version: string): void }
  /** Tells the owner; false when there was nobody to tell (not set up yet), so it is tried again later. */
  announce(latest: string, command: string): Promise<boolean> | boolean
  log(line: string): void
  now?: () => number
  fetch?: typeof fetch
  file?: string
}

/** One look at GitHub: saves what it finds, and announces a newer version once. Never throws. */
export async function checkForUpdate(o: UpdateCheck): Promise<void> {
  try {
    const { version } = await latestRelease(o.fetch)
    writeFileAtomic(o.file ?? paths.update, JSON.stringify({ latest: version, checkedAt: (o.now ?? Date.now)() }) + '\n')
    if (!o.command || !isNewer(version, o.current) || o.announced.get() === version) return
    if (await o.announce(version, o.command)) o.announced.set(version)
  } catch (err) {
    o.log(`update check failed: ${err instanceof Error ? err.message : err}`)
  }
}

/** Checks soon after starting, then every few hours. Returns a function that stops it. */
export function startUpdateChecks(o: UpdateCheck): () => void {
  if (process.env.CQ_NO_UPDATE_CHECK === '1' || !o.command) return () => {}
  let every: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    void checkForUpdate(o)
    every = setInterval(() => void checkForUpdate(o), CHECK_EVERY_MS)
  }, FIRST_CHECK_MS)
  return () => {
    clearTimeout(first)
    if (every) clearInterval(every)
  }
}
