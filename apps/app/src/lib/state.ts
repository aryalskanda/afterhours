// What the app knows about each machine, and how a snapshot, a queue change or an event changes
// it. Pure functions: the hub calls them, tests call them, React only reads the result.

import type { ApprovalInfo, Defaults, Event, JobInfo, LimitsInfo, MachineInfo, MachineStatus, Notice, PolicyInfo, Role, Snapshot, State } from '@afterhours/protocol'

/** A paired machine, as kept on this device. */
export interface SavedMachine {
  id: string
  name: string
  relay: string
  role: Role | null
  /** The last event seen: the machine replays what came after it. */
  lastSeq: number
  addedAt: number
}

export interface MachineState extends SavedMachine {
  status: MachineStatus
  /** Why the machine refused this device, when it did. */
  statusDetail?: string
  info: MachineInfo | null
  /** A snapshot arrived since the app started: the queue and requests below are real. */
  synced: boolean
  paused: boolean
  active: JobInfo | null
  queued: JobInfo[]
  recent: JobInfo[]
  approvals: ApprovalInfo[]
  limits: LimitsInfo
  policy: PolicyInfo | null
  defaults: Defaults | null
  models: string[]
  /** The newest events, oldest first. */
  events: Event[]
}

const MAX_EVENTS = 400
const MAX_RECENT = 25

export function machineState(saved: SavedMachine): MachineState {
  return {
    ...saved,
    status: 'connecting',
    info: null,
    synced: false,
    paused: false,
    active: null,
    queued: [],
    recent: [],
    approvals: [],
    limits: {},
    policy: null,
    defaults: null,
    models: [],
    events: [],
  }
}

export function saved(m: MachineState): SavedMachine {
  return { id: m.id, name: m.name, relay: m.relay, role: m.role, lastSeq: m.lastSeq, addedAt: m.addedAt }
}

export function withStatus(m: MachineState, status: MachineStatus, detail?: string): MachineState {
  return { ...m, status, statusDetail: status === 'refused' ? detail : undefined }
}

export function applySnapshot(m: MachineState, s: Snapshot): MachineState {
  return {
    ...m,
    name: s.machine.name,
    info: s.machine,
    role: s.role,
    synced: true,
    paused: s.paused,
    active: s.active,
    queued: s.queued,
    recent: s.recent.slice(0, MAX_RECENT),
    approvals: s.approvals,
    limits: s.limits,
    policy: s.policy,
    defaults: s.defaults ?? m.defaults,
    models: s.models ?? m.models,
    lastSeq: Math.max(m.lastSeq, s.seq),
  }
}

export function applyState(m: MachineState, s: State): MachineState {
  return { ...m, paused: s.paused, active: s.active, queued: s.queued, limits: s.limits }
}

/** A request, as the event announcing it describes it (when no snapshot has listed it yet). */
export function approvalFromNotice(n: Notice, at: number): ApprovalInfo | null {
  const minutes = 'minutes' in n ? n.minutes : 15
  const base = { createdAt: at, expiresAt: at + minutes * 60_000, payload: null }
  switch (n.type) {
    case 'permission':
      return { ...base, code: n.code, job: n.job.id, kind: 'permission', tool: n.tool, detail: n.detail }
    case 'question':
      return { ...base, code: n.code, job: n.job.id, kind: 'question', questions: n.questions }
    case 'plan_review':
      return { ...base, code: n.code, job: n.job.id, kind: 'review', plan: n.plan, expiresAt: undefined }
    case 'trust':
      return { ...base, code: n.code, job: n.job.id, kind: 'trust', folder: n.job.folder }
    default:
      return null
  }
}

export function applyEvent(m: MachineState, e: Event): MachineState {
  if (m.events.some(x => x.seq === e.seq)) return m
  const events = [...m.events, e].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS)
  const next: MachineState = { ...m, events, lastSeq: Math.max(m.lastSeq, e.seq) }
  const n = e.notice
  const fresh = approvalFromNotice(n, e.at)
  if (fresh && !next.approvals.some(a => a.code === fresh.code)) next.approvals = [...next.approvals, fresh]
  if (n.type === 'resolved') next.approvals = next.approvals.filter(a => a.code !== n.code)
  if (n.type === 'started' && (!next.active || next.active.id === n.job.id)) next.active = n.job
  if (n.type === 'done' || n.type === 'failed') {
    next.recent = [n.job, ...next.recent.filter(j => j.id !== n.job.id)].slice(0, MAX_RECENT)
    if (next.active?.id === n.job.id && n.type === 'done') next.active = null
  }
  return next
}

export interface Need {
  machine: MachineState
  approval: ApprovalInfo
  job: JobInfo | null
}

/** Everything waiting on you, across machines: what's settled for you soonest comes first. */
export function needsYou(machines: MachineState[]): Need[] {
  const all = machines.flatMap(machine => machine.approvals.map(approval => ({ machine, approval, job: findJob(machine, approval.job) })))
  return all.sort((a, b) => (a.approval.expiresAt ?? Infinity) - (b.approval.expiresAt ?? Infinity) || a.approval.createdAt - b.approval.createdAt)
}

export function findJob(m: MachineState, id: number): JobInfo | null {
  if (m.active?.id === id) return m.active
  return m.queued.find(j => j.id === id) ?? m.recent.find(j => j.id === id) ?? lastSeenJob(m, id)
}

function lastSeenJob(m: MachineState, id: number): JobInfo | null {
  for (let i = m.events.length - 1; i >= 0; i--) {
    const n = m.events[i]!.notice
    if ('job' in n && typeof n.job === 'object' && n.job && n.job.id === id) return n.job
  }
  return null
}

/** A task's events, oldest first. */
export function timeline(m: MachineState, jobId: number): Event[] {
  return m.events.filter(e => {
    const n = e.notice
    if (n.type === 'resolved') return n.job === jobId
    return 'job' in n && typeof n.job === 'object' && n.job?.id === jobId
  })
}

/** Notices worth a banner when they arrive live. */
export function wantsAttention(n: Notice): boolean {
  return ['permission', 'question', 'plan_review', 'trust', 'held', 'failed', 'conflict', 'setup_warning'].includes(n.type)
}
