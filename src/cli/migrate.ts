import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LEGACY } from '../shared/brand'
import { writeFileAtomic } from '../shared/config'

export interface MigrationDeps {
  /** The new state folder (e.g. ~/.afterhours). */
  home: string
  /** Where installs from before the rename kept their state (~/.claude-queue). */
  legacyHome: string
  /** ~/Library/LaunchAgents */
  agentsDir: string
  /** launchctl domain, e.g. gui/501 */
  domain: string
  run: (argv: string[]) => { ok: boolean; out: string }
  tmuxBin: string | null
}

export type MigrationResult = { moved: true; message: string } | { moved: false; message: string | null }

/**
 * Moves a pre-rename install to the new name: stops its LaunchAgent and tmux server, moves the
 * state folder, and drops the old binaries (the launcher is rebuilt at its new path, which is
 * why Full Disk Access has to be granted once more).
 */
export function migrateLegacy(d: MigrationDeps): MigrationResult {
  if (!existsSync(d.legacyHome) || existsSync(d.home)) return { moved: false, message: null }

  const dbPath = join(d.legacyHome, 'state.db')
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true })
    try {
      const active = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('running', 'held')`).get()
      if ((active?.n ?? 0) > 0) {
        return { moved: false, message: 'A job is still running in your existing install. Let it finish (or skip it), then run this again.' }
      }
    } finally {
      db.close()
    }
  }

  d.run(['launchctl', 'bootout', `${d.domain}/${LEGACY.agentLabel}`])
  rmSync(join(d.agentsDir, `${LEGACY.agentLabel}.plist`), { force: true })
  if (d.tmuxBin) d.run([d.tmuxBin, '-L', LEGACY.tmuxSocket, 'kill-server'])

  renameSync(d.legacyHome, d.home)
  rmSync(join(d.home, 'bin'), { recursive: true, force: true })

  // Existing installs keep working in your checkout, as before; new installs default to own branches.
  const configPath = join(d.home, 'config.json')
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    if (raw.isolate === undefined) {
      raw.isolate = false
      writeFileAtomic(configPath, JSON.stringify(raw, null, 2) + '\n', 0o600)
    }
  }
  return { moved: true, message: `Moved your queue and settings from ${d.legacyHome} to ${d.home}.` }
}
