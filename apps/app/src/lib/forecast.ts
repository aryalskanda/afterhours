// The usage limits over time: bars for a chart, and when a limit runs out at the pace it's going.
// From the samples a machine keeps (each time a limit moved, and every ten minutes while it works).

import type { LimitSample } from '@afterhours/protocol'
import { clock } from './format'

export type LimitWindow = 'fiveHour' | 'sevenDay'

export interface Forecast {
  /** Points of the limit used per hour lately; null when there's too little to tell. */
  perHour: number | null
  /** When it reaches 100% at that pace, if that comes before it resets. */
  fullAt: number | null
}

/** How far back the pace is measured, and the least it needs to say anything. */
const LOOK_BACK: Record<LimitWindow, number> = { fiveHour: 60 * 60_000, sevenDay: 24 * 3_600_000 }
const MIN_SPAN: Record<LimitWindow, number> = { fiveHour: 10 * 60_000, sevenDay: 2 * 3_600_000 }

function points(samples: LimitSample[], w: LimitWindow): { at: number; v: number }[] {
  return samples
    .filter(s => s[w] !== null)
    .map(s => ({ at: s.at, v: s[w] as number }))
    .sort((a, b) => a.at - b.at)
}

/**
 * The pace over the last hour (5-hour limit) or day (weekly), since the limit last reset, up to
 * what the machine says now.
 */
export function forecast(samples: LimitSample[], w: LimitWindow, now: number, current?: { usedPct: number | null; resetsAt: number | null }): Forecast {
  const pts = points(samples, w)
  // A drop is a reset: only what came after it counts.
  let start = 0
  for (let i = 1; i < pts.length; i++) if (pts[i]!.v < pts[i - 1]!.v - 5) start = i
  const recent = pts.slice(start).filter(p => p.at >= now - LOOK_BACK[w] && p.at <= now)
  const used = current?.usedPct ?? recent.at(-1)?.v ?? null
  const first = recent[0]
  if (!first || used === null || now - first.at < MIN_SPAN[w] || used < first.v - 5) return { perHour: null, fullAt: null }
  const perMs = Math.max(0, used - first.v) / (now - first.at)
  const perHour = Math.round(perMs * 3_600_000 * 10) / 10
  if (perMs <= 0 || used >= 100) return { perHour, fullAt: null }
  const fullAt = Math.round(now + (100 - used) / perMs)
  const resetsAt = current?.resetsAt ?? null
  return { perHour, fullAt: resetsAt && fullAt >= resetsAt ? null : fullAt }
}

/** The forecast in a line: "At this rate you reach it at 3:40 pm." */
export function forecastLabel(f: Forecast, resetsAt: number | null, now: number): string | null {
  if (f.fullAt) return `At this rate you reach it at ${clock(f.fullAt, now)}.`
  if (f.perHour === null) return null
  if (f.perHour === 0) return 'Not used lately.'
  return resetsAt && resetsAt > now ? `At this rate it lasts until it resets at ${clock(resetsAt, now)}.` : 'At this rate it lasts.'
}

/** The highest use in each of `n` equal slices from `from` to `to`; null where nothing was sampled. */
export function usageBars(samples: LimitSample[], w: LimitWindow, from: number, to: number, n: number): (number | null)[] {
  const bars: (number | null)[] = Array.from({ length: n }, () => null)
  const size = (to - from) / n
  for (const p of points(samples, w)) {
    if (p.at < from || p.at >= to) continue
    const i = Math.min(n - 1, Math.floor((p.at - from) / size))
    bars[i] = Math.max(bars[i] ?? 0, p.v)
  }
  return bars
}
