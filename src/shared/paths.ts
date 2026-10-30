// Comparing paths. On macOS and Linux a path is compared as it is. Windows ignores case, and Claude
// Code writes one folder several ways there ("D:/Code/app" in ~/.claude.json, "d:\Code\app" in its
// session files), so paths are compared by a key: lower case, forward slashes.

const WINDOWS = process.platform === 'win32'

/** What two paths are compared by: the path itself, or on Windows its lower-case, forward-slash form. */
export function pathKey(path: string, windows = WINDOWS): string {
  if (!windows) return path
  const key = path.replace(/\\/g, '/').toLowerCase()
  return key.length > 3 ? key.replace(/\/+$/, '') : key
}

export function samePath(a: string, b: string, windows = WINDOWS): boolean {
  return pathKey(a, windows) === pathKey(b, windows)
}

/** Whether `path` is `root` or inside it. */
export function within(root: string, path: string, windows = WINDOWS): boolean {
  const r = pathKey(root, windows)
  const p = pathKey(path, windows)
  if (p === r) return true
  // Keys use forward slashes on Windows, and POSIX paths always do.
  return p.startsWith(r.endsWith('/') ? r : r + '/')
}
