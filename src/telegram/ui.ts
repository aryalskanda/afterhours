import { basename } from 'node:path'
import { permissionRisk } from '@afterhours/protocol'
import { BRAND } from '../shared/brand'
import type { Approval, Effort, ExecMode, Job, LimitState } from '../shared/types'
import { chatState, type Chat } from '../daemon/chats'
import type { FolderEntry, SearchHit } from '../daemon/folders'
import { duration, modeLabel } from '../daemon/format'
import { formatClock, windowLabel } from '../daemon/limits'
import type { MacStatus } from '../daemon/mac'
import { resumedBy, type Notice, type Question, type QuestionAnswer } from '../daemon/notify'
import type { InlineButton, InlineKeyboard, ReplyKeyboard } from './api'
import { htmlToText, inlineMarkdown, markdownParts, markdownToPlain } from './markdown'
import type { Draft } from './state'
import { LATER } from './when'

// Everything the bot shows, as pure functions: text in Telegram's HTML subset plus buttons.
// Button data stays under Telegram's 64-byte limit:
//   d:<draft>:<op>[:<arg>…]  a draft card    a:<code>:y|n|c  an approval
//   o:<code>:<step>.<opt>|d|t|b  a question (pick, done, type, back)   j:<job>:<op>  a job   g:<op>  global
//   w:<session>:c|f|x        one of your other chats (it hit a usage limit)
//   c:l:<page> · c:o|w|r:<session> · c:x   your chats: a page, open one, write in it, its full reply, leave it

export interface View {
  html: string
  keyboard?: InlineKeyboard
  /** Arrives without a sound: news that needs nothing from you. */
  silent?: boolean
  /** More messages sent right after this one, in order (a long plan or answer). */
  follow?: View[]
  /** A file sent last, for text too long even for several messages. */
  file?: { name: string; text: string; caption: string }
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

/** About how many characters fit across a phone in one row of buttons. */
export const ROW_COLUMNS = 34

/** How wide text looks: emoji and East Asian characters take two columns. */
export function labelWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    if (ch === '\u200d' || ch === '\ufe0f') continue
    width += /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1
  }
  return width
}

/** Cuts a label to what fits a full-width button (the full text belongs in the message). */
export function fit(text: string, columns = ROW_COLUMNS - 2): string {
  if (labelWidth(text) <= columns) return text
  let out = ''
  for (const ch of text) {
    if (labelWidth(`${out}${ch}…`) > columns) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** Like `fit`, but keeps the end: for folder paths, where the last parts say the most. */
export function fitEnd(text: string, columns = ROW_COLUMNS - 2): string {
  if (labelWidth(text) <= columns) return text
  const chars = [...text]
  let out = ''
  for (let i = chars.length - 1; i >= 0; i--) {
    if (labelWidth(`…${chars[i]}${out}`) > columns) break
    out = chars[i] + out
  }
  return `…${out.trimStart()}`
}

/**
 * Buttons in rows, so none gets cut: Telegram gives every button in a row the same width, so a row
 * takes as many as fit at the width of its widest label, up to `max`.
 */
export function layout(buttons: InlineButton[], max = 3): InlineKeyboard {
  const rows: InlineKeyboard = []
  let row: InlineButton[] = []
  let widest = 0
  for (const b of buttons) {
    const width = labelWidth(b.text) + 2
    if (row.length > 0 && (row.length >= max || Math.max(widest, width) * (row.length + 1) > ROW_COLUMNS)) {
      rows.push(row)
      row = []
      widest = 0
    }
    row.push(b)
    widest = Math.max(widest, width)
  }
  if (row.length > 0) rows.push(row)
  return rows
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
  ask: { label: 'ask', hint: 'a question: Claude reads and answers, changes nothing, no plan', plan: false, review: false, execMode: 'plan' },
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
  /** For times (⏰ Later); missing in older callers. */
  now?: number
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
    ...(d.editJob ? [`✏️ <b>Changing #${d.editJob}</b>`] : []),
    d.prompt ? quote(d.prompt, 1500) : '📝 <i>Now send the prompt as your next message.</i>',
    folder,
    `🗺 ${esc(modeLabel(d))} · 🧠 ${esc(d.model)}${d.plan && d.workModel ? ` → ${esc(d.workModel)}` : ''} · ⚡ ${d.effort}`,
    ...(d.editJob ? [] : [chatLabel(d, ctx, chat)]),
    ...(d.notBefore ? [`⏰ starts at ${esc(formatClock(d.notBefore, ctx.now ?? Date.now()))}, or later if others are ahead`] : []),
    ...(d.wantLink ? ['🔗 ends with a live link (a claude.ai page you can open on your phone)'] : []),
  ].join('\n')
  const chatButton = btn('💬 Chat…', `d:${id}:t`)
  const branchButton = startsNewChat(d, ctx) ? [btn(d.isolate ? '📂 Work in place' : '🌿 Own branch', `d:${id}:i`)] : []
  const takeButton = chat?.where ? [btn(d.takeover ? '⏳ Wait instead' : '🤝 Take over', `d:${id}:h`)] : []
  const later = btn(d.notBefore ? '⏰ Later ✓' : '⏰ Later', `d:${id}:a`)
  const link = btn(d.wantLink ? '🔗 Live link ✓' : '🔗 Live link', `d:${id}:l`)
  // Changing a queued task: its folder and conversation stay; the rest can change.
  if (d.editJob) {
    return {
      html,
      keyboard: [
        [btn('✏️ Prompt', `d:${id}:p`), btn('🗺 Mode', `d:${id}:o`), btn('🧠 Model', `d:${id}:m`)],
        ...layout([btn('⚡ Effort', `d:${id}:e`), link, later]),
        [btn('💾 Save', `d:${id}:q`), btn('✖️ Never mind', `d:${id}:x`)],
      ],
    }
  }
  const go = !d.folder
    ? btn('📁 Pick a folder first', `d:${id}:f`)
    : !d.prompt
      ? btn('✍️ Send the prompt…', `d:${id}:k`)
      : btn('▶️ Queue', `d:${id}:q`)
  return {
    html,
    keyboard: [
      [btn('📁 Folder', `d:${id}:f`), btn('🗺 Mode', `d:${id}:o`), btn('🧠 Model', `d:${id}:m`)],
      ...layout([btn('⚡ Effort', `d:${id}:e`), chatButton, ...branchButton, ...takeButton, link, later]),
      [go, btn('✖️ Discard', `d:${id}:x`)],
    ],
  }
}

/** ⏰ Later: when the task may start. */
export function laterView(d: Draft, now: number): View {
  const id = d.id
  const at = (ms: number) => formatClock(ms, now)
  return {
    html:
      `⏰ <b>When may it start?</b>\n` +
      `${d.notBefore ? `Now: at ${esc(at(d.notBefore))}.` : 'Now: as soon as it’s its turn.'}\n` +
      '<i>Or type a time: 23:00, 11pm, in 2h, tomorrow 9am.</i>',
    keyboard: [
      [btn(`🕐 ${at(LATER.hour(now))}`, `d:${id}:a:h`), btn(`🌙 ${at(LATER.tonight(now))}`, `d:${id}:a:n`)],
      [btn(`☀️ ${at(LATER.morning(now))}`, `d:${id}:a:m`), btn('✍️ Type a time', `d:${id}:a:t`)],
      [...(d.notBefore ? [btn('▶️ As soon as it can', `d:${id}:a:c`)] : []), btn('↩️ Back', `d:${id}:k`)],
    ],
  }
}

const PER_PAGE = 12

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
    [btn(fit(`✅ Use ${basename(f.dir)}`), `d:${id}:u:${dirId}`)],
    [
      ...(f.parent ? [btn('⬆️ Up', `d:${id}:b:${ctx.folderId(f.parent)}:0`)] : []),
      btn('⭐ Recent', `d:${id}:r`),
      btn('🔍 Search', `d:${id}:s`),
    ],
    ...layout(
      shown.map(c =>
        btn(
          `${c.isRepo ? '📦 ' : ''}${fit(c.name, ROW_COLUMNS - 6)}${c.hasChildren ? ' ›' : ''}`,
          c.hasChildren ? `d:${id}:b:${ctx.folderId(c.path)}:0` : `d:${id}:u:${ctx.folderId(c.path)}`,
        ),
      ),
      2,
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
      ...chats.map((c, i) => [btn(fit(`${d.sessionId === c.sessionId ? '✓ ' : ''}${i + 1}. ${chatIcon(c)} ${c.title}`), `d:${id}:t:${c.sessionId}`)]),
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
    keyboard: [...chats.map((c, i) => [btn(fit(`${page * CHATS_PER_PAGE + i + 1}. ${chatIcon(c)} ${c.title}`), `c:o:${c.sessionId}`)]), ...(nav.length > 0 ? [nav] : [])],
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
    c.lastReply ? `<b>Claude:</b>\n${quote(markdownToPlain(c.lastReply), 1500)}` : '',
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
      ...recent.map(path => [btn(`📁 ${fitEnd(ctx.label(path), ROW_COLUMNS - 5)}`, `d:${id}:u:${ctx.folderId(path)}`)]),
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
      ...hits.map(h => [btn(`${h.isRepo ? '📦' : '📁'} ${fitEnd(ctx.label(h.path), ROW_COLUMNS - 5)}`, `d:${id}:u:${ctx.folderId(h.path)}`)]),
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
      [btn(`${current === 'ask' ? '✓ ' : ''}💭 ask`, `d:${d.id}:o:ask`), btn(`${current === 'yolo' ? '✓ ' : ''}⚠️ yolo`, `d:${d.id}:o:yolo`)],
      [btn('↩️ Back', `d:${d.id}:k`)],
    ],
  }
}

/** 🧠 Model; with a plan, the model that plans and the one that carries the plan out. */
export function modelView(d: Draft, ctx: UiContext): View {
  const models = [...new Set([...ctx.models, d.model, ...(d.workModel ? [d.workModel] : [])])]
  const plan = layout(models.map(m => btn(`${m === d.model ? '✓ ' : ''}${m}`, `d:${d.id}:m:${m}`)))
  if (!d.plan) return { html: '🧠 <b>Model</b>', keyboard: [...plan, [btn('↩️ Back', `d:${d.id}:k`)]] }
  const work = layout([
    btn(`${d.workModel ? '' : '✓ '}same`, `d:${d.id}:w:same`),
    ...models.filter(m => m !== d.model).map(m => btn(`${m === d.workModel ? '✓ ' : ''}${m}`, `d:${d.id}:w:${m}`)),
  ])
  return {
    html:
      '🧠 <b>Model</b>\n' +
      `<b>Plan with</b> (first row): ${esc(d.model)}\n` +
      `<b>Work with</b> (second row): ${esc(d.workModel ?? 'the same')}\n` +
      '<i>One model writes the plan; once it’s approved, the other carries it out, in the same conversation.</i>',
    keyboard: [...plan, ...work, [btn('↩️ Back', `d:${d.id}:k`)]],
  }
}

export function effortView(d: Draft): View {
  const b = (e: Effort) => btn(`${e === d.effort ? '✓ ' : ''}${e}`, `d:${d.id}:e:${e}`)
  return {
    html: '⚡ <b>Effort</b>\n<i>Higher effort thinks longer and uses more of your usage limit.</i>',
    keyboard: [[b('low'), b('medium'), b('high')], [b('xhigh'), b('max')], [btn('↩️ Back', `d:${d.id}:k`)]],
  }
}

export function queuedView(job: Job, when: string, ctx: UiContext, o: { changed?: boolean } = {}): View {
  const later = job.notBefore && job.notBefore > (ctx.now ?? Date.now()) ? `⏰ Not before ${formatClock(job.notBefore, ctx.now ?? Date.now())}. ` : ''
  return {
    html:
      `${o.changed ? '✏️' : '✅'} <b>${o.changed ? 'Changed' : 'Queued'} #${job.id}</b> · ${esc(ctx.label(job.projectDir))} · ${esc(modeLabel(job))} · ${esc(job.model)}${job.workModel ? `→${esc(job.workModel)}` : ''}/${job.effort}\n` +
      `${quote(job.prompt, 1500)}\n<i>${esc(later)}${esc(when)}</i>`,
    keyboard: [[btn('⬆️ Run next', `j:${job.id}:top`), btn('🗑 Remove', `j:${job.id}:rm`)]],
  }
}

function jobHeader(job: Job, ctx: UiContext): string {
  return `${esc(ctx.label(job.projectDir))} · ${esc(modeLabel(job))} · ${esc(job.model)}${job.workModel ? `→${esc(job.workModel)}` : ''}/${job.effort}`
}

/** Characters per message part: Telegram allows 4,096, and headers need room. */
const PART = 3500
/** Beyond this many parts, the text goes in a file instead. */
const MAX_PARTS = 5

/**
 * Markdown (a plan, Claude's answer) shown under `head`: in the same message when it fits, else
 * as numbered parts that arrive quietly, else the first parts and a file. `keyboard` goes on the
 * last message, after the text.
 */
export function longView(
  head: string,
  md: string | null | undefined,
  keyboard: InlineKeyboard | undefined,
  file: { name: string; caption: string },
  o: { silent?: boolean } = {},
): View {
  const text = (md ?? '').trim()
  if (!text) return { html: head, keyboard, silent: o.silent }
  const parts = markdownParts(text, PART)
  if (parts.length === 1 && htmlToText(head).length + htmlToText(parts[0]!).length <= PART) {
    return { html: `${head}\n\n${parts[0]}`, keyboard, silent: o.silent }
  }
  const truncated = parts.length > MAX_PARTS
  const shown = truncated ? parts.slice(0, 2) : parts
  const follow: View[] = shown.map((html, i) => ({ html: `<i>${truncated ? `Part ${i + 1}` : `Part ${i + 1} of ${parts.length}`}</i>\n${html}`, silent: true }))
  if (truncated) {
    follow.push({ html: `<i>The rest is in ${esc(file.name)} below (${text.length.toLocaleString('en-US')} characters in all).</i>`, silent: true })
  }
  follow.at(-1)!.keyboard = keyboard
  return { html: head, silent: o.silent, follow, ...(truncated ? { file: { ...file, text } } : {}) }
}

/** A finished task's live link: open it, or ask for one. */
function linkButton(job: Job): InlineButton {
  const link = job.links?.[0]
  return link ? { text: '🔗 Live link', url: link.url } : btn('🔗 Get a live link', `j:${job.id}:link`)
}

/** A job's whole plan, for 📄 Full plan. */
export function planView(job: Job, ctx: UiContext): View {
  return longView(`📄 <b>#${job.id} plan</b> · ${esc(ctx.label(job.projectDir))}`, job.planText ?? '(no plan)', undefined, { name: `plan-${job.id}.md`, caption: `#${job.id}'s plan` }, { silent: true })
}

/** What a task card keeps between edits. */
export interface Card {
  /** How the plan was approved, once it was. */
  plan?: string
}

/** A task's card: sent when it starts, then edited as its plan is approved and when it ends. */
export function taskCard(job: Job, card: Card, ctx: UiContext): View {
  const ended = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
  const lines = [`▶️ <b>#${job.id} started</b> · ${jobHeader(job, ctx)}`, quote(job.prompt, 600)]
  if (card.plan !== undefined) lines.push(`📝 Plan approved (${esc(card.plan)})${job.planText ? `\n${quote(markdownToPlain(job.planText), 500)}` : ''}`)
  if (ended) {
    const took = job.startedAt && job.finishedAt ? ` in ${duration(job.finishedAt - job.startedAt)}` : ''
    lines.push(job.status === 'done' ? `✅ <b>Done</b>${took}` : job.status === 'failed' ? `❌ <b>Failed</b>${took}` : '✖️ <b>Cancelled</b>')
  }
  const plan = card.plan !== undefined && job.planText ? [btn('📄 Full plan', `j:${job.id}:plan`)] : []
  const keyboard = ended
    ? plan.length > 0
      ? [plan]
      : undefined
    : [
        [...plan, btn('👀 Peek', `j:${job.id}:peek`), btn('⏹ Stop', `j:${job.id}:stop`)],
        [btn('🛑 Kill', `j:${job.id}:kill`)],
      ]
  return { html: lines.filter(Boolean).join('\n'), keyboard, silent: true }
}

// --- Claude's questions ---------------------------------------------------------------------

/** Where you are in answering a set of questions. */
export interface QuestionState {
  step: number
  answers: (QuestionAnswer | undefined)[]
  /** Options ticked so far on a multi-select question. */
  ticked: number[]
}

export const newQuestionState = (): QuestionState => ({ step: 0, answers: [], ticked: [] })

const letter = (i: number) => String.fromCharCode(65 + i)

/** One question at a time: the question and every option in full, then a full-width button per option. */
export function questionView(job: Job, code: string, questions: Question[], s: QuestionState, minutes: number): View {
  const q = questions[s.step]!
  const multi = q.multiSelect === true
  const options = q.options ?? []
  const picked = s.answers[s.step]
  const head = [
    `❓ <b>#${job.id} asks</b>`,
    q.header ? esc(q.header) : '',
    questions.length > 1 ? `${s.step + 1} of ${questions.length}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const hint = multi ? 'Tick every one that applies, then ✅ Done.' : 'Tap one.'
  const after = `<i>${hint} Or ✍️ type your own answer. If you don't answer within ${minutes}m, Claude decides itself.</i>`
  const render = (descriptionMax: number) =>
    [
      head,
      `<b>${inlineMarkdown(q.question)}</b>`,
      ...options.map(o => `\n<b>${letter(options.indexOf(o))} · ${esc(o.label)}</b>${o.description ? `\n${inlineMarkdown(clip(o.description, descriptionMax))}` : ''}`),
      '',
      after,
    ].join('\n')
  // Everything in full, unless it can't fit in one message: then each description gets a fair share.
  let html = render(10_000)
  if (htmlToText(html).length > PART) {
    const fixed = htmlToText(render(0)).length
    html = render(Math.max(120, Math.floor((PART - fixed) / Math.max(1, options.length))))
  }
  const keyboard: InlineKeyboard = options.map((o, i) => {
    const on = multi ? s.ticked.includes(i) : picked !== undefined && 'picks' in picked && picked.picks.includes(i)
    const mark = multi ? (on ? '☑ ' : '☐ ') : on ? '✓ ' : ''
    return [btn(fit(`${mark}${letter(i)} · ${o.label}`), `o:${code}:${s.step}.${i}`)]
  })
  if (multi) keyboard.push([btn(s.ticked.length > 0 ? `✅ Done (${s.ticked.length} picked)` : '✅ Done', `o:${code}:${s.step}.d`)])
  keyboard.push([btn('✍️ Type an answer', `o:${code}:${s.step}.t`), ...(s.step > 0 ? [btn('⬅️ Back', `o:${code}:${s.step}.b`)] : [])])
  return { html, keyboard }
}

/** The question message once you've answered: every question with your answer, no buttons. */
export function answeredView(job: Job, questions: Question[], answers: (QuestionAnswer | undefined)[]): View {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const value = !a ? '<i>no answer</i>' : 'text' in a ? `“${esc(a.text)}”` : a.picks.map(p => esc(q.options?.[p]?.label ?? '?')).join(', ')
    return `<b>${esc(q.question)}</b>\n→ ${value}`
  })
  return { html: `❓ <b>#${job.id} asked</b> · ✅ answered\n\n${lines.join('\n\n')}` }
}

export interface NoticeContext extends UiContext {
  now: number
}

export function noticeView(n: Notice, ctx: NoticeContext): View {
  switch (n.type) {
    case 'started':
      return taskCard(n.job, {}, ctx)
    case 'plan_approved':
      // Shown on the task's card when there is one; this is for when there isn't.
      return {
        html: `📝 <b>#${n.job.id} plan approved</b> (${esc(n.choice)})\n${quote(n.job.planText ? markdownToPlain(n.job.planText) : null, 500)}`,
        keyboard: n.job.planText ? [[btn('📄 Full plan', `j:${n.job.id}:plan`)]] : undefined,
        silent: true,
      }
    case 'plan_review':
      return longView(
        `📝 <b>#${n.job.id} plan ready for your review</b> · ${esc(ctx.label(n.job.projectDir))}`,
        n.job.planText,
        [[btn('✅ Approve', `a:${n.code}:y`), btn('✏️ Ask for changes', `a:${n.code}:c`)]],
        { name: `plan-${n.job.id}.md`, caption: `#${n.job.id}'s plan` },
      )
    case 'permission':
      return {
        html:
          `🔐 <b>#${n.job.id} wants to use ${esc(n.tool)}</b> · ${esc(ctx.label(n.job.projectDir))}\n` +
          `<pre>${esc(clip(n.detail, 3000))}</pre>\n<i>Denied automatically in ${n.minutes}m.</i>`,
        keyboard: [[btn('✅ Allow', `a:${n.code}:y`), btn('❌ Deny', `a:${n.code}:n`)]],
      }
    case 'question':
      return questionView(n.job, n.code, n.questions, newQuestionState(), n.minutes)
    case 'trust':
      return {
        html: `🔐 <b>#${n.job.id}</b> is the first Claude Code run in <b>${esc(ctx.label(n.job.projectDir))}</b>.\nClaude asks whether to trust this folder.`,
        keyboard: [[btn('✅ Trust it', `a:${n.code}:y`), btn('❌ Cancel the job', `a:${n.code}:n`)]],
      }
    case 'limit': {
      const when = n.at ? `resets ${formatClock(n.at, ctx.now)}` : 'reset time unknown; retrying every 15 minutes'
      return {
        html: `⏸ <b>#${n.job.id} hit the ${windowLabel(n.window)}</b> · ${esc(when)} · it continues on its own`,
        keyboard: [[btn('▶️ Continue now', `j:${n.job.id}:now`), btn('👀 Peek', `j:${n.job.id}:peek`)], [btn('🛑 Kill', `j:${n.job.id}:kill`)]],
      }
    }
    case 'resumed':
      return { html: `▶️ <b>#${n.job.id}</b> continued after the limit reset (${esc(resumedBy(n.how))})`, silent: true }
    case 'done': {
      const took = n.job.startedAt ? ` in ${duration((n.job.finishedAt ?? ctx.now) - n.job.startedAt)}` : ''
      const next = n.next ? `Next: #${n.next.id} · ${jobHeader(n.next, ctx)}` : 'Queue empty.'
      const head = [
        `✅ <b>#${n.job.id} done</b>${took} · ${esc(ctx.label(n.job.projectDir))}`,
        n.diff ? `<i>${esc(n.diff)}</i>` : '',
        n.job.branch ? `🌿 On branch <code>${esc(n.job.branch)}</code>` : '',
        `<i>${next}</i>`,
      ]
        .filter(Boolean)
        .join('\n')
      const branch = n.job.branch && !n.job.branchNote ? [[btn('🌿 Merge', `j:${n.job.id}:merge`), btn('🗑 Discard branch', `j:${n.job.id}:discard`)]] : []
      return longView(head, n.job.lastMessage, [[btn('➕ Follow up', `j:${n.job.id}:fu`), linkButton(n.job)], ...branch], {
        name: `answer-${n.job.id}.md`,
        caption: `#${n.job.id}: Claude's full answer`,
      })
    }
    case 'held':
      return {
        html: `⚠️ <b>#${n.job.id} paused</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [
          [btn('▶️ Go', `j:${n.job.id}:go`), btn('🛑 Kill', `j:${n.job.id}:kill`), btn('👀 Peek', `j:${n.job.id}:peek`)],
          [btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys')],
        ],
      }
    case 'failed':
      return {
        html: `❌ <b>#${n.job.id} failed</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [[btn('▶️ Retry', `j:${n.job.id}:go`), btn('🛑 Kill', `j:${n.job.id}:kill`)]],
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
          [btn('🛑 Kill', `j:${id}:kill`)],
        ],
      }
    }
    case 'took_over':
      return {
        html: `🤝 <b>#${n.job.id} took its chat over from ${esc(n.where)}</b> (closed it there). Reopen it there later to see everything it did.`,
        silent: true,
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
          silent: true,
        }
      }
      if (n.how === 'takeover') {
        return { html: `🤝 <b>Your chat ${name} didn't restart</b> in ${esc(n.where)}, so #${n.jobId} continues it here (closing it there).`, silent: true }
      }
      return { html: `▶️ <b>#${n.jobId} continues your chat ${name}</b> after the usage limit (it was closed in ${esc(n.where)}).`, silent: true }
    }
    case 'recovered':
      return {
        html: `🔁 <b>#${n.job.id}'s window was gone</b> (the Mac restarted?), so it continues where it left off.`,
        keyboard: [[btn('👀 Peek', `j:${n.job.id}:peek`), btn('⏹ Stop', `j:${n.job.id}:stop`), btn('🛑 Kill', `j:${n.job.id}:kill`)]],
        silent: true,
      }
    case 'killed':
      return { html: `🛑 <b>#${n.job.id} killed</b>${n.by ? ` by ${esc(n.by)}` : ''} · ${esc(ctx.label(n.job.projectDir))}`, silent: true }
    case 'link':
      return n.url
        ? { html: `🔗 <b>Live link for #${n.job.id}</b>${n.title ? `: ${esc(n.title)}` : ''}\n<i>Opens where you're signed in to claude.ai.</i>`, keyboard: [[{ text: '🔗 Open the live link', url: n.url }]] }
        : { html: `🔗 <b>No live link for #${n.job.id}</b>: ${esc(clip(n.note ?? 'Claude didn’t make one.', 300))}` }
    case 'setup_warning':
      return { html: `⚠️ ${esc(n.message)}` }
    case 'sleeping':
      if (n.failed) return { html: `😴 <b>The Mac didn't go to sleep.</b> ${esc(n.failed)}` }
      return {
        html:
          `😴 <b>The Mac is going to sleep</b>${n.by ? ` (asked from ${esc(n.by)})` : ''}${n.quit.length ? `, after quitting ${esc(n.quit.join(', '))}` : ''}.\n` +
          "<i>It can't be woken from here: open its lid or press a key.</i>",
      }
    case 'empty':
      return { html: '🏁 Queue empty.', silent: true }
  }
}

// --- 📊 Status ------------------------------------------------------------------------------

export interface StatusInfo {
  active: Job | null
  /** The running task's last tool and when it ran. */
  lastTool: { tool: string; at: number } | null
  /** Requests waiting on you. */
  approvals: Approval[]
  queued: Job[]
  paused: boolean
  limits: LimitState
}

function phaseText(job: Job): string {
  if (job.status === 'held') return `paused: ${job.holdReason ?? 'needs you'}`
  switch (job.phase) {
    case 'launching':
      return 'starting'
    case 'planning':
      return 'planning'
    case 'limited':
      return 'waiting for the limit reset'
    case 'finishing':
      return 'wrapping up'
    default:
      return 'working'
  }
}

function limitLine(name: string, w: { usedPct: number | null; resetsAt: number | null } | undefined, now: number): string {
  if (!w || w.usedPct === null) return ''
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPct)))
  const filled = Math.round(pct / 10)
  const reset = w.resetsAt ? ` · resets ${esc(formatClock(w.resetsAt, now))}` : ''
  return `<code>${name} ${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}</code> ${pct}%${reset}`
}

const WAITING: Record<Approval['kind'], string> = {
  permission: '🔐 a permission request',
  question: '❓ a question',
  review: '📝 its plan, for your review',
  trust: '🔐 trusting its folder',
}

/** 📊 Status: what's running, what's waiting on you (with its buttons), what's next, the limits. */
export function statusView(s: StatusInfo, ctx: NoticeContext): View {
  const lines = ['📊 <b>Status</b>']
  const a = s.active
  if (a) {
    const since = a.startedAt ? ` · ${duration(ctx.now - a.startedAt)}` : ''
    lines.push(`▶️ <b>#${a.id}</b> · ${esc(ctx.label(a.projectDir))} · ${esc(phaseText(a))}${since}`, `“${esc(oneLine(a.prompt, 140))}”`)
    if (s.lastTool) lines.push(`🔧 last: ${esc(s.lastTool.tool)}, ${duration(ctx.now - s.lastTool.at)} ago`)
  } else {
    lines.push(s.paused ? '⏸ Nothing running; the queue is paused.' : '💤 Nothing running.')
  }
  for (const ap of s.approvals) lines.push(`⏳ <b>Waiting on you</b> (#${ap.jobId}): ${WAITING[ap.kind]}`)
  if (s.queued.length > 0) {
    lines.push(`<b>Next</b>${s.queued.length > 3 ? ` (${s.queued.length} waiting)` : ''}:`)
    for (const j of s.queued.slice(0, 3)) lines.push(`• #${j.id} ${esc(ctx.label(j.projectDir))}: “${esc(oneLine(j.prompt, 70))}”`)
  }
  const blocked = s.limits.blockedUntil && s.limits.blockedUntil > ctx.now ? `⏸ New tasks wait for the limit reset at ${esc(formatClock(s.limits.blockedUntil, ctx.now))}` : ''
  const limits = [limitLine('5-hour', s.limits.fiveHour, ctx.now), limitLine('Weekly', s.limits.sevenDay, ctx.now), blocked].filter(Boolean)
  // Readings only come while a task runs: an old one says when it's from.
  const read = s.limits.updatedAt
  const stale = read && ctx.now - read > 30 * 60_000 ? `<i>Usage as of ${esc(formatClock(read, ctx.now))}; it updates while a task runs.</i>` : ''
  if (limits.length > 0) lines.push('', ...limits, ...(stale ? [stale] : []))
  else if (read) lines.push('', `<i>No usage reading since the last reset; it updates while a task runs.</i>`)
  if (s.paused && a) lines.push('⏸ <i>Paused: nothing new starts until you resume.</i>')

  const keyboard: InlineKeyboard = []
  for (const ap of s.approvals.slice(0, 3)) {
    if (ap.kind === 'permission' || ap.kind === 'trust') {
      keyboard.push([btn(ap.kind === 'trust' ? '✅ Trust the folder' : '✅ Allow', `a:${ap.code}:y`), btn(ap.kind === 'trust' ? '❌ Cancel the job' : '❌ Deny', `a:${ap.code}:n`)])
    } else {
      keyboard.push([btn(ap.kind === 'question' ? `❓ Answer #${ap.jobId}'s question` : `📝 Review #${ap.jobId}'s plan`, `a:${ap.code}:show`)])
    }
  }
  keyboard.push(
    [btn('🔄 Refresh', 'g:st'), s.paused ? btn('▶️ Resume', 'g:resume') : btn('⏸ Pause', 'g:pause'), btn('👀 Peek', 'g:peek')],
    [btn('📋 Queue', 'g:q'), btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys')],
  )
  if (a) keyboard.push([btn(`🛑 Kill #${a.id}`, `j:${a.id}:kill`)])
  return { html: lines.join('\n'), keyboard }
}

/**
 * 📋 Queue: the running task, then each waiting one with ⬆️ ⬇️ (move it), ⏸ / ▶️ (hold it in its
 * place, or let it start again) and 🗑, by its number.
 */
export function queueView(active: Job | null, queued: Job[], ctx: UiContext, paused: boolean): View {
  const lines: string[] = ['📋 <b>Queue</b>']
  if (active) lines.push(`▶ <b>#${active.id}</b> ${jobHeader(active, ctx)}\n   “${esc(oneLine(active.prompt, 90))}”`)
  queued.forEach((job, i) =>
    lines.push(`${i + 1}. <b>#${job.id}</b>${job.onHold ? ' ⏸ <i>on hold</i>' : ''} ${jobHeader(job, ctx)}\n   “${esc(oneLine(job.prompt, 90))}”`),
  )
  if (!active && queued.length === 0) lines.push('<i>Nothing queued. Send a prompt to add one.</i>')
  if (paused) lines.push('⏸ <i>Paused: nothing new starts until you resume.</i>')
  const shown = queued.slice(0, 20)
  const keyboard: InlineKeyboard = shown.map((job, i) => [
    ...(i > 0 ? [btn(`⬆️ ${job.id}`, `j:${job.id}:up`)] : []),
    ...(i < queued.length - 1 ? [btn(`⬇️ ${job.id}`, `j:${job.id}:down`)] : []),
    job.onHold ? btn(`▶️ ${job.id}`, `j:${job.id}:rel`) : btn(`⏸ ${job.id}`, `j:${job.id}:hold`),
    btn(`✏️ ${job.id}`, `j:${job.id}:edit`),
    btn(`🗑 ${job.id}`, `j:${job.id}:rm`),
  ])
  keyboard.push([btn('🔄 Refresh', 'g:q'), paused ? btn('▶️ Resume', 'g:resume') : btn('⏸ Pause', 'g:pause'), ...(queued.length > 1 ? [btn('🧹 Clear', 'g:clear')] : [])])
  return { html: lines.join('\n'), keyboard }
}

export function peekView(jobId: number | null, screen: string): View {
  if (jobId === null) return { html: '👀 Nothing is running.', keyboard: [[btn('🔄 Refresh', 'g:peek')]] }
  return {
    html: `👀 <b>#${jobId}</b>\n<pre>${esc(clip(screen, 3500)) || '(blank screen)'}</pre>`,
    keyboard: [
      [btn('🔄 Refresh', 'g:peek'), btn('⏹ Stop', `j:${jobId}:stop`)],
      [btn('⌨️ Type', 'g:type'), btn('🔘 Keys', 'g:keys'), btn('🛑 Kill', `j:${jobId}:kill`)],
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
      // Continuing a chat by itself follows from watching them: it's offered only while they're watched.
      [btn(o.watch ? '👀 Watching other chats ✓' : '👀 Watch other chats', 'g:watch'), ...(o.watch ? [btn(o.autoContinue ? '▶️ Auto-continue ✓' : '▶️ Auto-continue', 'g:auto')] : [])],
      [btn('🔄 Rescan folders', 'g:rescan')],
    ],
  }
}

/** 🖥 /mac: what's open, what keeps the Mac awake, and buttons to quit an app or sleep. */
export function macView(s: MacStatus): View {
  const names = (pids: number[]) => s.apps.filter(a => pids.includes(a.pid)).map(a => esc(a.name))
  const keeping = s.apps.filter(a => a.keepsAwake).map(a => esc(a.name))
  const lines = ['🖥 <b>This Mac</b>']
  if (s.sleepDisabled) {
    const first = names(s.quitFirst)
    lines.push(first.length ? `😴 Sleep is turned off while ${first.join(', ')} runs; 😴 Sleep quits it first.` : '😴 Sleep is turned off on this Mac (pmset disablesleep).')
  } else if (keeping.length) {
    lines.push(`☕ ${keeping.join(', ')} ${keeping.length === 1 ? 'keeps' : 'keep'} it from sleeping by itself.`)
  }
  if (s.sleepWhenDone.on) lines.push(`🌙 Sleeps once the queue is done${s.sleepWhenDone.waiting ? ` (waiting for ${esc(s.sleepWhenDone.waiting)})` : ''}.`)
  if (s.running !== null) lines.push(`▶️ #${s.running} is running: it pauses while the Mac sleeps.`)
  lines.push('', '<i>Tap an app to quit it (tap again to confirm).</i>')
  const apps = [...s.apps].sort((a, b) => Number(b.keepsAwake) - Number(a.keepsAwake))
  const appRows: InlineButton[][] = []
  for (let i = 0; i < apps.length; i += 2) {
    appRows.push(apps.slice(i, i + 2).map(a => btn(`✖️ ${clip(a.name, 24)}${a.kind === 'menu' ? ' ☰' : ''}`, `m:q:${a.pid}`)))
  }
  return {
    html: lines.join('\n'),
    keyboard: [
      [btn('😴 Sleep now', 'm:s'), btn(s.sleepWhenDone.on ? '🌙 Sleep when done ✓' : '🌙 Sleep when done', 'm:d')],
      ...appRows,
      [btn('🔄 Refresh', 'm:r')],
    ],
  }
}

/** 😴 /sleep: what sleeping does, with the button that does it. */
export function sleepView(s: MacStatus): View {
  const first = s.apps.filter(a => s.quitFirst.includes(a.pid)).map(a => esc(a.name))
  const lines = [
    '😴 <b>Put the Mac to sleep?</b>',
    first.length ? `It quits ${first.join(', ')} first (sleep is turned off while it runs).` : '',
    s.running !== null ? `#${s.running} pauses until it wakes.` : '',
    "<i>It can't be woken from here: open its lid or press a key.</i>",
  ]
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: [[btn('😴 Sleep now', 'm:S'), btn(s.sleepWhenDone.on ? '🌙 Already: when done' : '🌙 When the queue is done', 'm:D')]],
  }
}

export const HELP_HTML =
  '<b>Send me what Claude should do.</b> I reply with a card: pick the folder, mode, model and effort with the buttons, then tap ▶️ Queue. ' +
  'It starts with the choices you used last, so usually you just tap ▶️ Queue.\n\n' +
  `${KEYS.newTask}: pick the folder first, then send the prompt.\n` +
  `${KEYS.chats}: any chat from any project, VS Code ones too. Open one and tap ✍️ Write here: everything you type then goes into that chat until you leave.\n` +
  '⌨️ Type and 🔘 Keys (on Peek and Status) type into the running task or press keys in it.\n' +
  '💬 Chat… on a card continues any chat in that folder, including one open in VS Code: 🤝 Take over closes it there and continues it here.\n' +
  '⏰ Later on a card picks when it may start. In 📋 Queue, ✏️ changes a waiting task (its prompt, mode, model, effort, live link, time).\n' +
  '🖥 /mac: what is open on the Mac, to quit an app (Vorssaint, say), and 😴 sleep it now or once the queue is done. /sleep goes straight there.\n' +
  `${KEYS.queue} · ${KEYS.status} · ${KEYS.peek}\n\n` +
  "I'll message you when a plan is ready, when Claude needs permission or has a question (one question at a time, every option in full), when a usage limit pauses work, and when a job finishes. " +
  'News that needs nothing from you arrives silently. ' +
  'When a chat in VS Code or a terminal hits a usage limit, I offer to continue it here after the reset.\n\n' +
  'Commands: /new /queue /status /peek /kill /mac /sleep /pause /resume /settings /cancel\n' +
  'Typing <code>q myapp plan opus max: …</code> still works too.'

/** What a tool asks to do, in words. */
function toolAction(tool: string): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return 'run a command'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'change a file'
    case 'Read':
      return 'read a file'
    case 'WebFetch':
      return 'open a web page'
    case 'WebSearch':
      return 'search the web'
    default:
      return `use ${tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool}`
  }
}
