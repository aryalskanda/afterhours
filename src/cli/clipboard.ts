// The Telegram bot token without copy-paste trouble: after you copy it in Telegram, setup reads it
// from the clipboard, and opens BotFather for you. Both are conveniences: typing still works.

import { isMac, isWindows, isWsl } from '../platform/os'

/** A bot token (123456789:AAH4…) found anywhere in `text`, or null. */
export function findToken(text: string): string | null {
  return /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.exec(text)?.[0] ?? null
}

/** "123456789:AAH4…xyz" → "123456789:AAH4…xyz" with the middle hidden. */
export function maskToken(token: string): string {
  const [id, secret = ''] = token.split(':')
  return `${id}:${secret.slice(0, 4)}…${secret.slice(-3)}`
}

function out(argv: string[]): string {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString() : ''
  } catch {
    return ''
  }
}

/** What's on the clipboard, as text ('' when it can't be read here). */
export function readClipboard(): string {
  if (isMac) return out(['pbpaste'])
  if (isWindows || isWsl()) return out([Bun.which('powershell.exe') ?? 'powershell.exe', '-NoProfile', '-Command', 'Get-Clipboard'])
  if (Bun.which('wl-paste')) return out(['wl-paste', '--no-newline'])
  if (Bun.which('xclip')) return out(['xclip', '-selection', 'clipboard', '-o'])
  if (Bun.which('xsel')) return out(['xsel', '--clipboard', '--output'])
  return ''
}

/** Opens a link in the person's browser (Telegram, for t.me links); false if nothing could. */
export function openLink(url: string): boolean {
  const argv = isMac
    ? ['open', url]
    : isWindows
      ? ['cmd.exe', '/c', 'start', '', url]
      : isWsl()
        ? [Bun.which('powershell.exe') ?? 'powershell.exe', '-NoProfile', '-Command', `Start-Process '${url}'`]
        : Bun.which('xdg-open')
          ? ['xdg-open', url]
          : null
  if (!argv) return false
  try {
    return Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).exitCode === 0
  } catch {
    return false
  }
}
