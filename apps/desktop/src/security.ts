// What the app's window may load, run, open and ask for. Pure, so it's tested without Electron.

export const APP_SCHEME = 'app'
export const APP_HOST = 'afterhours'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_URL = `${APP_ORIGIN}/`

/**
 * Everything comes from the app itself. Inline styles: react-native-web writes its styles at run
 * time. Connections: the relays, over ws:// or wss:// (what travels over them is end-to-end
 * encrypted either way). No eval, plugins, frames or forms.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ')

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** A page of the app itself. */
export function isAppUrl(url: string): boolean {
  const u = parse(url)
  return u !== null && u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST
}

/** A link that may open in the default browser: web pages only, nothing that runs or reads files. */
export function isSafeExternal(url: string): boolean {
  const u = parse(url)
  return u !== null && (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === ''
}

/**
 * Notifications; the clipboard, for pasting a pairing link; and reaching a relay on this computer
 * or the local network. Nothing else: no camera, microphone, location or devices.
 */
const ALLOWED = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'local-network-access', 'local-network', 'loopback-network'])

export function allowPermission(permission: string, requestingUrl: string): boolean {
  return ALLOWED.has(permission) && isAppUrl(requestingUrl)
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentType(path: string): string {
  const dot = path.lastIndexOf('.')
  return (dot >= 0 && TYPES[path.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

/**
 * The file under `root` that an app:// URL names, or null for one outside it. Unknown paths are
 * the app's own routes (/inbox, /machine/…): the caller serves index.html for those.
 */
export function fileFor(url: string, root: string, sep = '/'): string | null {
  const u = parse(url)
  if (!u || u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null
  let path: string
  try {
    path = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  const parts: string[] = []
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..' || part.includes('\0') || /^[A-Za-z]:$/.test(part)) return null
    parts.push(part)
  }
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root
  return parts.length === 0 ? base : [base, ...parts].join(sep)
}
