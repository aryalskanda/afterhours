// Files an app may look at: inside one root (a task's folder, or a folder the machine shares with
// apps), never outside it through `..` or a symlink, and never keys, credentials or .env files.

import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { FileContent, FileEntry } from '@afterhours/protocol'

/** Biggest text file sent whole; longer ones are cut. */
export const MAX_TEXT_BYTES = 512 * 1024
/** Biggest image sent. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** Folders that hold secrets or git's internals. */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git', '.password-store', '.vault-token'])
/** Example env files are fine; real ones aren't. */
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/i

/** Whether a file or folder name is one an app must never see. */
export function isSecretName(name: string): boolean {
  if (SECRET_DIRS.has(name)) return true
  if (/^\.env(\..+)?$/i.test(name) && !ENV_EXAMPLE.test(name)) return true
  if (/\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn|asc|gpg)$/i.test(name)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)) return true
  if (/^(\.?credentials|\.git-credentials|\.netrc|\.npmrc|\.pypirc|secrets?)(\.[a-z]+)?$/i.test(name)) return true
  return false
}

/** Whether any part of a path relative to its root is secret. */
export function isSecretPath(rel: string): boolean {
  return rel.split(/[\\/]/).some(part => part !== '' && isSecretName(part))
}

function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** `rel` inside `root`, after following symlinks; null if it would leave the root or is secret. */
export function resolveInside(root: string, rel: string): { abs: string; rel: string } | null {
  const top = real(root)
  if (!top) return null
  const target = real(join(top, rel || '.'))
  if (!target) return null
  if (target !== top && !target.startsWith(top.endsWith(sep) ? top : top + sep)) return null
  // Apps get forward slashes, whatever system this is.
  const inside = relative(top, target).replace(/\\/g, '/')
  if (isSecretPath(inside)) return null
  return { abs: target, rel: inside }
}

/** A folder's entries, folders first, without secrets. */
export function listFolder(root: string, rel: string): { path: string; entries: FileEntry[] } | null {
  const at = resolveInside(root, rel)
  if (!at || !statSync(at.abs).isDirectory()) return null
  const entries: FileEntry[] = []
  for (const name of readdirSync(at.abs)) {
    if (isSecretName(name) || name === '.DS_Store') continue
    const abs = join(at.abs, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue // a broken link
    }
    const path = at.rel ? `${at.rel}/${name}` : name
    // A link that leads out of the root isn't shown at all.
    if (!resolveInside(root, path)) continue
    const kind = st.isDirectory() ? 'dir' : 'file'
    entries.push({ name, path, kind, size: kind === 'file' ? st.size : null })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return { path: at.rel, entries }
}

/** Text, an image, or "binary" for anything else. */
export function fileContent(rel: string, bytes: Uint8Array, size: number): FileContent {
  const mime = IMAGE_TYPES[extname(rel).toLowerCase()]
  if (mime) {
    if (size > MAX_IMAGE_BYTES) return { path: rel, kind: 'image', size, mime, truncated: true }
    return { path: rel, kind: 'image', size, mime, base64: Buffer.from(bytes).toString('base64'), truncated: false }
  }
  const head = bytes.subarray(0, 8000)
  if (head.includes(0)) return { path: rel, kind: 'binary', size, truncated: false }
  const truncated = size > MAX_TEXT_BYTES
  let text = new TextDecoder('utf-8', { fatal: false }).decode(truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes)
  if (truncated) text = text.slice(0, text.lastIndexOf('\n') + 1)
  return { path: rel, kind: 'text', size, text, truncated }
}

/** A file inside the root, as `fileContent` describes it. */
export function readFileInside(root: string, rel: string): FileContent | null {
  const at = resolveInside(root, rel)
  if (!at) return null
  const st = statSync(at.abs)
  if (!st.isFile()) return null
  const limit = IMAGE_TYPES[extname(at.rel).toLowerCase()] ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
  const want = Math.min(st.size, limit)
  const buf = Buffer.alloc(want)
  const fd = openSync(at.abs, 'r')
  try {
    readSync(fd, buf, 0, want, 0)
  } finally {
    closeSync(fd)
  }
  return fileContent(at.rel, buf, st.size)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'Pods', 'DerivedData', '.venv', 'venv', '__pycache__', 'target', '.gradle'])

/** File paths under the root (relative), from git when it's a repo, else a bounded walk. */
async function allFiles(root: string): Promise<string[]> {
  const proc = Bun.spawn(['git', '-C', root, 'ls-files', '-co', '--exclude-standard'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code === 0) return out.split('\n').filter(Boolean)
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || found.length > 20_000) return
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || isSecretName(name)) continue
      const rel = dir ? `${dir}/${name}` : name
      let st
      try {
        st = statSync(join(root, rel))
      } catch {
        continue
      }
      if (st.isDirectory()) walk(rel, depth + 1)
      else found.push(rel)
    }
  }
  walk('', 0)
  return found
}

/** Whether every character of `q` appears in `s` in order. */
function subsequence(q: string, s: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i]) i++
  return i === q.length
}

/** Files whose name or path matches `query`, best first: name starts, name contains, path, loose. */
export async function searchFiles(root: string, query: string, limit = 50): Promise<FileEntry[]> {
  const q = query.trim().toLowerCase()
  if (!q || !existsSync(root)) return []
  const scored: { path: string; score: number }[] = []
  for (const path of await allFiles(root)) {
    if (isSecretPath(path)) continue
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : subsequence(q, lower) ? 3 : -1
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map(s => ({ name: s.path.slice(s.path.lastIndexOf('/') + 1), path: s.path, kind: 'file' as const, size: null }))
}
