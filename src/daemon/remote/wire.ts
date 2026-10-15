// The daemon's jobs, chats and notices as the plain data apps receive (packages/protocol).

import type { ApprovalInfo, ChatInfo, JobInfo, LimitsInfo, Notice as WireNotice } from '@afterhours/protocol'
import type { Approval, Job, LimitState } from '../../shared/types'
import type { Chat } from '../chats'
import type { Notice } from '../notify'
import type { Conversation } from '../sessions'

/** `brief`: prompts cut to 500 characters, for the lists sent on every change. */
export function jobInfo(job: Job, o: { brief?: boolean } = {}): JobInfo {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    holdReason: job.holdReason,
    folder: job.projectDir,
    workDir: job.workDir,
    prompt: o.brief && job.prompt.length > 500 ? `${job.prompt.slice(0, 499)}…` : job.prompt,
    plan: job.plan,
    review: job.review,
    mode: job.execMode,
    model: job.model,
    effort: job.effort,
    session: job.sessionId,
    branch: job.branch,
    isolate: job.isolate,
    summary: job.summary,
    error: job.error,
    source: job.source,
    position: job.position,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

export function chatInfo(c: Conversation & Partial<Pick<Chat, 'where' | 'busy' | 'running'>>): ChatInfo {
  return {
    session: c.sessionId,
    folder: c.cwd,
    title: c.title,
    lastPrompt: c.lastPrompt,
    lastReply: c.lastReply,
    updatedAt: c.updatedAt,
    model: c.model,
    mode: c.permissionMode,
    where: c.where ?? null,
    busy: c.busy ?? false,
    running: c.running ?? false,
    limited: c.limit !== null,
  }
}

export function approvalInfo(a: Approval): ApprovalInfo {
  return { code: a.code, job: a.jobId, kind: a.kind, payload: a.payload, createdAt: a.createdAt }
}

export function limitsInfo(l: LimitState): LimitsInfo {
  return {
    fiveHour: l.fiveHour,
    sevenDay: l.sevenDay,
    blockedUntil: l.blockedUntil ?? null,
    updatedAt: l.updatedAt,
  }
}

export function wireNotice(n: Notice): WireNotice {
  switch (n.type) {
    case 'plan_review':
      return { type: n.type, job: jobInfo(n.job), code: n.code, plan: n.job.planText }
    case 'done':
      return { type: n.type, job: jobInfo(n.job), diff: n.diff, next: n.next ? jobInfo(n.next, { brief: true }) : null }
    case 'session_limit':
      return { type: n.type, chat: chatInfo(n.chat), where: n.where, at: n.at, window: n.window, autoAt: n.autoAt }
    case 'chat_continue':
      return { type: n.type, chat: chatInfo(n.chat), where: n.where, how: n.how, jobId: n.jobId }
    case 'setup_warning':
      return { type: n.type, message: n.message }
    case 'empty':
      return { type: n.type }
    default:
      // Every other notice is a job plus fields that are already plain data.
      return { ...n, job: jobInfo(n.job) } as WireNotice
  }
}
