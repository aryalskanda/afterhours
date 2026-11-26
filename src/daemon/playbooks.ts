// Playbooks: a list of prompts saved under a name, each with its own folder, model and effort,
// queued all at once. Each step waits for the one before it to finish well (afterJob); if one
// fails or is cancelled, the rest don't start. Kept on the machine, so Telegram and every app
// see the same ones.

import type { Effort, ExecMode, Job, JobSpec } from '../shared/types'
import { buildSpec, parseQueueText, type CommandContext } from './commands'
import { statSync } from 'node:fs'
import type { Runner } from './runner'
import type { Store } from './store'

export interface PlaybookStep {
  folder: string
  prompt: string
  plan: boolean
  review: boolean
  mode: ExecMode
  model: string
  effort: Effort
  /** With a plan: the model and effort that carry it out. */
  workModel?: string | null
  workEffort?: Effort | null
  /** On its own git branch (unset: the machine's default). */
  isolate?: boolean
  /** A new conversation, instead of continuing the folder's last one. */
  fresh?: boolean
}

export interface Playbook {
  id: string
  name: string
  steps: PlaybookStep[]
  updatedAt: number
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const MAX_STEPS = 20
export const MAX_PLAYBOOKS = 50
const KEY = 'playbooks'

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'playbook'

export class Playbooks {
  constructor(private readonly d: { store: Store; runner: Pick<Runner, 'enqueue'>; now: () => number; log: (line: string) => void; isolate: () => boolean }) {}

  list(): Playbook[] {
    return this.d.store.kvGet<Playbook[]>(KEY) ?? []
  }

  get(idOrName: string): Playbook | null {
    const key = idOrName.trim().toLowerCase()
    return this.list().find(p => p.id === key || p.name.toLowerCase() === key) ?? null
  }

  /** Creates one, or replaces the one with that name (or id). */
  save(input: { id?: string; name: string; steps: PlaybookStep[] }): { ok: true; playbook: Playbook } | { ok: false; error: string } {
    const name = input.name.trim().replace(/\s+/g, ' ')
    if (!name) return { ok: false, error: 'A playbook needs a name.' }
    if (name.length > 60) return { ok: false, error: 'That name is too long (60 characters at most).' }
    if (input.steps.length === 0) return { ok: false, error: 'A playbook needs at least one step.' }
    if (input.steps.length > MAX_STEPS) return { ok: false, error: `A playbook has at most ${MAX_STEPS} steps.` }
    const empty = input.steps.findIndex(s => !s.prompt.trim())
    if (empty >= 0) return { ok: false, error: `Step ${empty + 1} has no prompt.` }
    const list = this.list()
    const same = list.find(p => (input.id && p.id === input.id) || p.name.toLowerCase() === name.toLowerCase())
    let id = same?.id ?? slug(name)
    for (let n = 2; !same && list.some(p => p.id === id); n++) id = `${slug(name)}-${n}`
    const playbook: Playbook = { id, name, steps: input.steps.map(s => ({ ...s, prompt: s.prompt.trim() })), updatedAt: this.d.now() }
    const others = list.filter(p => p.id !== id && p.name.toLowerCase() !== name.toLowerCase())
    if (!same && others.length >= MAX_PLAYBOOKS) return { ok: false, error: `At most ${MAX_PLAYBOOKS} playbooks: remove one first.` }
    this.d.store.kvSet(KEY, [playbook, ...others])
    this.d.log(`playbook ${id}: saved (${playbook.steps.length} step${playbook.steps.length === 1 ? '' : 's'})`)
    return { ok: true, playbook }
  }

  remove(id: string): boolean {
    const list = this.list()
    const next = list.filter(p => p.id !== id)
    if (next.length === list.length) return false
    this.d.store.kvSet(KEY, next)
    this.d.log(`playbook ${id}: removed`)
    return true
  }

  /**
   * Queues every step at once, each waiting for the one before it. `allowed` checks a step (its
   * folder, its mode) the way the device asking may queue; any refusal queues nothing.
   */
  run(id: string, o: { source: string; allowed?: (step: PlaybookStep) => string | null }): { ok: true; jobs: Job[]; text: string } | { ok: false; error: string } {
    const pb = this.get(id)
    if (!pb) return { ok: false, error: 'No such playbook.' }
    for (const [i, s] of pb.steps.entries()) {
      if (!isDir(s.folder)) return { ok: false, error: `Step ${i + 1}: the folder ${s.folder} isn't there any more.` }
      const why = o.allowed?.(s)
      if (why) return { ok: false, error: `Step ${i + 1}: ${why}` }
    }
    const group = `pb-${pb.id}-${this.d.now().toString(36)}`.slice(0, 40)
    const jobs: Job[] = []
    for (const s of pb.steps) {
      const before = jobs[jobs.length - 1]
      jobs.push(
        this.d.runner.enqueue({
          projectDir: s.folder,
          prompt: s.prompt,
          plan: s.plan,
          review: s.review,
          execMode: s.mode,
          model: s.model,
          effort: s.effort,
          workModel: s.workModel ?? null,
          workEffort: s.workEffort ?? null,
          sessionPolicy: s.fresh ? 'new' : 'continue',
          isolate: s.isolate ?? this.d.isolate(),
          afterJob: before ? before.id : null,
          group,
          source: o.source,
        }),
      )
    }
    this.d.log(`playbook ${pb.id}: queued #${jobs.map(j => j.id).join(' → #')} (from ${o.source})`)
    return { ok: true, jobs, text: `Playbook ${pb.name} queued: ${jobs.length} step${jobs.length === 1 ? '' : 's'}, #${jobs.map(j => j.id).join(' → #')}.` }
  }
}

/** A queued task's spec, as a step (what a playbook keeps of it). */
export function stepFromSpec(spec: JobSpec): PlaybookStep {
  return {
    folder: spec.projectDir,
    prompt: spec.prompt,
    plan: spec.plan,
    review: spec.review,
    mode: spec.execMode,
    model: spec.model,
    effort: spec.effort,
    workModel: spec.workModel ?? null,
    workEffort: spec.workEffort ?? null,
    isolate: spec.isolate,
    ...(spec.sessionPolicy === 'new' ? { fresh: true } : {}),
  }
}

/**
 * Steps written one per line, as a task is in Telegram: "shop sonnet high: Run the tests". The
 * folder is an alias, a path, or a folder's name (`findFolder`); left out, it's the step before's.
 * Every line must read, or none is kept.
 */
export async function parseSteps(lines: string[], ctx: CommandContext, findFolder: (name: string) => Promise<string | null>): Promise<{ steps: PlaybookStep[] } | { error: string }> {
  const steps: PlaybookStep[] = []
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim().replace(/^\d+[.)]\s*/, '')
    if (!line) continue
    const config = ctx.config()
    const parsed = parseQueueText(line, config)
    let text = line
    // "shop sonnet high: …" where shop is a folder's name, not an alias: put its path in its place.
    if (parsed.options.project === undefined) {
      const colon = line.indexOf(':')
      const head = colon > 0 ? line.slice(0, colon).trim().split(/\s+/) : []
      if (head.length > 0) {
        const path = await findFolder(head[0]!)
        if (path && !/\s/.test(path)) text = [path, ...head.slice(1)].join(' ') + line.slice(colon)
        else if (path) return { error: `Line ${i + 1}: the folder ${path} has a space in its path; give it an alias (alias <name> <path>) and use that.` }
      }
    }
    const again = parseQueueText(text, config)
    // Options before a colon were read (all of them), or it's all prompt.
    const hasOptions = again.prompt !== text.trim()
    if (!hasOptions && /^[^:\s]+(\s+[^:\s]+){0,4}:\s*\S/.test(text)) {
      return { error: `Line ${i + 1}: I don't know "${text.slice(0, text.indexOf(':')).trim()}" (a folder, model, effort or mode).` }
    }
    const previous = steps[steps.length - 1]
    if (again.options.project === undefined) {
      // No folder: the step before's. The first step names its own.
      if (!previous) return { error: `Line ${i + 1}: which folder? Start the line with it, e.g. shop sonnet high: ${again.prompt.slice(0, 30)}` }
      if (/\s/.test(previous.folder)) return { error: `Line ${i + 1}: name its folder (the one before has a space in its path; use an alias).` }
      text = hasOptions ? `${previous.folder} ${text}` : `${previous.folder}: ${text}`
    }
    const spec = buildSpec(text, ctx)
    if (typeof spec === 'string') return { error: `Line ${i + 1}: ${spec}` }
    steps.push(stepFromSpec(spec))
  }
  if (steps.length === 0) return { error: 'No steps: put one per line after the name.' }
  if (steps.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps.` }
  return { steps }
}
