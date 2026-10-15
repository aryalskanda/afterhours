// The messages inside an encrypted session. Apps send requests; machines answer with results and
// push events. Both sides validate everything they receive.

import { z } from 'zod'

export const PROTOCOL = 1

const PeerId = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const RequestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const Text = (max: number) => z.string().max(max)

export const Role = z.enum(['owner', 'operator', 'viewer'])
export type Role = z.infer<typeof Role>

export const ExecMode = z.enum(['auto', 'acceptEdits', 'bypassPermissions', 'plan'])
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

export const MachineInfo = z.object({
  id: PeerId,
  name: Text(80),
  os: Text(40),
  arch: Text(20),
  version: Text(40),
  protocol: z.number().int(),
})
export type MachineInfo = z.infer<typeof MachineInfo>

export const DeviceInfo = z.object({
  id: PeerId,
  name: Text(80),
  platform: Text(40),
  role: Role,
  addedAt: z.number(),
  lastSeen: z.number().nullable(),
})
export type DeviceInfo = z.infer<typeof DeviceInfo>

// --- handshake payloads ---------------------------------------------------------------------

/** App → machine, inside the first handshake message. */
export const Hello = z.object({
  v: z.literal(PROTOCOL),
  /** The app and its version, e.g. "afterhours-app/0.1.0". */
  app: Text(100),
  /** What people call this device, e.g. "Skanda's iPhone". */
  name: z.string().min(1).max(80),
  platform: Text(40),
})
export type Hello = z.infer<typeof Hello>

/** Machine → app, inside the second handshake message. */
export const Welcome = z.object({
  v: z.literal(PROTOCOL),
  ok: z.boolean(),
  /** Why the machine refused: `not-paired` (removed, or never paired), `expired`, `used`… */
  error: Text(200).optional(),
  machine: MachineInfo.optional(),
  role: Role.optional(),
})
export type Welcome = z.infer<typeof Welcome>

// --- what a machine reports -----------------------------------------------------------------

export const JobInfo = z.object({
  id: z.number().int(),
  status: z.enum(['queued', 'running', 'held', 'done', 'failed', 'cancelled']),
  phase: z.enum(['launching', 'planning', 'working', 'limited', 'finishing']).nullable(),
  holdReason: z.string().nullable(),
  folder: z.string(),
  workDir: z.string().nullable(),
  prompt: z.string(),
  plan: z.boolean(),
  review: z.boolean(),
  mode: ExecMode,
  model: z.string(),
  effort: Effort,
  session: z.string().nullable(),
  branch: z.string().nullable(),
  isolate: z.boolean(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  source: z.string(),
  position: z.number(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
})
export type JobInfo = z.infer<typeof JobInfo>

export const ChatInfo = z.object({
  session: z.string(),
  folder: z.string().nullable(),
  title: z.string(),
  lastPrompt: z.string().nullable(),
  lastReply: z.string().nullable(),
  updatedAt: z.number(),
  model: z.string().nullable(),
  mode: z.string().nullable(),
  /** "VS Code", "a terminal"…: another Claude window has it open. */
  where: z.string().nullable(),
  busy: z.boolean(),
  running: z.boolean(),
  limited: z.boolean(),
})
export type ChatInfo = z.infer<typeof ChatInfo>

const Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
})

const LimitWindow = z.object({ usedPct: z.number().nullable(), resetsAt: z.number().nullable() })
export const LimitsInfo = z.object({
  fiveHour: LimitWindow.optional(),
  sevenDay: LimitWindow.optional(),
  /** No new task starts before this time (a usage limit stopped one). */
  blockedUntil: z.number().nullable().optional(),
  updatedAt: z.number().optional(),
})
export type LimitsInfo = z.infer<typeof LimitsInfo>

export const ApprovalInfo = z.object({
  code: z.string(),
  job: z.number().int(),
  kind: z.enum(['permission', 'question', 'review', 'trust']),
  payload: z.unknown(),
  createdAt: z.number(),
})
export type ApprovalInfo = z.infer<typeof ApprovalInfo>

export const PolicyInfo = z.object({
  allowedRoots: z.array(z.string()),
  allowBypass: z.boolean(),
  allowScreens: z.boolean(),
  allowTyping: z.boolean(),
})
export type PolicyInfo = z.infer<typeof PolicyInfo>

/** Mirrors the daemon's notices (src/daemon/notify.ts), with jobs and chats as plain data. */
export const Notice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), job: JobInfo }),
  z.object({ type: z.literal('plan_approved'), job: JobInfo, choice: z.string() }),
  z.object({ type: z.literal('plan_review'), job: JobInfo, code: z.string(), plan: z.string().nullable() }),
  z.object({ type: z.literal('permission'), job: JobInfo, code: z.string(), tool: z.string(), detail: z.string(), minutes: z.number() }),
  z.object({ type: z.literal('question'), job: JobInfo, code: z.string(), questions: z.array(Question), minutes: z.number() }),
  z.object({ type: z.literal('trust'), job: JobInfo, code: z.string() }),
  z.object({ type: z.literal('limit'), job: JobInfo, at: z.number().nullable(), window: z.string().optional() }),
  z.object({ type: z.literal('resumed'), job: JobInfo, how: z.enum(['claude', 'afterhours', 'you']) }),
  z.object({ type: z.literal('done'), job: JobInfo, diff: z.string().nullable(), next: JobInfo.nullable() }),
  z.object({ type: z.literal('held'), job: JobInfo, reason: z.string(), screen: z.string().optional() }),
  z.object({ type: z.literal('failed'), job: JobInfo, reason: z.string(), screen: z.string().optional() }),
  z.object({
    type: z.literal('conflict'),
    job: JobInfo,
    holder: z.string(),
    where: z.string(),
    busy: z.boolean(),
    state: z.enum(['open', 'waiting', 'stuck']),
  }),
  z.object({ type: z.literal('took_over'), job: JobInfo, where: z.string() }),
  z.object({
    type: z.literal('session_limit'),
    chat: ChatInfo,
    where: z.string(),
    at: z.number().nullable(),
    window: z.string().optional(),
    autoAt: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal('chat_continue'),
    chat: ChatInfo,
    where: z.string(),
    how: z.enum(['inbox', 'takeover', 'resume']),
    jobId: z.number().optional(),
  }),
  z.object({ type: z.literal('recovered'), job: JobInfo }),
  z.object({ type: z.literal('setup_warning'), message: z.string() }),
  z.object({ type: z.literal('empty') }),
  /** A pending approval was answered (from any app, Telegram or the terminal), or expired. */
  z.object({
    type: z.literal('resolved'),
    code: z.string(),
    job: z.number().int(),
    status: z.enum(['allowed', 'denied', 'answered', 'expired']),
    by: z.string().nullable(),
  }),
])
export type Notice = z.infer<typeof Notice>

// --- app → machine --------------------------------------------------------------------------

export const QueueOptions = z.object({
  /** Plan first. The plan is approved for you unless `review` is set. */
  plan: z.boolean().optional(),
  review: z.boolean().optional(),
  mode: ExecMode.optional(),
  model: z.string().max(40).optional(),
  effort: Effort.optional(),
  /** `continue` the folder's last conversation, start a `new` one, or continue `session`. */
  policy: z.enum(['continue', 'new', 'session']).optional(),
  session: z.string().max(64).optional(),
  /** Run on its own git branch. */
  isolate: z.boolean().optional(),
  takeover: z.boolean().optional(),
  front: z.boolean().optional(),
})
export type QueueOptions = z.infer<typeof QueueOptions>

const withId = <T extends z.ZodRawShape>(shape: T) => z.object({ id: RequestId, ...shape })

export const Request = z.discriminatedUnion('type', [
  /** Start receiving events: first the ones after `since`, then a snapshot. */
  withId({ type: z.literal('sync'), since: z.number().int().min(0).optional() }),
  withId({ type: z.literal('snapshot') }),
  withId({ type: z.literal('queue'), folder: z.string().min(1).max(4096), prompt: z.string().min(1).max(100_000), options: QueueOptions.optional() }),
  withId({ type: z.literal('answer'), code: z.string().min(1).max(32), decision: z.enum(['allow', 'deny', 'answer']), text: Text(20_000).nullable().optional() }),
  /** Acts on the running task; `job` makes sure it's still the one you meant. */
  withId({ type: z.literal('control'), action: z.enum(['go', 'pause', 'stop', 'skip', 'continue', 'fork', 'takeover']), job: z.number().int().optional() }),
  withId({ type: z.literal('job'), action: z.enum(['remove', 'top']), job: z.number().int() }),
  withId({ type: z.literal('jobs'), recent: z.number().int().min(0).max(100).optional() }),
  withId({ type: z.literal('peek'), lines: z.number().int().min(5).max(200).optional(), job: z.number().int().optional() }),
  withId({ type: z.literal('say'), text: z.string().min(1).max(20_000), job: z.number().int().optional() }),
  withId({ type: z.literal('keys'), keys: z.array(z.string().min(1).max(20)).min(1).max(20), job: z.number().int().optional() }),
  withId({ type: z.literal('chats'), folder: z.string().max(4096).optional(), page: z.number().int().min(0).max(1000).optional(), limit: z.number().int().min(1).max(50).optional() }),
  withId({ type: z.literal('chat.write'), session: z.string().min(1).max(64), text: z.string().min(1).max(100_000) }),
  withId({ type: z.literal('folders'), query: z.string().max(200) }),
  withId({ type: z.literal('devices') }),
  withId({ type: z.literal('devices.remove'), device: PeerId }),
  withId({ type: z.literal('devices.rename'), device: PeerId, name: z.string().min(1).max(80) }),
  /** The text commands (`help` lists them). Owners only. */
  withId({ type: z.literal('command'), text: z.string().min(1).max(20_000) }),
])
export type Request = z.infer<typeof Request>
export type RequestType = Request['type']

// --- machine → app --------------------------------------------------------------------------

export const Result = z.object({
  type: z.literal('result'),
  id: RequestId,
  ok: z.boolean(),
  /** A sentence for people, like the bot's replies. */
  text: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  /** `forbidden`, `policy`, `invalid`, `not-found`, `failed`. */
  code: z.string().optional(),
})
export type Result = z.infer<typeof Result>

export const Event = z.object({
  type: z.literal('event'),
  /** Increases by one per event on this machine; apps send the last one they saw when they reconnect. */
  seq: z.number().int(),
  at: z.number(),
  notice: Notice,
  /** The notice as a sentence, the way the Telegram bot words it. */
  text: z.string(),
})
export type Event = z.infer<typeof Event>

/** The queue changed (not stored; a snapshot covers what an app missed). */
export const State = z.object({
  type: z.literal('state'),
  paused: z.boolean(),
  active: JobInfo.nullable(),
  queued: z.array(JobInfo),
  limits: LimitsInfo,
})
export type State = z.infer<typeof State>

export const Snapshot = z.object({
  type: z.literal('snapshot'),
  seq: z.number().int(),
  machine: MachineInfo,
  role: Role,
  paused: z.boolean(),
  active: JobInfo.nullable(),
  queued: z.array(JobInfo),
  recent: z.array(JobInfo),
  approvals: z.array(ApprovalInfo),
  limits: LimitsInfo,
  policy: PolicyInfo,
})
export type Snapshot = z.infer<typeof Snapshot>

/** Pairing only: the machine's decision. */
export const PairResult = z.object({
  type: z.literal('pair.result'),
  ok: z.boolean(),
  error: Text(200).optional(),
  machine: MachineInfo.optional(),
  role: Role.optional(),
})
export type PairResult = z.infer<typeof PairResult>

export const MachineMessage = z.discriminatedUnion('type', [Result, Event, State, Snapshot, PairResult])
export type MachineMessage = z.infer<typeof MachineMessage>

/** Pairing only: the app proves it knows the secret by sending this over the new session. */
export const PairConfirm = z.object({ type: z.literal('pair.confirm') })
