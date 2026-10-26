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
export type ExecMode = z.infer<typeof ExecMode>
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof Effort>

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
  /**
   * Inside Telegram (the Mini App), while pairing: Telegram's signed launch data, so the machine can
   * check that its bot's owner opened the link. Encrypted like everything else in the handshake.
   */
  telegram: Text(4096).optional(),
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

/** Tokens a conversation used: what Claude read (new, from cache, written to cache) and wrote. */
export const Usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() })
export type Usage = z.infer<typeof Usage>

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
  /** How full the conversation's context is (0-100), from Claude Code's status line. */
  contextPct: z.number().nullable().optional(),
  /** What Claude Code reported the session cost, when it reports one. */
  costUsd: z.number().nullable().optional(),
  /** Tokens the task's conversation used, counted from its transcript when it finished. */
  usage: Usage.nullable().optional(),
  /** Waits in the queue until then. */
  notBefore: z.number().nullable().optional(),
  /** Waits until that task has finished well. */
  afterJob: z.number().int().nullable().optional(),
  /** Queued again each day at this time (minutes after midnight, the machine's time). */
  repeatDaily: z.number().int().nullable().optional(),
  /** Stopped when it has worked this long. */
  maxMinutes: z.number().int().nullable().optional(),
  /** How long it has worked, waits for a usage limit aside. */
  activeMs: z.number().nullable().optional(),
  /** What became of its own branch: merged, discarded, a pull request's link. */
  branchNote: z.string().nullable().optional(),
  /** The names of files attached to it. */
  attachments: z.array(z.string()).nullable().optional(),
  /** Tasks queued together to compare. */
  group: z.string().nullable().optional(),
  /** Kept in its place in the queue, but not started until it's released. */
  onHold: z.boolean().optional(),
  /** Plan with `model`, work with this one: it carries out the approved plan. Null: `model` does both. */
  workModel: z.string().nullable().optional(),
  /** Plan with `effort`, work with this one: it carries out the approved plan. Null: `effort` for both. */
  workEffort: Effort.nullable().optional(),
  /** It ends with a live link: Claude publishes a claude.ai artifact showing the result. */
  wantLink: z.boolean().optional(),
  /** The live links it got (claude.ai artifacts, opened signed in), and why there's none when it failed. */
  links: z.array(z.object({ url: z.string(), title: z.string().nullable() })).nullable().optional(),
  linkNote: z.string().nullable().optional(),
  /** A task asking for a live link for an earlier one: that task. */
  linkFor: z.number().int().nullable().optional(),
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

/** A folder and what happened in it lately: tasks (the last 30 days) and recent conversations. */
export const ProjectInfo = z.object({
  path: z.string(),
  name: z.string(),
  /** When a task or a conversation there last moved. */
  lastAt: z.number(),
  tasks: z.number().int(),
  chats: z.number().int(),
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** The answer to a `projects` request. */
export const ProjectList = z.object({ projects: z.array(ProjectInfo) })
export type ProjectList = z.infer<typeof ProjectList>

/** A folder in a `folders` answer. */
export const FolderHit = z.object({
  path: z.string(),
  name: z.string(),
  isRepo: z.boolean().optional(),
  /** What it is besides a git repo: node, python, rust, go, swift or claude. */
  kind: z.string().nullable().optional(),
  /** Browsing: it has folders of its own inside. */
  hasChildren: z.boolean().optional(),
  /** Searching: where it is, from its project folder ("nacho/automate"). */
  rel: z.string().optional(),
  /** With nothing typed: `recent` (used lately) or `root` (a project folder). */
  group: z.enum(['recent', 'root']).optional(),
})
export type FolderHit = z.infer<typeof FolderHit>

/** The answer to `folders.roots` and `folders.roots.set`. */
export const FolderRoots = z.object({
  roots: z.array(z.object({ path: z.string(), name: z.string(), folders: z.number().int() })),
  /** When the folder map was last checked (ms). */
  scannedAt: z.number().nullable(),
  /** Folders that look like places for projects (several git repos inside), not yet added. */
  suggestions: z.array(z.object({ path: z.string(), name: z.string(), repos: z.number().int() })),
  home: z.string(),
  /** With `browse`: that folder's subfolders. */
  browse: z.array(FolderHit).optional(),
})
export type FolderRoots = z.infer<typeof FolderRoots>

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
  /** When it's settled for you if nobody answers (denied, or Claude decides itself). */
  expiresAt: z.number().optional(),
  /** Permissions: the tool and what it wants to do, in words. */
  tool: z.string().optional(),
  detail: z.string().optional(),
  /** Questions: all of them, with their options. */
  questions: z.array(Question).optional(),
  /** Plan reviews: the plan. */
  plan: z.string().nullable().optional(),
  /** Plan reviews: the version Claude showed before this one, when it revised it. */
  previousPlan: z.string().nullable().optional(),
  /** Folder trust: the folder. */
  folder: z.string().optional(),
  /** Permissions: Claude Code's own ways to stop asking ("Always allow npm test in this project"). */
  suggestions: z.array(z.object({ label: z.string() })).optional(),
  /** Permissions: how many times this same request was allowed before. */
  allowedBefore: z.number().int().optional(),
})
export type ApprovalInfo = z.infer<typeof ApprovalInfo>

export const PolicyInfo = z.object({
  allowedRoots: z.array(z.string()),
  allowBypass: z.boolean(),
  allowScreens: z.boolean(),
  allowTyping: z.boolean(),
  /** Owners may quit apps and sleep the Mac (missing from machines before it). */
  allowMac: z.boolean().optional(),
})
export type PolicyInfo = z.infer<typeof PolicyInfo>

/** Mirrors the daemon's notices (src/daemon/notify.ts), with jobs and chats as plain data. */
export const Notice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), job: JobInfo }),
  z.object({ type: z.literal('plan_approved'), job: JobInfo, choice: z.string() }),
  z.object({ type: z.literal('plan_review'), job: JobInfo, code: z.string(), plan: z.string().nullable(), previousPlan: z.string().nullable().optional() }),
  z.object({
    type: z.literal('permission'),
    job: JobInfo,
    code: z.string(),
    tool: z.string(),
    detail: z.string(),
    minutes: z.number(),
    suggestions: z.array(z.string()).optional(),
    allowedBefore: z.number().int().optional(),
  }),
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
  /** A task you ended (Kill): Claude and everything it started stopped. `by`: the device. */
  z.object({ type: z.literal('killed'), job: JobInfo, by: z.string().nullable() }),
  /** A live link for the task (a claude.ai artifact); `url` null: Claude didn't make one, `note` says why. */
  z.object({ type: z.literal('link'), job: JobInfo, url: z.string().nullable(), title: z.string().nullable(), note: z.string().nullable() }),
  z.object({ type: z.literal('setup_warning'), message: z.string() }),
  z.object({ type: z.literal('empty') }),
  /** The Mac is going to sleep, after quitting `quit`; `failed`: it was meant to and couldn't, and why. */
  z.object({ type: z.literal('sleeping'), by: z.string().nullable(), quit: z.array(z.string()), failed: z.string().optional() }),
  /** The machine moves to another relay: save its address (as with the snapshot's `relay`) and follow. */
  z.object({ type: z.literal('relay'), url: z.string().max(2048) }),
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
  /** With a plan: the model that carries it out once it's approved (`model` writes it). */
  workModel: z.string().max(40).optional(),
  /** With a plan: the effort that carries it out (`effort` writes the plan). */
  workEffort: Effort.optional(),
  /** End with a live link: Claude publishes a claude.ai artifact showing the result. */
  link: z.boolean().optional(),
  effort: Effort.optional(),
  /** `continue` the folder's last conversation, start a `new` one, or continue `session`. */
  policy: z.enum(['continue', 'new', 'session']).optional(),
  session: z.string().max(64).optional(),
  /** Run on its own git branch. */
  isolate: z.boolean().optional(),
  takeover: z.boolean().optional(),
  front: z.boolean().optional(),
  /** Not before this time (ms). */
  notBefore: z.number().optional(),
  /** When the 5-hour limit resets (the machine knows when). */
  atReset: z.boolean().optional(),
  /** Only after this task has finished well. */
  afterJob: z.number().int().optional(),
  /** Again every day at this time: minutes after midnight, the machine's time. */
  repeatDaily: z.number().int().min(0).max(1439).optional(),
  /** Stop it after this many minutes of work. */
  maxMinutes: z.number().int().min(1).max(1440).optional(),
  /** Files uploaded for it (the paths `upload` gave back); Claude is told to read them. */
  attachments: z.array(z.string().max(4096)).max(10).optional(),
  /** Tasks queued together to compare, e.g. the same prompt three ways. */
  group: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
})
export type QueueOptions = z.infer<typeof QueueOptions>

/**
 * What a device wants pushed to it. Pushes leave the end-to-end encryption (Expo, then Apple or
 * Google carry them), so `details` says whether they hold the request itself or only that a task
 * needs you.
 */
export const PushPrefs = z.object({
  /** Requests (permissions, questions, plans, folder trust); finished tasks; failed or stuck ones; usage limits. */
  events: z.object({ requests: z.boolean(), done: z.boolean(), failed: z.boolean(), limits: z.boolean() }),
  /** No pushes from `start` until `end` (minutes after midnight) in the device's time zone. */
  quiet: z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(0).max(1439), tz: z.string().min(1).max(64) }).nullable(),
  details: z.boolean(),
})
export type PushPrefs = z.infer<typeof PushPrefs>

const withId = <T extends z.ZodRawShape>(shape: T) => z.object({ id: RequestId, ...shape })

export const Request = z.discriminatedUnion('type', [
  /** Start receiving events: first the ones after `since`, then a snapshot. */
  withId({ type: z.literal('sync'), since: z.number().int().min(0).optional() }),
  withId({ type: z.literal('snapshot') }),
  withId({ type: z.literal('queue'), folder: z.string().min(1).max(4096), prompt: z.string().min(1).max(100_000), options: QueueOptions.optional() }),
  /**
   * `rule`: allow, and apply that one of the request's `suggestions` so Claude Code stops asking.
   * `mode`: approve a plan and work on in this mode.
   */
  withId({
    type: z.literal('answer'),
    code: z.string().min(1).max(32),
    decision: z.enum(['allow', 'deny', 'answer']),
    text: Text(20_000).nullable().optional(),
    rule: z.number().int().min(0).max(9).optional(),
    mode: ExecMode.optional(),
  }),
  /** Acts on the running task; `job` makes sure it's still the one you meant. */
  /**
   * The queue and the running task. `kill`: end task `job` now, whatever it's doing (a queued one
   * comes off the queue); `pause` also pauses the queue. `clear`: take every task off the queue
   * (the result's data says which, `{ removed }`, to put them back).
   */
  withId({
    type: z.literal('control'),
    action: z.enum(['go', 'pause', 'stop', 'skip', 'continue', 'fork', 'takeover', 'kill', 'clear']),
    job: z.number().int().optional(),
    pause: z.boolean().optional(),
  }),
  /**
   * A queued task: remove it, run it next, change it (`prompt`, `options`), move it to place `to`
   * (0 = next), `hold` it in its place without starting it, or `release` it. `restore` puts a task
   * removed in the last ten minutes back in its place.
   */
  withId({
    type: z.literal('job'),
    action: z.enum(['remove', 'top', 'edit', 'move', 'hold', 'release', 'restore']),
    job: z.number().int(),
    prompt: z.string().min(1).max(100_000).optional(),
    options: QueueOptions.optional(),
    to: z.number().int().min(0).optional(),
  }),
  /**
   * The queue and finished tasks, newest first; `more` says older ones match too. `before` (a task
   * id) pages back; `status` and `query` (words in the prompt or the answer) narrow them.
   */
  withId({
    type: z.literal('jobs'),
    recent: z.number().int().min(0).max(100).optional(),
    before: z.number().int().optional(),
    status: z.enum(['done', 'failed', 'cancelled']).optional(),
    query: z.string().max(200).optional(),
    /** Only the tasks that ran in this folder. */
    folder: z.string().max(4096).optional(),
  }),
  /** One task in full: its plan and Claude's final answer. */
  withId({ type: z.literal('task'), job: z.number().int() }),
  /** `ansi`: the screen with its colour codes (newer machines). */
  withId({ type: z.literal('peek'), lines: z.number().int().min(5).max(200).optional(), job: z.number().int().optional(), ansi: z.boolean().optional() }),
  withId({ type: z.literal('say'), text: z.string().min(1).max(20_000), job: z.number().int().optional() }),
  withId({ type: z.literal('keys'), keys: z.array(z.string().min(1).max(20)).min(1).max(20), job: z.number().int().optional() }),
  /** `query`: only conversations whose title or last messages have these words. */
  withId({
    type: z.literal('chats'),
    folder: z.string().max(4096).optional(),
    page: z.number().int().min(0).max(1000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    query: z.string().max(200).optional(),
  }),
  withId({ type: z.literal('chat.write'), session: z.string().min(1).max(64), text: z.string().min(1).max(100_000) }),
  /** Names a conversation, as Claude Code's /rename does (it shows there too). */
  withId({ type: z.literal('chat.rename'), session: z.string().min(1).max(64), title: z.string().trim().min(1).max(120) }),
  /** The folders tasks and chats were in lately, most recent first (ProjectList). */
  withId({ type: z.literal('projects'), limit: z.number().int().min(1).max(100).optional() }),
  /**
   * Folders for a task: `query` searches the project folders (nothing typed: what you used lately,
   * then the project folders); `parent` lists that folder's subfolders (browsing, always current);
   * `rescan` looks at the disk again first. The answer is a FolderHit list.
   */
  withId({ type: z.literal('folders'), query: z.string().max(200), parent: z.string().max(4096).optional(), rescan: z.boolean().optional() }),
  /** The project folders (FolderRoots), and with `browse` (owners) the folders in that folder of your home. */
  withId({ type: z.literal('folders.roots'), browse: z.string().max(4096).optional() }),
  /** Owners: add or remove a project folder (inside the home folder). */
  withId({ type: z.literal('folders.roots.set'), action: z.enum(['add', 'remove']), path: z.string().min(1).max(4096) }),
  withId({ type: z.literal('devices') }),
  withId({ type: z.literal('devices.remove'), device: PeerId }),
  withId({ type: z.literal('devices.rename'), device: PeerId, name: z.string().min(1).max(80) }),
  /** The text commands (`help` lists them). Owners only. */
  withId({ type: z.literal('command'), text: z.string().min(1).max(20_000) }),
  /**
   * A conversation, a page at a time: a task's (`job`) or any chat's (`session`). Without `before`
   * or `after`, the newest `limit` items; `before` pages back; `after` brings only what's new.
   */
  withId({
    type: z.literal('transcript'),
    job: z.number().int().optional(),
    session: z.string().max(64).optional(),
    before: z.number().int().min(0).optional(),
    after: z.number().int().min(-1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  /** What happened to a task, from the start: the notices about it. */
  withId({ type: z.literal('timeline'), job: z.number().int() }),
  /** The files a task changed; with `file`, that file's diff. */
  withId({ type: z.literal('diff'), job: z.number().int(), file: z.string().max(4096).optional() }),
  /** How the machine is: versions, uptime, disk, battery, load; for owners its last log lines. */
  withId({ type: z.literal('health') }),
  /** Owners: restart the engine (its service starts it again). */
  withId({ type: z.literal('restart') }),
  /** Claude Code on the machine: the account (owners), its MCP servers by name, and a folder's CLAUDE.md. */
  withId({ type: z.literal('claude'), folder: z.string().max(4096).optional() }),
  /** Replaces a folder's CLAUDE.md. */
  withId({ type: z.literal('claude.md'), folder: z.string().min(1).max(4096), text: z.string().max(200_000) }),
  /** The usage limits over the last week, as the machine sampled them. */
  withId({ type: z.literal('limits.history') }),
  /** Owners: what devices did here, newest first. */
  withId({ type: z.literal('audit'), limit: z.number().int().min(1).max(500).optional() }),
  /** Owners: a pairing link for another device, with its role (approved by asking for it). */
  withId({ type: z.literal('pair.offer'), role: Role }),
  /** This device's push token (an Expo push token) and what it wants pushed; `token: null` stops them. */
  withId({ type: z.literal('push.register'), token: z.string().min(10).max(200).nullable(), prefs: PushPrefs }),
  /** A problem with the app, written to the machine's app-reports log for its owner. */
  withId({ type: z.literal('report'), text: z.string().min(1).max(20_000), app: z.string().max(80), platform: z.string().max(40) }),
  /** A photo or file for a task's prompt, base64 (up to about 5 MB). Gives back its path on the machine. */
  withId({ type: z.literal('upload'), name: z.string().min(1).max(200), data: z.string().min(1).max(7_000_000) }),
  /** The slash commands and skills a folder's tasks can use, the project's and yours. */
  withId({ type: z.literal('commands'), folder: z.string().min(1).max(4096) }),
  /** A finished task's own branch: merge it into the checkout, throw it away, or open a pull request. */
  withId({ type: z.literal('branch'), job: z.number().int(), action: z.enum(['merge', 'discard', 'pr']) }),
  /** Opens a task's or a chat's conversation on the machine's screen, in VS Code. */
  withId({ type: z.literal('open'), job: z.number().int().optional(), session: z.string().max(64).optional() }),
  /**
   * A live link for task `job`: at its end if it's queued or running; if it has ended, now, in a task
   * of its own that continues its conversation and runs next (the result's data: `{ job }`).
   */
  withId({ type: z.literal('link'), job: z.number().int() }),
  /**
   * Owners, on a Mac that lets them (policy.allowMac): `status` lists the open apps and what keeps
   * the Mac awake (the result's data: MacInfo); `quit` an app by `pid` (`force` ends it without
   * asking; the data says whether it's still `open`); `sleep` now, quitting `quit` (pids) first;
   * `sleepWhenDone` (`on`): sleep once the queue is done, quitting `quit` first; `lidClosed` (`on`):
   * while tasks run, stay awake with the lid closed too.
   */
  withId({
    type: z.literal('mac'),
    action: z.enum(['status', 'quit', 'sleep', 'sleepWhenDone', 'lidClosed']),
    pid: z.number().int().optional(),
    force: z.boolean().optional(),
    on: z.boolean().optional(),
    quit: z.array(z.number().int()).max(20).optional(),
  }),
  /**
   * A task's folder (`job`) or another folder (`folder`): `path` lists a folder or, with `read`,
   * reads a file; `query` searches file names.
   */
  withId({
    type: z.literal('files'),
    job: z.number().int().optional(),
    folder: z.string().max(4096).optional(),
    path: z.string().max(4096).optional(),
    query: z.string().max(200).optional(),
    read: z.boolean().optional(),
  }),
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

/** What a new task starts with on this machine, unless the app picks otherwise. */
export const Defaults = z.object({
  plan: z.boolean(),
  review: z.boolean(),
  mode: ExecMode,
  model: z.string(),
  /** With a plan, the model that carries it out (when it isn't `model`). */
  workModel: z.string().nullable().optional(),
  effort: Effort,
  /** With a plan, the effort that carries it out (when it isn't `effort`). */
  workEffort: Effort.nullable().optional(),
  /** New conversations on their own git branch. */
  isolate: z.boolean(),
})
export type Defaults = z.infer<typeof Defaults>

/** A tool call starting or ending in the running task (not stored; the transcript has them all). */
export const Activity = z.object({
  type: z.literal('activity'),
  job: z.number().int(),
  at: z.number(),
  phase: z.enum(['start', 'end']),
  tool: z.string(),
  detail: z.string(),
})
export type Activity = z.infer<typeof Activity>

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
  defaults: Defaults.optional(),
  /** Models offered for new tasks. */
  models: z.array(z.string()).optional(),
  /** What this machine can do beyond the first version: `transcript`, `diff`… Apps hide the rest. */
  features: z.array(z.string()).optional(),
  /** The relay address this machine gives apps now (wss://…): apps keep it, so a move doesn't need pairing again. */
  relay: z.string().max(300).optional(),
})
export type Snapshot = z.infer<typeof Snapshot>

/** The answer to a `task` request. */
export const TaskDetail = z.object({
  job: JobInfo,
  plan: z.string().nullable(),
  answer: z.string().nullable(),
  /** Earlier versions of the plan, oldest first, when Claude revised it. */
  plans: z.array(z.object({ at: z.number(), text: z.string() })).optional(),
})
export type TaskDetail = z.infer<typeof TaskDetail>

/** One entry of a conversation. `i` is its place in the whole conversation; it never changes. */
export const TranscriptItem = z.discriminatedUnion('kind', [
  /** What you (or a task's prompt) said. */
  z.object({ kind: z.literal('you'), i: z.number().int(), at: z.number().nullable(), text: z.string() }),
  /** What Claude said. */
  z.object({ kind: z.literal('claude'), i: z.number().int(), at: z.number().nullable(), text: z.string() }),
  /** A tool call: what it did in one line, and an excerpt of what came back. */
  z.object({
    kind: z.literal('tool'),
    i: z.number().int(),
    at: z.number().nullable(),
    id: z.string(),
    name: z.string(),
    detail: z.string(),
    result: z.string().nullable(),
    error: z.boolean(),
  }),
  /** Something that happened to the conversation: compacted, interrupted, an API error. */
  z.object({ kind: z.literal('note'), i: z.number().int(), at: z.number().nullable(), text: z.string() }),
])
export type TranscriptItem = z.infer<typeof TranscriptItem>

/** The answer to a `transcript` request. */
export const TranscriptPage = z.object({
  session: z.string(),
  items: z.array(TranscriptItem),
  /** The first item's `i`; ask with `before` set to it for the page before. Null at the start. */
  before: z.number().int().nullable(),
  /** How many items the whole conversation has so far. */
  total: z.number().int(),
  usage: Usage,
  /** Claude Code's own totals for the conversation, when it recorded them. */
  cost: z.object({ usd: z.number(), linesAdded: z.number(), linesRemoved: z.number() }).nullable().optional(),
  updatedAt: z.number(),
})
export type TranscriptPage = z.infer<typeof TranscriptPage>

export const DiffFile = z.object({
  path: z.string(),
  /** A renamed file's old path. */
  from: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
  binary: z.boolean(),
})
export type DiffFile = z.infer<typeof DiffFile>

/** The answer to a `diff` request without `file`. */
export const DiffSummary = z.object({
  /** Where the task ran. */
  dir: z.string(),
  branch: z.string().nullable(),
  /** `exact`: the task's own changes; `since-start`: everything since it started, yours too (older tasks). */
  basis: z.enum(['exact', 'since-start', 'none']),
  files: z.array(DiffFile),
  truncated: z.boolean(),
})
export type DiffSummary = z.infer<typeof DiffSummary>

/** The answer to a `diff` request with `file`: its unified diff. */
export const FilePatch = z.object({ path: z.string(), patch: z.string(), binary: z.boolean(), truncated: z.boolean() })
export type FilePatch = z.infer<typeof FilePatch>

export const FileEntry = z.object({
  name: z.string(),
  /** Relative to the root. */
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().nullable(),
})
export type FileEntry = z.infer<typeof FileEntry>

export const FileContent = z.object({
  path: z.string(),
  kind: z.enum(['text', 'image', 'binary']),
  size: z.number(),
  text: z.string().optional(),
  /** Images: the bytes, base64. */
  base64: z.string().optional(),
  mime: z.string().optional(),
  truncated: z.boolean(),
})
export type FileContent = z.infer<typeof FileContent>

/** An app open on the Mac: a regular one, or one in the menu bar; `keepsAwake`: it holds the Mac awake. */
export const MacAppInfo = z.object({
  pid: z.number().int(),
  name: z.string(),
  bundleId: z.string().nullable(),
  kind: z.enum(['app', 'menu']),
  keepsAwake: z.boolean(),
})
export type MacAppInfo = z.infer<typeof MacAppInfo>

/** The answer to a `mac` status request. */
export const MacInfo = z.object({
  apps: z.array(MacAppInfo),
  /** Sleep is turned off (pmset disablesleep), which keep-awake apps do: it won't sleep until they quit. */
  sleepDisabled: z.boolean(),
  /** What sleeping quits first, by default (pids). */
  quitFirst: z.array(z.number().int()),
  /** Sleep once the queue is done: the apps it quits first, and what it still waits for. */
  sleepWhenDone: z.object({ on: z.boolean(), quit: z.array(z.string()), waiting: z.string().nullable() }),
  /** Seconds since someone last used the keyboard or trackpad. */
  idleSeconds: z.number().nullable(),
  /** The task that pauses while the Mac sleeps. */
  running: z.number().int().nullable(),
  /**
   * Awake with the lid closed while tasks run: the setting, whether it's set up (it takes the Mac's
   * password once, at the Mac), and whether sleep is off for tasks now. Missing from older machines.
   */
  lidClosed: z.object({ on: z.boolean(), ready: z.boolean(), holding: z.boolean() }).optional(),
})
export type MacInfo = z.infer<typeof MacInfo>

/** The answer to a `health` request. */
export const HealthInfo = z.object({
  version: z.string(),
  uptimeSec: z.number(),
  claudeVersion: z.string().nullable(),
  os: z.string(),
  diskFreeBytes: z.number().nullable(),
  diskTotalBytes: z.number().nullable(),
  battery: z.object({ pct: z.number(), charging: z.boolean() }).nullable(),
  /** The 1-minute load average per CPU (1 = busy). */
  load: z.number().nullable(),
  /** Owners: the engine's last log lines (prompts are never logged). */
  logs: z.array(z.string()).optional(),
})
export type HealthInfo = z.infer<typeof HealthInfo>

/** The answer to a `claude` request. */
export const ClaudeInfo = z.object({
  version: z.string().nullable(),
  /** Owners only. */
  account: z.object({ email: z.string().nullable(), organization: z.string().nullable() }).nullable().optional(),
  /** By name only: their commands, URLs and keys stay on the machine. */
  mcp: z.array(z.object({ name: z.string(), scope: z.enum(['user', 'project', 'local']), type: z.string() })),
  memory: z.object({ path: z.string(), exists: z.boolean(), text: z.string().optional() }).nullable(),
})
export type ClaudeInfo = z.infer<typeof ClaudeInfo>

export const LimitSample = z.object({ at: z.number(), fiveHour: z.number().nullable(), sevenDay: z.number().nullable() })
export type LimitSample = z.infer<typeof LimitSample>

export const AuditEntryInfo = z.object({ at: z.number(), device: z.string().nullable(), action: z.string(), detail: z.string().nullable(), ok: z.boolean() })
export type AuditEntryInfo = z.infer<typeof AuditEntryInfo>

/** One of the answers to a `commands` request. */
export const SlashCommand = z.object({
  /** Typed after the slash: `review`, `frontend:component`. */
  name: z.string(),
  description: z.string(),
  scope: z.enum(['project', 'user']),
  kind: z.enum(['command', 'skill']),
})
export type SlashCommand = z.infer<typeof SlashCommand>

/** The answer to a `files` request: a folder's entries, search hits, or a file. */
export const FilesResult = z.object({
  root: z.string(),
  path: z.string(),
  entries: z.array(FileEntry).optional(),
  file: FileContent.optional(),
})
export type FilesResult = z.infer<typeof FilesResult>

/** Pairing only: the machine's decision. */
export const PairResult = z.object({
  type: z.literal('pair.result'),
  ok: z.boolean(),
  error: Text(200).optional(),
  machine: MachineInfo.optional(),
  role: Role.optional(),
})
export type PairResult = z.infer<typeof PairResult>

export const MachineMessage = z.discriminatedUnion('type', [Result, Event, State, Snapshot, PairResult, Activity])
export type MachineMessage = z.infer<typeof MachineMessage>

/** Pairing only: the app proves it knows the secret by sending this over the new session. */
export const PairConfirm = z.object({ type: z.literal('pair.confirm') })
