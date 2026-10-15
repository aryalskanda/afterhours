// afterhours:// links: on Windows and Linux a link that opens the app arrives in its command line
// (on the first launch, or handed over by a second one); on the Mac, as an `open-url` event.

const PREFIX = 'afterhours://'
const MAX = 4096

/** The afterhours:// link among command-line arguments, if there is one. */
export function findLink(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const link = cleanLink(arg)
    if (link) return link
  }
  return null
}

/** A link the app opens: afterhours://…, no longer than any real one, without spaces or controls. */
export function cleanLink(text: string): string | null {
  const t = text.trim()
  if (!t.toLowerCase().startsWith(PREFIX) || t.length > MAX) return null
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return null
  return PREFIX + t.slice(PREFIX.length)
}
