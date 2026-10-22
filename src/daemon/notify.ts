import { BRAND } from '../shared/brand'
import type { Job } from '../shared/types'
import { duration, excerpt, jobLine, oneLine, projectLabel } from './format'
import { formatClock, windowLabel } from './limits'
import type { Conversation } from './sessions'

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

// One wording for answers, shared with the apps.
export { describeAnswers, type QuestionAnswer } from '@afterhours/protocol'

export type Notice =
  | { type: 'started'; job: Job }
  | { type: 'plan_approved'; job: Job; choice: string }
  | { type: 'plan_review'; job: Job; code: string }
  | {
      type: 'permission'
      job: Job
      code: string
      tool: string
      detail: string
      minutes: number
      /** Claude Code's ways to stop asking, in words; the app may apply one. */
      suggestions?: string[]
      /** How many times this same request was allowed before. */
      allowedBefore?: number
    }
  | { type: 'question'; job: Job; code: string; questions: Question[]; minutes: number }
  | { type: 'trust'; job: Job; code: string }
  | { type: 'limit'; job: Job; at: number | null; window?: string }
  /** Running again after a usage limit; `how` = who restarted it. */
  | { type: 'resumed'; job: Job; how: 'claude' | 'afterhours' | 'you' }
  | { type: 'done'; job: Job; diff: string | null; next: Job | null }
  | { type: 'held'; job: Job; reason: string; screen?: string }
  | { type: 'failed'; job: Job; reason: string; screen?: string }
  /**
   * The job's conversation is open in another Claude window. `open`: it waits for you to close it
   * (or take it over); `waiting`: you asked to take it over, once that window finishes its turn;
   * `stuck`: it was asked to close and didn't.
   */
  | { type: 'conflict'; job: Job; holder: string; where: string; busy: boolean; state: 'open' | 'waiting' | 'stuck' }
  | { type: 'took_over'; job: Job; where: string }
  /** One of your other chats (VS Code, a terminal) stopped on a usage limit; `autoAt` = when it's continued. */
  | { type: 'session_limit'; chat: Conversation; where: string; at: number | null; window?: string; autoAt?: number | null }
  /**
   * That chat was continued at the reset: `inbox` = continue posted into the open chat; `takeover` =
   * it didn't restart, so job `jobId` continues it here; `resume` = it was closed, so a job resumes it.
   */
  | { type: 'chat_continue'; chat: Conversation; where: string; how: 'inbox' | 'takeover' | 'resume'; jobId?: number }
  /** The task's window was gone (the Mac restarted, or tmux stopped), so it was started again. */
  | { type: 'recovered'; job: Job }
  /** You ended a task (Kill, Skip): Claude and everything it started stopped. `by`: which device. */
  | { type: 'killed'; job: Job; by: string | null }
  /** Something in the setup needs you (shown once a day at most). */
  | { type: 'setup_warning'; message: string }
  | { type: 'empty' }

const IMPORTANT = new Set<Notice['type']>([
  'plan_review',
  'permission',
  'question',
  'trust',
  'limit',
  'done',
  'held',
  'failed',
  'conflict',
  'took_over',
  'session_limit',
  'chat_continue',
  'recovered',
  'setup_warning',
  'empty',
])

export type NotifyLevel = 'all' | 'important' | 'off'
/** Gets the plain-text version and the notice itself (Telegram draws its own buttons from it). */
export type Sink = (text: string, notice: Notice) => void | Promise<void>

export interface NotifierOptions {
  level: () => NotifyLevel
  aliases: () => Record<string, string>
  now: () => number
  log: (line: string) => void
}

export class Notifier {
  private sinks: { sink: Sink; unfiltered: boolean }[] = []

  constructor(private o: NotifierOptions) {}

  /** `unfiltered`: gets every notice whatever the notify level (the apps choose what to show). */
  addSink(sink: Sink, o: { unfiltered?: boolean } = {}): void {
    this.sinks.push({ sink, unfiltered: o.unfiltered ?? false })
  }

  send(notice: Notice): void {
    const text = formatNotice(notice, this.o.aliases(), this.o.now())
    this.o.log(`notice ${notice.type}: ${text.replace(/\n/g, ' ⏎ ')}`)
    const level = this.o.level()
    const filtered = level === 'off' || (level === 'important' && !IMPORTANT.has(notice.type))
    for (const { sink, unfiltered } of this.sinks) {
      if (filtered && !unfiltered) continue
      Promise.resolve()
        .then(() => sink(text, notice))
        .catch(err => this.o.log(`notify sink failed: ${err}`))
    }
  }
}

/** Who restarted a task after a usage limit, in words. */
export function resumedBy(how: 'claude' | 'afterhours' | 'you'): string {
  return how === 'claude' ? 'Claude Code continued it' : how === 'afterhours' ? `${BRAND.name} typed continue` : 'you typed into it'
}

export function permissionDetail(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Bash' && typeof i.command === 'string') {
    return typeof i.description === 'string' ? `${i.command}\n(${i.description})` : i.command
  }
  if (typeof i.file_path === 'string') return i.file_path
  if (typeof i.url === 'string') return i.url
  return JSON.stringify(i)
}

function formatQuestions(questions: Question[]): string {
  return questions
    .map((q, qi) => {
      const opts = (q.options ?? []).map((o, oi) => `${String.fromCharCode(97 + oi)}) ${o.label}`).join('  ')
      return `${qi + 1}. ${q.question}${opts ? `\n   ${opts}` : ''}`
    })
    .join('\n')
}

export function formatNotice(n: Notice, aliases: Record<string, string>, now: number): string {
  switch (n.type) {
    case 'started':
      return `▶️ ${jobLine(n.job, aliases)}\n“${oneLine(n.job.prompt, 140)}”`
    case 'plan_approved':
      return `📝 #${n.job.id} plan approved (${n.choice}):\n${excerpt(n.job.planText, 700)}`
    case 'plan_review':
      return (
        `📝 #${n.job.id} plan ready for review:\n${excerpt(n.job.planText, 1500)}\n\n` +
        `Reply y ${n.code} to approve, or n ${n.code} <what to change>`
      )
    case 'permission':
      return (
        `🔐 #${n.job.id} wants to use ${n.tool}:\n${excerpt(n.detail, 400)}\n` +
        `Reply y ${n.code} or n ${n.code} (denied automatically in ${n.minutes}m)`
      )
    case 'question':
      return (
        `❓ #${n.job.id} asks:\n${formatQuestions(n.questions)}\n` +
        `Reply a ${n.code} <answer>, e.g. a ${n.code} 1a (Claude decides itself in ${n.minutes}m)`
      )
    case 'trust':
      return (
        `🔐 #${n.job.id} is the first Claude Code run in ${n.job.projectDir}.\n` +
        `Claude asks whether to trust this folder. Reply y ${n.code} to trust it, or n ${n.code} to cancel the job.`
      )
    case 'limit': {
      const when = n.at ? `resets ${formatClock(n.at, now)}` : 'reset time unknown, retrying every 15m'
      return `⏸ #${n.job.id} hit the ${windowLabel(n.window)} · ${when} · it will continue on its own (reply go to try now)`
    }
    case 'resumed':
      return `▶️ #${n.job.id} continued after the limit reset (${resumedBy(n.how)})`
    case 'done': {
      const took = n.job.startedAt ? ` in ${duration((n.job.finishedAt ?? now) - n.job.startedAt)}` : ''
      const diff = n.diff ? `\n${n.diff}` : ''
      const branch = n.job.branch ? `\n🌿 On branch ${n.job.branch} (git merge ${n.job.branch})` : ''
      const last = n.job.lastMessage ? `\n${excerpt(n.job.lastMessage, 500)}` : ''
      const next = n.next ? `\nNext: ${jobLine(n.next, aliases)}` : '\nQueue empty.'
      return `✅ #${n.job.id} done${took} · ${projectLabel(n.job.projectDir, aliases)}${diff}${branch}${last}${next}`
    }
    case 'held':
      return (
        `⚠️ #${n.job.id} paused: ${n.reason}${n.screen ? `\n---\n${n.screen}\n---` : ''}\n` +
        `Reply go to retry, skip to drop it, peek to look, or keys <keys> to press keys.`
      )
    case 'failed':
      return `❌ #${n.job.id} failed: ${n.reason}${n.screen ? `\n---\n${n.screen}\n---` : ''}\nReply go to retry or skip to move on.`
    case 'conflict':
      if (n.state === 'waiting') {
        return `⏳ #${n.job.id} waits for its conversation to finish its turn in ${n.where} (${n.holder}), then takes it over.`
      }
      return (
        `⚠️ #${n.job.id} is waiting: its conversation is open in ${n.where} (${n.holder})` +
        `${n.state === 'stuck' ? " and didn't close when asked" : n.busy ? ' and working' : ''}.\n` +
        `It starts by itself once you close it there. Reply take to close it there and continue here, or fork to continue in a copy.`
      )
    case 'took_over':
      return `🤝 #${n.job.id} took its conversation over from ${n.where} (closed it there). Reopen it there later to see everything.`
    case 'session_limit': {
      const when = n.at ? ` · resets ${formatClock(n.at, now)}` : ''
      const where = n.chat.cwd ? ` (${projectLabel(n.chat.cwd, aliases)})` : ''
      const head = `⏸ Your chat “${oneLine(n.chat.title, 80)}”${where} in ${n.where} hit the ${windowLabel(n.window)}${when}.`
      if (n.autoAt) return `${head}\nI'll tell it to continue at ${formatClock(n.autoAt, now)}, so it carries on in ${n.where}.`
      return `${head}\nReply q @${n.chat.sessionId.slice(0, 8)} take: continue to continue it here after the reset.`
    }
    case 'chat_continue': {
      const name = `“${oneLine(n.chat.title, 80)}”`
      if (n.how === 'inbox') return `▶️ The usage limit reset: I told your chat ${name} in ${n.where} to continue.`
      if (n.how === 'takeover') return `🤝 Your chat ${name} didn't restart in ${n.where}, so #${n.jobId} continues it here (closing it there).`
      return `▶️ #${n.jobId} continues your chat ${name} after the usage limit (it was closed in ${n.where}).`
    }
    case 'recovered':
      return `🔁 #${n.job.id}'s window was gone (the Mac restarted?), so it continues where it left off.`
    case 'killed':
      return `🛑 #${n.job.id} killed${n.by ? ` by ${n.by}` : ''} · ${projectLabel(n.job.projectDir, aliases)}`
    case 'setup_warning':
      return `⚠️ ${n.message}`
    case 'empty':
      return '🏁 Queue empty.'
  }
}
