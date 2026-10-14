import { basename } from 'node:path'
import { BRAND } from '../shared/brand'
import type { Effort, ExecMode, Job } from '../shared/types'
import { chatState, type Chat } from '../daemon/chats'
import type { FolderEntry, SearchHit } from '../daemon/folders'
import { duration, modeLabel } from '../daemon/format'
import { formatClock, windowLabel } from '../daemon/limits'
import { resumedBy, type Notice, type Question } from '../daemon/notify'
import type { InlineButton, InlineKeyboard, ReplyKeyboard } from './api'
import type { Draft } from './state'

// Everything the bot shows, as pure functions: text in Telegram's HTML subset plus buttons.
// Button data stays under Telegram's 64-byte limit:
//   d:<draft>:<op>[:<arg>…]  a draft card    a:<code>:y|n|c  an approval
//   o:<code>:<q>.<opt>|t     a question       j:<job>:<op>    a job       g:<op>  global
//   w:<session>:c|f|x        one of your other chats (it hit a usage limit)
//   c:l:<page> · c:o|w|r:<session> · c:x   your chats: a page, open one, write in it, its full reply, leave it

export interface View {
  html: string
  keyboard?: InlineKeyboard
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max)
}

export function btn(text: string, data: string): InlineButton {
  if (Buffer.byteLength(data) > 64) throw new Error(`button data too long: ${data}`)
  return { text, callback_data: data }
}

function quote(text: string | null | undefined, max: number): string {
  const t = clip(text, max)
  if (!t) return ''
  return `<blockquote${t.length > 300 ? ' expandable' : ''}>${esc(t)}</blockquote>`
}

export const KEYS = {
  newTask: '➕ New task',
  queue: '📋 Queue',
  status: '📊 Status',
  peek: '👀 Peek',
  chats: '💬 Chats',
  leave: '⬅️ Leave chat',
}

/** The buttons that stay under the text box. */
export const MAIN_KEYBOARD: ReplyKeyboard = {
  keyboard: [[{ text: KEYS.newTask }, { text: KEYS.queue }], [{ text: KEYS.status }, { text: KEYS.peek }], [{ text: KEYS.chats }]],
  is_persistent: true,
  resize_keyboard: true,
}

/** While you're inside a chat: what you type goes into it until you leave. */
export const CHAT_KEYBOARD: ReplyKeyboard = {
  keyboard: [[{ text: KEYS.leave }, { text: KEYS.chats }], [{ text: KEYS.status }, { text: KEYS.peek }]],
  is_persistent: true,
  resize_keyboard: true,
}

export const MODES = {
  plan: { label: 'plan → auto', hint: `Claude plans first; ${BRAND.name} approves the plan and Claude carries it out in auto mode`, plan: true, review: false, execMode: 'auto' },
  review: { label: 'review → auto', hint: 'like plan, but you approve the plan here first', plan: true, review: true, execMode: 'auto' },
  auto: { label: 'auto', hint: 'no plan; auto mode decides what needs your permission', plan: false, review: false, execMode: 'auto' },
  edits: { label: 'accept edits', hint: 'no plan; file edits are allowed, anything else asks you', plan: false, review: false, execMode: 'acceptEdits' },
  yolo: { label: 'yolo', hint: 'no plan and no permission checks at all', plan: false, review: false, execMode: 'bypassPermissions' },
} as const satisfies Record<string, { label: string; hint: string; plan: boolean; review: boolean; execMode: ExecMode }>

export type ModeKey = keyof typeof MODES

export function modeOf(d: { plan: boolean; review: boolean; execMode: ExecMode }): ModeKey | null {
  for (const [key, m] of Object.entries(MODES) as [ModeKey, (typeof MODES)[ModeKey]][]) {
    if (m.plan === d.plan && m.review === d.review && m.execMode === d.execMode) return key
  }
  return null
}

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface UiContext {
  models: string[]
  /** Short stable id for a folder (button data). */
  folderId: (path: string) => number
  /** "nachonacho/web" for a folder under your roots. */
  label: (path: string) => string
  /** Whether the folder already has a conversation that "continue" would pick up. */
  hasConversation: (folder: string) => boolean
  /** A conversation by session id, with where it's open right now. */
  chat: (sessionId: string) => Chat | null
}

/** A new conversation starts here (rather than continuing one), so branch isolation applies. */
function startsNewChat(d: Draft, ctx: UiContext): boolean {
  return !d.sessionId && (d.newChat || !d.folder || !ctx.hasConversation(d.folder))
}

function chatLabel(d: Draft, ctx: UiContext, chat: Chat | null): string {
  if (!d.sessionId) {
    if (!startsNewChat(d, ctx)) return '💬 continues the last chat there'
    return `💬 new chat · ${d.isolate ? '🌿 on its own branch' : '📂 in your checkout'}`
  }
  const head = d.followJob
    ? `💬 follows up #${d.followJob}`
    : `💬 continues ${chat ? `“${esc(clip(chat.title, 60))}”` : `@${d.sessionId.slice(0, 8)}`}`
  if (!chat?.where) return head
  return (
    `${head} · 🟢 open in ${esc(chat.where)}${chat.busy ? ', working' : ''}\n` +
    (d.takeover ? `🤝 takes it over when it starts${chat.busy ? ' (after that turn)' : ''}, closing it there` : '⏳ starts once you close it there')
  )
}

export function draftCard(d: Draft, ctx: UiContext): View {
  const id = d.id
  const chat = d.sessionId ? ctx.chat(d.sessionId) : null
  const folder = d.folder ? `📁 <b>${esc(ctx.label(d.folder))}</b>` : '📁 <i>no folder yet</i>'
  const html = [
    d.prompt ? quote(d.prompt, 1500) : '📝 <i>Now send the prompt as your next message.</i>',
    folder,
    `🗺 ${esc(modeLabel(d))} · 🧠 ${esc(d.model)} · ⚡ ${d.effort}`,
    chatLabel(d, ctx, chat),
  ].join('\n')
  const chatButton = btn('💬 Chat…', `d:${id}:t`)
  const branchButton = startsNewChat(d, ctx) ? [btn(d.isolate ? '📂 Work in place' : '🌿 Own branch', `d:${id}:i`)] : []
  const takeButton = chat?.where ? [btn(d.takeover ? '⏳ Wait instead' : '🤝 Take over', `d:${id}:h`)] : []
  const go = !d.folder
    ? btn('📁 Pick a folder first', `d:${id}:f`)
    : !d.prompt
      ? btn('✍️ Send the prompt…', `d:${id}:k`)
      : btn('▶️ Queue', `d:${id}:q`)
  return {
    html,
    keyboard: [
      [btn('📁 Folder', `d:${id}:f`), btn('🗺 Mode', `d:${id}:o`), btn('🧠 Model', `d:${id}:m`)],
      [btn('⚡ Effort', `d:${id}:e`), chatButton, ...branchButton, ...takeButton],
      [go, btn('✖️ Discard', `d:${id}:x`)],
    ],
  }
}

const PER_PAGE = 12

function pairs<T>(items: T[]): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2))
  return rows
}

export interface FolderPage {
  dir: string
  parent: string | null
  children: FolderEntry[]
  page: number
}

export function folderView(d: Draft, f: FolderPage, ctx: UiContext): View {
  const id = d.id
  const pages = Math.max(1, Math.ceil(f.children.length / PER_PAGE))
  const page = Math.min(Math.max(f.page, 0), pages - 1)
  const shown = f.children.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
  const dirId = ctx.folderId(f.dir)
  const html =
    `📁 <b>${esc(ctx.label(f.dir))}</b>\n` +
    `<i>${f.children.length === 0 ? 'No subfolders.' : `${f.children.length} folders${pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}. Tap › to open a folder, or one without › to pick it.`}</i>`
  const keyboard: InlineKeyboard = [
    [btn(`✅ Use ${clip(basename(f.dir), 32)}`, `d:${id}:u:${dirId}`)],
    [
      ...(f.parent ? [btn('⬆️ Up', `d:${id}:b:${ctx.folderId(f.parent)}:0`)] : []),
      btn('⭐ Recent', `d:${id}:r`),
      btn('🔍 Search', `d:${id}:s`),
    ],
    ...pairs(
      shown.map(c =>
        btn(
          `${c.isRepo ? '📦 ' : ''}${clip(c.name, 28)}${c.hasChildren ? ' ›' : ''}`,
          c.hasChildren ? `d:${id}:b:${ctx.folderId(c.path)}:0` : `d:${id}:u:${ctx.folderId(c.path)}`,
        ),
      ),
    ),
  ]
  if (pages > 1) {
    keyboard.push([
      ...(page > 0 ? [btn('◀️ Previous', `d:${id}:b:${dirId}:${page - 1}`)] : []),
      ...(page < pages - 1 ? [btn('Next ▶️', `d:${id}:b:${dirId}:${page + 1}`)] : []),
    ])
  }
  keyboard.push([btn('↩️ Back', `d:${id}:k`), btn('🔄 Rescan', `d:${id}:rs`)])
  return { html, keyboard }
}

function chatIcon(c: Chat): string {
  if (c.running) return '▶️'
  if (c.where && c.busy) return '🟡'
  if (c.limit) return '⏸'
  if (c.where) return '🟢'
  return '💬'
}

/** 💬 Chat…: a new chat, the folder's last one, or one of its recent chats from anywhere (VS Code too). */
export function chatsView(d: Draft, folder: string, chats: Chat[], hasLast: boolean, now: number): View {
  const id = d.id
  const lines = chats.map((c, i) => {
    const state = chatState(c)
    const prompt = c.lastPrompt ? `\n   <i>“${esc(clip(c.lastPrompt, 90))}”</i>` : ''
    return `${i + 1}. ${chatIcon(c)} <b>${esc(clip(c.title, 70))}</b>${state ? ` · ${esc(state)}` : ''} · ${duration(now - c.updatedAt)} ago${prompt}`
  })
  const html =
    `💬 <b>Chats in ${esc(folder)}</b>\n` +
    (chats.length > 0 ? `${lines.join('\n')}\n<i>Tap one to send your prompt into it.</i>` : '<i>No Claude Code chats here yet.</i>')
  const top = [btn(`${!d.sessionId && d.newChat ? '✓ ' : ''}🆕 New chat`, `d:${id}:t:new`)]
  if (hasLast) top.push(btn(`${!d.sessionId && !d.newChat ? '✓ ' : ''}🔁 Last ${BRAND.name} chat`, `d:${id}:t:last`))
  return {
    html,
    keyboard: [
      top,
      ...chats.map((c, i) => [btn(`${d.sessionId === c.sessionId ? '✓ ' : ''}${i + 1}. ${chatIcon(c)} ${clip(c.title, 40)}`, `d:${id}:t:${c.sessionId}`)]),
      [btn('↩️ Back', `d:${id}:k`)],
    ],
  }
}

export const CHATS_PER_PAGE = 8

/** 💬 Chats: your recent chats from every project, newest first. */
export function recentChatsView(chats: Chat[], page: number, more: boolean, ctx: NoticeContext): View {
  const lines = chats.map((c, i) => {
    const state = chatState(c)
    return (
      `${page * CHATS_PER_PAGE + i + 1}. ${chatIcon(c)} <b>${esc(clip(c.title, 60))}</b>\n` +
      `   📁 ${esc(c.cwd ? ctx.label(c.cwd) : '?')}${state ? ` · ${esc(state)}` : ''} · ${duration(ctx.now - c.updatedAt)} ago`
    )
  })
  const html =
    chats.length > 0
      ? `💬 <b>Your chats</b>, newest first${page > 0 ? ` · page ${page + 1}` : ''}\n${lines.join('\n')}\n<i>Tap one to open it.</i>`
      : page > 0
        ? '💬 <i>No older chats.</i>'
        : '💬 <i>No Claude Code chats yet.</i>'
  const nav = [...(page > 0 ? [btn('◀️ Newer', `c:l:${page - 1}`)] : []), ...(more ? [btn('Older ▶️', `c:l:${page + 1}`)] : [])]
  return {
    html,
    keyboard: [...chats.map(c => [btn(`${chatIcon(c)} ${clip(c.title, 40)}`, `c:o:${c.sessionId}`)]), ...(nav.length > 0 ? [nav] : [])],
  }
}

/** One chat: where it is, your last prompt and Claude's last reply. */
export function chatView(c: Chat, ctx: NoticeContext, inside: boolean): View {
  const state = chatState(c)
  const long = (c.lastReply?.length ?? 0) > 1500
  const html = [
    `💬 <b>${esc(clip(c.title, 120))}</b>`,
    `📁 ${esc(c.cwd ? ctx.label(c.cwd) : '?')}${state ? ` · ${esc(state)}` : ''} · ${duration(ctx.now - c.updatedAt)} ago`,
    c.lastPrompt ? `<b>You:</b>\n${quote(c.lastPrompt, 500)}` : '',
    c.lastReply ? `<b>Claude:</b>\n${quote(c.lastReply, 1500)}` : '',
    inside ? "<i>You're in this chat: what you type goes here.</i>" : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    html,
    keyboard: [
      [inside ? btn('⬅️ Leave chat', 'c:x') : btn('✍️ Write here', `c:w:${c.sessionId}`), ...(long ? [btn('📜 Full reply', `c:r:${c.sessionId}`)] : [])],
      [btn('↩️ All chats', 'c:l:0')],
    ],
  }
}

/** Sent when you enter a chat, with CHAT_KEYBOARD. */
export function enteredChatHtml(c: Chat, ctx: NoticeContext): string {
  const open = c.where ? ` It's open in ${esc(c.where)}: your first message closes it there and continues it here.` : ''
  return (
    `💬 <b>You're in “${esc(clip(c.title, 80))}”</b> · 📁 ${esc(c.cwd ? ctx.label(c.cwd) : '?')}\n` +
    `Everything you type now goes into this chat, as if you typed it there.${open}\n<i>Tap ${KEYS.leave} to stop.</i>`
  )
}

/** 🔘 Keys: press keys in the running task, for a screen Afterhours doesn't know. */
export function keysView(jobId: number): View {
  const k = (label: string, key: string) => btn(label, `g:k:${key}`)
  return {
    html: `🔘 <b>Press keys in #${jobId}</b>\n<i>For a screen ${BRAND.name} can't answer. 👀 Peek shows the result.</i>`,
    keyboard: [
      [k('1', '1'), k('2', '2'), k('3', '3')],
      [k('⏎ Enter', 'Enter'), k('⎋ Esc', 'Escape'), k('⇥ Tab', 'Tab')],
      [k('↑', 'Up'), k('↓', 'Down'), k('⇧⇥ Shift-Tab', 'BTab')],
      [btn('👀 Peek', 'g:peek')],
    ],
  }
}

export function recentView(d: Draft, recent: string[], ctx: UiContext): View {
  const id = d.id
  const html = recent.length > 0 ? '⭐ <b>Recent folders</b>' : '⭐ <i>No recent folders yet. Browse or search instead.</i>'
  return {
    html,
    keyboard: [
      ...recent.map(path => [btn(`📁 ${clip(ctx.label(path), 48)}`, `d:${id}:u:${ctx.folderId(path)}`)]),
      [btn('📁 Browse', `d:${id}:f`), btn('🔍 Search', `d:${id}:s`), btn('↩️ Back', `d:${id}:k`)],
    ],
  }
}

export function searchPromptView(d: Draft): View {
  return {
    html: '🔍 <b>Type part of the folder name</b>, e.g. <code>api</code> or <code>shop web</code>.',
    keyboard: [[btn('📁 Browse instead', `d:${d.id}:f`), btn('↩️ Back', `d:${d.id}:k`)]],
  }
}

export function searchView(d: Draft, query: string, hits: SearchHit[], ctx: UiContext): View {
  const id = d.id
  const html =
    hits.length > 0
      ? `🔍 <b>${esc(query)}</b>: tap a folder to use it.`
      : `🔍 No folder matches <b>${esc(query)}</b>. Type another word, or browse.`
  return {
    html,
    keyboard: [
      ...hits.map(h => [btn(`${h.isRepo ? '📦' : '📁'} ${clip(ctx.label(h.path), 48)}`, `d:${id}:u:${ctx.folderId(h.path)}`)]),
      [btn('🔍 Search again', `d:${id}:s`), btn('📁 Browse', `d:${id}:f`), btn('↩️ Back', `d:${id}:k`)],
    ],
  }
}

export function modeView(d: Draft): View {
  const current = modeOf(d)
  const lines = (Object.entries(MODES) as [ModeKey, (typeof MODES)[ModeKey]][]).map(
    ([key, m]) => `${key === current ? '✓' : '•'} <b>${m.label}</b>: ${m.hint}`,
  )
  return {
    html: `🗺 <b>Mode</b>\n${lines.join('\n')}`,
    keyboard: [
      [btn(`${current === 'plan' ? '✓ ' : ''}plan → auto`, `d:${d.id}:o:plan`), btn(`${current === 'review' ? '✓ ' : ''}review → auto`, `d:${d.id}:o:review`)],
      [btn(`${current === 'auto' ? '✓ ' : ''}auto`, `d:${d.id}:o:auto`), btn(`${current === 'edits' ? '✓ ' : ''}accept edits`, `d:${d.id}:o:edits`)],
      [btn(`${current === 'yolo' ? '✓ ' : ''}⚠️ yolo`, `d:${d.id}:o:yolo`), btn('↩️ Back', `d:${d.id}:k`)],
    ],
  }
}

export function modelView(d: Draft, ctx: UiContext): View {
  const models = ctx.models.includes(d.model) ? ctx.models : [...ctx.models, d.model]
  const buttons = models.map(m => btn(`${m === d.model ? '✓ ' : ''}${m}`, `d:${d.id}:m:${m}`))
  const rows: InlineKeyboard = []
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
  rows.push([btn('↩️ Back', `d:${d.id}:k`)])
  return { html: '🧠 <b>Model</b>', keyboard: rows }
}

export function effortView(d: Draft): View {
  const b = (e: Effort) => btn(`${e === d.effort ? '✓ ' : ''}${e}`, `d:${d.id}:e:${e}`)
  return {
    html: '⚡ <b>Effort</b>\n<i>Higher effort thinks longer and uses more of your usage limit.</i>',
    keyboard: [[b('low'), b('medium'), b('high')], [b('xhigh'), b('max')], [btn('↩️ Back', `d:${d.id}:k`)]],
  }
}

export function queuedView(job: Job, when: string, ctx: UiContext): View {
  return {
    html:
      `✅ <b>Queued #${job.id}</b> · ${esc(ctx.label(job.projectDir))} · ${esc(modeLabel(job))} · ${esc(job.model)}/${job.effort}\n` +
      `${quote(job.prompt, 1500)}\n<i>${esc(when)}</i>`,
    keyboard: [[btn('⬆️ Run next', `j:${job.id}:top`), btn('🗑 Remove', `j:${job.id}:rm`)]],
  }
}

function jobHeader(job: Job, ctx: UiContext): string {
  return `${esc(ctx.label(job.projectDir))} · ${esc(modeLabel(job))} · ${esc(job.model)}/${job.effort}`
}

function questionLines(questions: Question[]): string {
  return questions
    .map((q, qi) => {
      const head = questions.length > 1 ? `${qi + 1}. ` : ''
      const opts = (q.options ?? []).map((o, oi) => `   ${String.fromCharCode(97 + oi)}) ${esc(o.label)}${o.description ? ` · <i>${esc(clip(o.description, 120))}</i>` : ''}`)
      return [`<b>${head}${esc(q.question)}</b>`, ...opts].join('\n')
    })
    .join('\n')
}

/** Buttons for a question: one per option; with several questions, picks are collected first. */
export function questionKeyboard(code: string, questions: Question[], picked: Map<number, number> = new Map()): InlineKeyboard {
  const rows: InlineKeyboard = []
  questions.forEach((q, qi) => {
    const buttons = (q.options ?? []).map((o, oi) => {
      const tag = questions.length > 1 ? `${qi + 1}${String.fromCharCode(97 + oi)}` : String.fromCharCode(97 + oi)
      return btn(`${picked.get(qi) === oi ? '✓ ' : ''}${tag}) ${clip(o.label, 26)}`, `o:${code}:${qi}.${oi}`)
    })
    rows.push(...pairs(buttons))
  })
  rows.push([btn('✍️ Type an answer', `o:${code}:t`)])
  return rows
}

export interface NoticeContext extends UiContext {
  now: number
}

export function noticeView(n: Notice, ctx: NoticeContext): View {
  switch (n.type) {
    case 'started':
      return {
        html: `▶️ <b>#${n.job.id} started</b> · ${jobHeader(n.job, ctx)}\n${quote(n.job.prompt, 600)}`,
        keyboard: [[btn('👀 Peek', `j:${n.job.id}:peek`), btn('⏹ Stop', `j:${n.job.id}:stop`)]],
      }
    case 'plan_approved':
      return { html: `📝 <b>#${n.job.id} plan approved</b> (${esc(n.choice)})\n${quote(n.job.planText, 2500)}` }
    case 'plan_review':
      return {
        html: `📝 <b>#${n.job.id} plan ready for your review</b> · ${esc(ctx.label(n.job.projectDir))}\n${quote(n.job.planText, 3000)}`,
        keyboard: [[btn('✅ Approve', `a:${n.code}:y`), btn('✏️ Ask for changes', `a:${n.code}:c`)]],
      }
    case 'permission':
      return {
        html:
          `🔐 <b>#${n.job.id} wants to use ${esc(n.tool)}</b> · ${esc(ctx.label(n.job.projectDir))}\n` +
          `<pre>${esc(clip(n.detail, 1500))}</pre>\n<i>Denied automatically in ${n.minutes}m.</i>`,
        keyboard: [[btn('✅ Allow', `a:${n.code}:y`), btn('❌ Deny', `a:${n.code}:n`)]],
      }
    case 'question':
      return {
        html: `❓ <b>#${n.job.id} asks</b>\n${questionLines(n.questions)}\n<i>If you don't answer within ${n.minutes}m, Claude decides itself.</i>`,
        keyboard: questionKeyboard(n.code, n.questions),
      }
    case 'trust':
      return {
        html: `🔐 <b>#${n.job.id}</b> is the first Claude Code run in <b>${esc(ctx.label(n.job.projectDir))}</b>.\nClaude asks whether to trust this folder.`,
        keyboard: [[btn('✅ Trust it', `a:${n.code}:y`), btn('❌ Cancel the job', `a:${n.code}:n`)]],
      }
    case 'limit': {
      const when = n.at ? `resets ${formatClock(n.at, ctx.now)}` : "reset time unknown; retrying every 15 minutes"
      return {
        html: `⏸ <b>#${n.job.id} hit the ${windowLabel(n.window)}</b> · ${esc(when)} · it continues on its own`,
        keyboard: [[btn('▶️ Continue now', `j:${n.job.id}:now`), btn('👀 Peek', `j:${n.job.id}:peek`)]],
      }
    }
    case 'resumed':
      return { html: `▶️ <b>#${n.job.id}</b> continued after the limit reset (${esc(resumedBy(n.how))})` }
    case 'done': {
      const took = n.job.startedAt ? ` in ${duration((n.job.finishedAt ?? ctx.now) - n.job.startedAt)}` : ''
      const next = n.next ? `Next: #${n.next.id} · ${jobHeader(n.next, ctx)}` : 'Queue empty.'
      return {
        html:
          `✅ <b>#${n.job.id} done</b>${took} · ${esc(ctx.label(n.job.projectDir))}\n` +
          `${n.diff ? `<i>${esc(n.diff)}</i>\n` : ''}` +
          `${n.job.branch ? `🌿 On branch <code>${esc(n.job.branch)}</code> · merge with <code>git merge ${esc(n.job.branch)}</code>\n` : ''}` +
          (longReply(n.job.lastMessage)
            ? `${quote(n.job.lastMessage, 600)}\n<i>Claude's full answer follows.</i>\n${next}`
            : `${quote(n.job.lastMessage, 2000)}\n${next}`),
        keyboard: [[btn('➕ Follow up', `j:${n.job.id}:fu`)]],
      }
    }
    case 'held':
      return {
        html: `⚠️ <b>#${n.job.id} paused</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [
          [btn('▶️ Go', `j:${n.job.id}:go`), btn('⏭ Skip', `j:${n.job.id}:skip`), btn('👀 Peek', `j:${n.job.id}:peek`)],
          [btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys')],
        ],
      }
    case 'failed':
      return {
        html: `❌ <b>#${n.job.id} failed</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [[btn('▶️ Retry', `j:${n.job.id}:go`), btn('⏭ Skip', `j:${n.job.id}:skip`)]],
      }
    case 'conflict': {
      const id = n.job.id
      const where = esc(n.where)
      const html =
        n.state === 'waiting'
          ? `⏳ <b>#${id} is waiting</b> for its chat to finish its turn in ${where}, then takes it over (closing it there).`
          : n.state === 'stuck'
            ? `⚠️ <b>#${id} couldn't take its chat over</b>: it's still open in ${where} (${esc(n.holder)}). Close it there, or continue in a copy.`
            : `⚠️ <b>#${id} is waiting</b>: its chat is open in ${where}${n.busy ? ' and working' : ''} (${esc(n.holder)}). ` +
              `It starts by itself once you close it there.\n<i>🤝 Take over closes it there${n.busy ? ' after its current turn' : ''} and continues it here.</i>`
      return {
        html,
        keyboard: [
          [...(n.state === 'waiting' ? [] : [btn('🤝 Take over', `j:${id}:take`)]), btn('🍴 Continue in a copy', `j:${id}:fork`)],
          [btn('⏭ Skip', `j:${id}:skip`)],
        ],
      }
    }
    case 'took_over':
      return {
        html: `🤝 <b>#${n.job.id} took its chat over from ${esc(n.where)}</b> (closed it there). Reopen it there later to see everything it did.`,
      }
    case 'session_limit': {
      const sid = n.chat.sessionId
      const when = n.at ? ` · resets ${formatClock(n.at, ctx.now)}` : ''
      const head = [
        `⏸ <b>Your chat in ${esc(n.where)} hit the ${windowLabel(n.window)}</b>${esc(when)}`,
        `${n.chat.cwd ? `📁 ${esc(ctx.label(n.chat.cwd))} · ` : ''}“${esc(clip(n.chat.title, 120))}”`,
        quote(n.chat.lastPrompt, 600),
      ]
      if (n.autoAt) {
        return {
          html: [
            ...head,
            `<i>At ${esc(formatClock(n.autoAt, ctx.now))} I'll tell it to continue, so it carries on in ${esc(n.where)}. If it doesn't start, I'll continue it here.</i>`,
          ]
            .filter(Boolean)
            .join('\n'),
          keyboard: [
            [btn('✖️ Don’t continue', `w:${sid}:x`), btn('🤝 Continue here instead', `w:${sid}:c`)],
            [btn('✏️ Follow up…', `w:${sid}:f`)],
          ],
        }
      }
      return {
        html: [
          ...head,
          `<i>▶️ continues it here after the reset. It closes the chat in ${esc(n.where)} first; reopen it there later to see everything.</i>`,
        ]
          .filter(Boolean)
          .join('\n'),
        keyboard: [
          [btn('▶️ Continue after the reset', `w:${sid}:c`), btn('✏️ Follow up…', `w:${sid}:f`)],
          [btn('✖️ Ignore', `w:${sid}:x`)],
        ],
      }
    }
    case 'chat_continue': {
      const name = `“${esc(clip(n.chat.title, 120))}”`
      if (n.how === 'inbox') {
        return {
          html: `▶️ <b>The usage limit reset:</b> I told your chat ${name} in ${esc(n.where)} to continue.`,
          keyboard: [[btn('🤝 Continue here instead', `w:${n.chat.sessionId}:c`)]],
        }
      }
      if (n.how === 'takeover') {
        return { html: `🤝 <b>Your chat ${name} didn't restart</b> in ${esc(n.where)}, so #${n.jobId} continues it here (closing it there).` }
      }
      return { html: `▶️ <b>#${n.jobId} continues your chat ${name}</b> after the usage limit (it was closed in ${esc(n.where)}).` }
    }
    case 'recovered':
      return {
        html: `🔁 <b>#${n.job.id}'s window was gone</b> (the Mac restarted?), so it continues where it left off.`,
        keyboard: [[btn('👀 Peek', `j:${n.job.id}:peek`), btn('⏹ Stop', `j:${n.job.id}:stop`)]],
      }
    case 'setup_warning':
      return { html: `⚠️ ${esc(n.message)}` }
    case 'empty':
      return { html: '🏁 Queue empty.' }
  }
}

/** A final answer too long for the done message: it follows in full (more messages, or a file). */
export function longReply(text: string | null | undefined): boolean {
  return (text?.trim().length ?? 0) > 2000
}

export function statusView(text: string, paused: boolean): View {
  return {
    html: `📊 <b>Status</b>\n${esc(text)}`,
    keyboard: [
      [
        btn('🔄 Refresh', 'g:st'),
        paused ? btn('▶️ Resume', 'g:resume') : btn('⏸ Pause', 'g:pause'),
        btn('👀 Peek', 'g:peek'),
      ],
      [btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys')],
    ],
  }
}

export function queueView(active: Job | null, queued: Job[], ctx: UiContext, paused: boolean): View {
  const lines: string[] = ['📋 <b>Queue</b>']
  if (active) lines.push(`▶ <b>#${active.id}</b> ${jobHeader(active, ctx)}\n   “${esc(oneLine(active.prompt, 90))}”`)
  queued.forEach((job, i) => lines.push(`${i + 1}. <b>#${job.id}</b> ${jobHeader(job, ctx)}\n   “${esc(oneLine(job.prompt, 90))}”`))
  if (!active && queued.length === 0) lines.push('<i>Nothing queued. Send a prompt to add one.</i>')
  if (paused) lines.push('⏸ <i>Paused: nothing new starts until you resume.</i>')
  const keyboard: InlineKeyboard = queued.slice(0, 20).map(job => [btn(`⬆️ #${job.id} next`, `j:${job.id}:top`), btn(`🗑 #${job.id}`, `j:${job.id}:rm`)])
  keyboard.push([btn('🔄 Refresh', 'g:q'), paused ? btn('▶️ Resume', 'g:resume') : btn('⏸ Pause', 'g:pause')])
  return { html: lines.join('\n'), keyboard }
}

export function peekView(jobId: number | null, screen: string): View {
  if (jobId === null) return { html: '👀 Nothing is running.', keyboard: [[btn('🔄 Refresh', 'g:peek')]] }
  return {
    html: `👀 <b>#${jobId}</b>\n<pre>${esc(clip(screen, 3500)) || '(blank screen)'}</pre>`,
    keyboard: [
      [btn('🔄 Refresh', 'g:peek'), btn('⏹ Stop', `j:${jobId}:stop`)],
      [btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys')],
    ],
  }
}

export function settingsView(o: {
  notify: string
  folders: number
  builtAt: number | null
  roots: string[]
  models: string[]
  watch: boolean
  autoContinue: boolean
  now: number
}): View {
  const built = o.builtAt ? `rebuilt ${duration(o.now - o.builtAt)} ago` : 'not built yet'
  const n = (level: string, label: string) => btn(`${o.notify === level ? '✓ ' : ''}${label}`, `g:notify:${level}`)
  return {
    html:
      '⚙️ <b>Settings</b>\n' +
      `Notifications: <b>${esc(o.notify)}</b>\n` +
      `Folder map: ${o.folders} folders under ${o.roots.map(r => esc(basename(r))).join(', ')} · ${built}\n` +
      `Models: ${esc(o.models.join(', '))} <i>(change in ~/${BRAND.homeDir}/config.json)</i>\n` +
      `Other chats: ${o.watch ? `I tell you when one in VS Code or a terminal hits a usage limit${o.autoContinue ? ', and continue it at the reset' : ''}` : 'not watched'}\n` +
      '<i>New tasks start with the choices you used last.</i>',
    keyboard: [
      [n('all', '🔔 All'), n('important', '🔕 Important'), n('off', '🔇 Off')],
      [btn(o.watch ? '👀 Watching other chats ✓' : '👀 Watch other chats', 'g:watch'), btn(o.autoContinue ? '▶️ Auto-continue ✓' : '▶️ Auto-continue', 'g:auto')],
      [btn('🔄 Rescan folders', 'g:rescan')],
    ],
  }
}

export const HELP_HTML =
  '<b>Send me what Claude should do.</b> I reply with a card: pick the folder, mode, model and effort with the buttons, then tap ▶️ Queue. ' +
  'It starts with the choices you used last, so usually you just tap ▶️ Queue.\n\n' +
  `${KEYS.newTask}: pick the folder first, then send the prompt.\n` +
  `${KEYS.chats}: any chat from any project, VS Code ones too. Open one and tap ✍️ Write here: everything you type then goes into that chat until you leave.\n` +
  '⌨️ Type and 🔘 Keys (on Peek and Status) type into the running task or press keys in it.\n' +
  '💬 Chat… on a card continues any chat in that folder, including one open in VS Code: 🤝 Take over closes it there and continues it here.\n' +
  `${KEYS.queue} · ${KEYS.status} · ${KEYS.peek}\n\n` +
  "I'll message you when a plan is ready, when Claude needs permission or has a question, when a usage limit pauses work, and when a job finishes. " +
  'When a chat in VS Code or a terminal hits a usage limit, I offer to continue it here after the reset.\n\n' +
  'Commands: /new /queue /status /peek /pause /resume /settings /cancel\n' +
  'Typing <code>q myapp plan opus max: …</code> still works too.'
