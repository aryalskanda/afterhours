import { basename } from 'node:path'
import type { ExecMode, Job } from '../shared/types'

export const EXEC_LABEL: Record<ExecMode, string> = {
  auto: 'auto',
  acceptEdits: 'edits',
  bypassPermissions: 'yolo',
  plan: 'ask',
}

export function modeLabel(job: Pick<Job, 'plan' | 'review' | 'execMode'>): string {
  const exec = EXEC_LABEL[job.execMode]
  if (job.review) return `review→${exec}`
  if (job.plan) return `plan→${exec}`
  return exec
}

export function projectLabel(dir: string, aliases: Record<string, string>): string {
  const alias = Object.entries(aliases).find(([, path]) => path === dir)
  return alias ? alias[0] : basename(dir)
}

export function excerpt(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const clean = text.trim()
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean
}

export function oneLine(text: string, max: number): string {
  return excerpt(text.replace(/\s+/g, ' '), max)
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  return `${h}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function jobLine(job: Job, aliases: Record<string, string>): string {
  const session = job.sessionPolicy === 'new' ? ' · new' : job.sessionPolicy === 'session' ? ' · @' + (job.sessionId ?? '').slice(0, 8) : ''
  return `#${job.id} ${projectLabel(job.projectDir, aliases)} · ${modeLabel(job)} · ${job.model}/${job.effort}${session}${job.isolate ? ' · 🌿' : ''}`
}
