// A full disk loses answers quietly: Claude Code can't save its conversation (where the app and
// the bot read answers from), and Afterhours can't save a task's end. So the free space is watched,
// and you're told while it's low, before that happens.

import { statfsSync } from 'node:fs'

/** Below this, it says so: Claude's conversations and the tasks' records need room to grow. */
export const LOW_BYTES = 5 * 1024 ** 3
/** How often it looks. */
export const CHECK_EVERY_MS = 5 * 60_000
/** While it stays low, at most this often. */
const WARN_EVERY_MS = 3_600_000

/** Free space (for this user) on the disk holding `path`, in bytes; null if it can't be read. */
export function freeBytes(path: string): number | null {
  try {
    const s = statfsSync(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Whether an error is the disk being full (a file write, or SQLite). */
export function isDiskFull(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return e?.code === 'ENOSPC' || e?.code === 'SQLITE_FULL' || /ENOSPC|no space left|disk is full/i.test(String(e?.message ?? err))
}

export function gb(bytes: number): string {
  const g = bytes / 1024 ** 3
  return `${g < 10 ? g.toFixed(1) : Math.round(g)} GB`
}

export interface DiskDeps {
  /** Free bytes now, or null if unknown. */
  free(): number | null
  /** Says it where you'll see it (Telegram and the apps' feed). */
  notify(message: string): void
  /** "Mac", "PC" or "computer". */
  word: string
  now(): number
  log(line: string): void
}

export class DiskWatch {
  private warnedAt: number | null = null
  private low = false

  constructor(private readonly d: DiskDeps) {}

  /** Every few minutes; and at once when a write failed for lack of space (`full`). */
  check(o: { full?: boolean } = {}): void {
    const free = this.d.free()
    const now = this.d.now()
    const low = o.full === true || (free !== null && free < LOW_BYTES)
    if (!low) {
      if (this.low) {
        this.d.log(`disk: ${free === null ? 'space' : gb(free)} free again`)
        this.d.notify(`The ${this.d.word}'s disk has room again (${free === null ? 'enough' : gb(free)} free). Answers are saved as usual.`)
      }
      this.low = false
      this.warnedAt = null
      return
    }
    this.low = true
    if (this.warnedAt !== null && now - this.warnedAt < WARN_EVERY_MS) return
    this.warnedAt = now
    const left = free === null ? 'almost no space' : `${gb(free)} free`
    this.d.log(`disk: ${o.full ? 'full' : 'low'} (${left})`)
    this.d.notify(
      `The ${this.d.word}'s disk is ${o.full ? 'full' : 'almost full'} (${left}). When it's full, Claude can't save its conversations, ` +
        `so answers can go missing in the app and here. Free some space${this.d.word === 'Mac' ? ' (System Settings → General → Storage)' : ''}.`,
    )
  }
}
