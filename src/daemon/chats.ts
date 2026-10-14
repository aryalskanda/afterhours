import { existsSync } from 'node:fs'
import type { Effort, ExecMode, JobSpec } from '../shared/types'
import { findConversation, listConversations, whereLabel, type Conversation, type LiveSession } from './sessions'
import type { Store } from './store'

/** The prompt a hand-off continues a stopped conversation with (Claude Code's own wording). */
export const CONTINUE_PROMPT = 'Continue from where you left off.'

/**
 * What Afterhours posts into an open chat's inbox at the reset. Claude shows it as a message from
 * another session working on your behalf, so it says who sent it and why.
 */
export const CONTINUE_INBOX =
  'Your usage limit has reset. Please continue the task from where you left off. ' +
  '(Sent by Afterhours, which your user set up to continue their chats after usage limits.)'

/** A conversation plus where it's open right now. */
export interface Chat extends Conversation {
  /** "VS Code", "a terminal"…: another Claude window has it open. */
  where: string | null
  /** That window is in the middle of a turn. */
  busy: boolean
  /** It's the conversation the queue is running right now. */
  running: boolean
}

/** The conversations the bot and `chats` offer to continue. */
export interface ChatSource {
  /** Recent conversations in a folder, newest first, including its jobs' worktrees. */
  list(folder: string, limit: number): Chat[]
  get(sessionId: string): Chat | null
}

export function chatSource(o: { store: Store; liveSessions: () => LiveSession[]; claudeDir?: string }): ChatSource {
  const withState = (c: Conversation, live: LiveSession[], running: string | null): Chat => {
    const holder = c.sessionId === running ? undefined : live.find(s => s.sessionId === c.sessionId)
    return { ...c, where: holder ? whereLabel(holder) : null, busy: holder?.status === 'busy', running: c.sessionId === running }
  }
  return {
    list(folder, limit) {
      const dirs = [folder, ...o.store.worktreeDirs(folder).filter(d => existsSync(d))]
      const live = o.liveSessions()
      const running = o.store.active()?.sessionId ?? null
      return listConversations(dirs, limit, o.claudeDir).map(c => withState(c, live, running))
    },
    get(sessionId) {
      const c = findConversation(sessionId, o.claudeDir)
      return c ? withState(c, o.liveSessions(), o.store.active()?.sessionId ?? null) : null
    },
  }
}

/** The mode a hand-off continues in, from the conversation's last permission mode. */
export function modeFor(permissionMode: string | null): { plan: boolean; review: boolean; execMode: ExecMode } {
  switch (permissionMode) {
    case 'plan':
      // It was still planning: you see the plan before anything runs.
      return { plan: true, review: true, execMode: 'auto' }
    case 'acceptEdits':
      return { plan: false, review: false, execMode: 'acceptEdits' }
    case 'bypassPermissions':
      return { plan: false, review: false, execMode: 'bypassPermissions' }
    default:
      return { plan: false, review: false, execMode: 'auto' }
  }
}

/** "claude-opus-5-5" → "opus", so a hand-off keeps the conversation's model family. */
export function modelAlias(model: string | null): string | null {
  return /^claude-(opus|sonnet|haiku|fable)\b/.exec(model ?? '')?.[1] ?? null
}

/** "open in VS Code, working", "stopped at a usage limit"…, for lists. */
export function chatState(c: Chat): string {
  const parts: string[] = []
  if (c.running) parts.push('running in the queue')
  else if (c.where) parts.push(`open in ${c.where}${c.busy ? ', working' : ''}`)
  if (c.limit && !c.busy && !c.running) parts.push('stopped at a usage limit')
  return parts.join(' · ')
}

/**
 * A job that continues `chat` in the same conversation, at the front of the queue: the chat's own
 * mode and model family, your effort. `takeover` closes it first where it's open.
 */
export function continueSpec(
  chat: Pick<Conversation, 'sessionId' | 'cwd' | 'permissionMode' | 'model'> & { cwd: string },
  o: { model: string; effort: Effort; takeover: boolean; source: string; prompt?: string },
): JobSpec {
  return {
    projectDir: chat.cwd,
    prompt: o.prompt ?? CONTINUE_PROMPT,
    ...modeFor(chat.permissionMode),
    model: modelAlias(chat.model) ?? o.model,
    effort: o.effort,
    sessionPolicy: 'session',
    sessionId: chat.sessionId,
    isolate: false,
    takeover: o.takeover,
    front: true,
    source: o.source,
  }
}
