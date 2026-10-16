// Photos and files an app attaches to a task: kept under the uploads folder for 14 days, and named
// in the task's first prompt so Claude reads them. The task's session may read that folder.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Biggest upload, after base64 decoding. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const KEEP_MS = 14 * 86_400_000

/** "Screen Shot 2026-10-16 at 9.41.png" → "Screen-Shot-2026-10-16-at-9.41.png" (no path, no oddities). */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-80)
  return clean || 'file'
}

/** Saves an upload; gives back its path, or why not. */
export function saveUpload(dir: string, name: string, base64: string, now: number): { path: string } | { error: string } {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) return { error: 'The file is empty.' }
  if (bytes.length > MAX_UPLOAD_BYTES) return { error: 'The file is bigger than 5 MB.' }
  const day = new Date(now).toISOString().slice(0, 10)
  const folder = join(dir, day)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, `${randomBytes(4).toString('hex')}-${safeName(name)}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return { path }
}

/** Whether `path` is an upload that's still there (and not something else on the machine). */
export function isUpload(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir)
    const p = realpathSync(resolve(path))
    return p.startsWith(root + sep) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** Removes the days of uploads older than 14 days. */
export function pruneUploads(dir: string, now: number): void {
  if (!existsSync(dir)) return
  for (const day of readdirSync(dir)) {
    const t = Date.parse(`${day}T00:00:00Z`)
    if (Number.isFinite(t) && now - t > KEEP_MS) rmSync(join(dir, day), { recursive: true, force: true })
  }
}

/** What the first prompt of a task with attachments ends with. */
export function withAttachments(prompt: string, files: string[] | null): string {
  if (!files?.length) return prompt
  return `${prompt}\n\nAttached from the phone (read ${files.length === 1 ? 'it' : 'them'}):\n${files.map(f => `- ${f}`).join('\n')}`
}
