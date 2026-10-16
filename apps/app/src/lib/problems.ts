// The app's last few log lines and errors, kept in memory for a problem report (never saved, and
// sent only when you send a report, after you've seen them).

const MAX = 40
const lines: string[] = []

export function noteProblem(line: string): void {
  const t = new Date().toISOString().slice(11, 19)
  lines.push(`${t} ${line.replace(/\s+/g, ' ').slice(0, 300)}`)
  if (lines.length > MAX) lines.splice(0, lines.length - MAX)
}

export function recentProblems(): string[] {
  return [...lines]
}

/** A report's text: what you wrote, then the app's version, the platform and its recent lines. */
export function reportText(o: { text: string; app: string; platform: string; error?: Error | null; recent: string[] }): string {
  const parts = [o.text.trim()]
  if (o.error) parts.push(`Error: ${o.error.name}: ${o.error.message}\n${(o.error.stack ?? '').split('\n').slice(0, 12).join('\n')}`)
  parts.push(`App: ${o.app} on ${o.platform}`)
  if (o.recent.length > 0) parts.push(`Recent:\n${o.recent.join('\n')}`)
  return parts.filter(Boolean).join('\n\n').slice(0, 20_000)
}
