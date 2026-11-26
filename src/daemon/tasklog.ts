// A task's log, for View log: what the engine wrote about it (cqd.log never holds prompts), newest
// last. Read from the end of the log, so a big log costs little.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** How much of the end of the log is read. */
const TAIL_BYTES = 2 * 1024 * 1024

/** The log's lines about task `id` ("#12: …", "launched #12: …", "notice held: ⚠️ #12 …"), the last `max`. */
export function taskLogLines(logPath: string, id: number, max = 40): string[] {
  let text = ''
  try {
    const fd = openSync(logPath, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const mine = new RegExp(`#${id}(?![0-9])`)
  return text
    .split('\n')
    .filter(l => mine.test(l))
    .map(l => l.replace(/ ⏎ /g, ' · '))
    .map(l => (l.length > 300 ? `${l.slice(0, 299)}…` : l))
    .slice(-max)
}
