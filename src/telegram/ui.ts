import { basename } from 'node:path'
import { BRAND } from '../shared/brand'
import type { Approval, Effort, ExecMode, Job, LimitState } from '../shared/types'
import { chatState, type Chat } from '../daemon/chats'
import type { FolderEntry, SearchHit } from '../daemon/folders'
import { duration } from '../daemon/format'
import { formatClock, windowLabel } from '../daemon/limits'
import type { PowerStatus } from '../daemon/power'
import { machineWord } from '../platform/power'
import { resumedBy, type Notice, type Question, type QuestionAnswer } from '../daemon/notify'
import type { InlineButton, InlineKeyboard, ReplyKeyboard } from './api'
import { htmlToText, inlineMarkdown, markdownParts, markdownToPlain } from './markdown'
import type { Draft } from './state'
import { LATER } from './when'

// Everything the bot shows, as pure functions: text in Telegram's HTML subset plus buttons.
//
// The buttons are plain words. A chosen value is marked ✓; what's open (a tab of the task card, the
// plan or the work) is marked •. Buttons stay where they are: a row has the same buttons whatever is
// chosen, only their marks change, and a choice opens under the card's tabs instead of on a screen of
// its own that needs a Back. Something that asks twice (Kill, Sleep now, Clear) asks on the button
// itself: its label turns into "Tap again to …".
//
// Button data stays under Telegram's 64-byte limit:
//   d:<draft>:<op>[:<arg>…]  a task card    a:<code>:y|n|c|…  an approval
//   o:<code>:<step>.<opt>|d|t|b  a question (pick, done, type, back)   j:<job>:<op>  a task   g:<op>  global
//   w:<session>:c|f|x        one of your other chats (it hit a usage limit)
//   c:l:<page> · c:o|w|r:<session> · c:x   your chats: a page, open one, write in it, its full reply, leave it
//   m:<op>                   this computer: awake and asleep
// Data ending in ! is the second tap of something that asks twice.

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

/** A chosen value: ✓ before it. */
const chosen = (yes: boolean, label: string): string => (yes ? `✓ ${label}` : label)
/** What's open: • before it. */
const opened = (yes: boolean, label: string): string => (yes ? `• ${label}` : label)
const onOff = (on: boolean): string => (on ? 'on' : 'off')

/** Buttons in rows of `per`, in order, so each keeps its place whatever is chosen. */
function rows(buttons: InlineButton[], per: number): InlineKeyboard {
  const out: InlineKeyboard = []
  for (let i = 0; i < buttons.length; i += per) out.push(buttons.slice(i, i + per))
  return out
}

/** How many number buttons go in a row. */
export const NUMBERS_PER_ROW = 5

/**
 * A choice by its number: the message lists every choice in full ("1. …", "2. …"), and the buttons
 * under it are only the numbers, so nothing is ever cut off to fit a button. `chosen` marks one ✓.
 */
export function numberRows(items: { data: string; chosen?: boolean }[], first = 1): InlineButton[][] {
  return rows(
    items.map((item, i) => btn(chosen(item.chosen === true, String(first + i)), item.data)),
    NUMBERS_PER_ROW,
  )
}

/** A choice's line in the message: its number, then its text in full. */
export const numbered = (n: number, text: string): string => `<b>${n}.</b> ${text}`

function quote(text: string | null | undefined, max: number): string {
  const t = clip(text, max)
  if (!t) return ''
  return `<blockquote${t.length > 300 ? ' expandable' : ''}>${esc(t)}</blockquote>`
}

// --- the keys under the text box ---------------------------------------------------------------

export const KEYS = {
  newTask: 'New task',
  status: 'Status',
  queue: 'Queue',
  tasks: 'Tasks',
  chats: 'Chats',
  settings: 'Settings',
  help: 'Help',
  leave: 'Leave chat',
}

/** What the keys said before the bot's new look: phones show them until the bot sends the new ones. */
export const OLD_KEYS: Record<string, keyof typeof KEYS | 'peek'> = {
  '➕ New task': 'newTask',
  '📋 Queue': 'queue',
  '📊 Status': 'status',
  '👀 Peek': 'peek',
  '💬 Chats': 'chats',
  '⬅️ Leave chat': 'leave',
}

/** The key for this computer: "Mac", "PC" or "Computer". */
export const machineKey = (word: string): string => word[0]!.toUpperCase() + word.slice(1)

/**
 * The keys that stay under the text box. They're the same inside a chat, except the first, which
 * leaves it: nothing else moves.
 */
export function mainKeyboard(machine: string, inChat?: string | null): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: inChat ? KEYS.leave : KEYS.newTask }, { text: KEYS.status }, { text: KEYS.queue }],
      [{ text: KEYS.tasks }, { text: KEYS.chats }, { text: machineKey(machine) }],
      [{ text: KEYS.settings }, { text: KEYS.help }],
    ],
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: inChat ? clip(`Write to “${inChat}”`, 64) : 'Type a task for Claude',
  }
}

// --- words for the choices ------------------------------------------------------------------------

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function effortLabel(e: Effort | string): string {
  return ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' } as Record<string, string>)[e] ?? e
}

/** "opus" → "Opus"; a full model id stays as it is. */
export function modelLabel(model: string): string {
  return /^[a-z]+$/.test(model) ? model[0]!.toUpperCase() + model.slice(1) : model
}

const modelEffort = (model: string, effort: Effort): string => `${modelLabel(model)} · ${effortLabel(effort)}`

/** How it goes about it: plan first, plan you approve, straight to work, or only answer. */
export const HOW = {
  plan: { label: 'Plan first', summary: 'Plan first', hint: `Claude plans, ${BRAND.name} approves the plan, then Claude does the work.`, plan: true, review: false },
  review: { label: 'Plan, I approve', summary: 'Plan, you approve it', hint: 'Claude plans and waits for your yes before it works.', plan: true, review: true },
  none: { label: 'Just do it', summary: 'No plan', hint: 'No plan: Claude starts on the work right away.', plan: false, review: false },
  ask: { label: 'Only answer', summary: 'Only answers', hint: 'Claude reads and answers, and changes nothing.', plan: false, review: false },
} as const
export type HowKey = keyof typeof HOW

/** What it may do without asking (not for an answer). */
export const PERMISSIONS = {
  auto: { label: 'Auto', hint: 'safe steps go ahead; anything risky asks you first.', execMode: 'auto' },
  edits: { label: 'Accept edits', hint: 'file edits go ahead; anything else asks you first.', execMode: 'acceptEdits' },
  yolo: { label: 'No prompts', hint: 'nothing asks first.', execMode: 'bypassPermissions' },
} as const satisfies Record<string, { label: string; hint: string; execMode: ExecMode }>
export type PermissionKey = keyof typeof PERMISSIONS

export function howOf(d: { plan: boolean; review: boolean; execMode: ExecMode }): HowKey {
  return d.execMode === 'plan' ? 'ask' : d.review ? 'review' : d.plan ? 'plan' : 'none'
}

export function permissionOf(d: { execMode: ExecMode }): PermissionKey {
  return d.execMode === 'bypassPermissions' ? 'yolo' : d.execMode === 'acceptEdits' ? 'edits' : 'auto'
}

type Setup = Pick<Job, 'plan' | 'review' | 'execMode' | 'model' | 'effort'> & { workModel?: string | null; workEffort?: Effort | null }

/** Whether a plan is carried out by another model or at another effort. */
function splitWork(j: Setup): boolean {
  return j.plan && Boolean((j.workModel && j.workModel !== j.model) || (j.workEffort && j.workEffort !== j.effort))
}

/** One line for how a task runs: "Plan first · Auto · Opus, High → Sonnet, Low". */
export function setupLine(j: Setup): string {
  const how = HOW[howOf(j)].summary
  const perm = j.execMode === 'plan' ? '' : ` · ${PERMISSIONS[permissionOf(j)].label}`
  const work = splitWork(j) ? ` → ${modelLabel(j.workModel ?? j.model)}, ${effortLabel(j.workEffort ?? j.effort)}` : ''
  return `${how}${perm} · ${modelLabel(j.model)}, ${effortLabel(j.effort)}${work}`
}

export interface UiContext {
  /** For times (Later); missing in older callers. */
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
  /** When the 5-hour limit resets, while that's still ahead. */
  resetsAt?: number | null
  /** The running and waiting tasks, for "after #N". */
  ahead?: { id: number; prompt: string }[]
  /** "Mac", "computer" or "PC". */
  machine?: string
}

// --- the task card ----------------------------------------------------------------------------------

/** A new conversation starts here (rather than continuing one), so branch isolation applies. */
function startsNewChat(d: Draft, ctx: UiContext): boolean {
  return !d.sessionId && (d.newChat || !d.folder || !ctx.hasConversation(d.folder))
}

/** Whether the draft starts later than "as soon as it's its turn". */
export function startsLater(d: Pick<Draft, 'notBefore' | 'repeatDaily' | 'atReset' | 'afterJob'>): boolean {
  return Boolean(d.notBefore || d.repeatDaily !== null || d.atReset || d.afterJob !== null)
}

export function timeOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** When it starts, in a few words. */
function startText(d: Draft, ctx: UiContext): string {
  const now = ctx.now ?? Date.now()
  if (d.repeatDaily !== null) return `every day at ${timeOfDay(d.repeatDaily)}`
  if (d.atReset) return ctx.resetsAt ? `at ${formatClock(ctx.resetsAt, now)}, when the 5-hour limit resets` : 'when the 5-hour limit resets'
  if (d.afterJob !== null) return `after #${d.afterJob} has finished well`
  if (d.notBefore) return `at ${formatClock(d.notBefore, now)}`
  if (d.front) return 'next, before the others'
  return 'now'
}

/** Which conversation, in a few words. */
function chatLine(d: Draft, ctx: UiContext, chat: Chat | null): string {
  if (!d.sessionId) {
    if (!startsNewChat(d, ctx)) return '<b>continues the last chat</b> in this folder'
    return `<b>new</b>, ${d.isolate ? 'on its own branch' : 'in your checkout'}`
  }
  const head = d.followJob ? `<b>follows up #${d.followJob}</b>` : `<b>continues “${esc(clip(chat?.title ?? d.sessionId.slice(0, 8), 120))}”</b>`
  if (!chat?.where) return head
  return (
    `${head}, open in ${esc(chat.where)}${chat.busy ? ' and working' : ''}: ` +
    (d.takeover ? `takes it over when it starts${chat.busy ? ' (after that turn)' : ''}, closing it there` : 'starts once you close it there')
  )
}

function limitText(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

/** What the card always shows: one line per choice, in the order of the tabs under it. */
function summaryLines(d: Draft, ctx: UiContext, chat: Chat | null): string[] {
  const how = howOf(d)
  const split = d.plan
  const work = d.workModel || d.workEffort ? modelEffort(d.workModel ?? d.model, d.workEffort ?? d.effort) : 'same as the plan'
  const extras = [
    d.wantLink ? 'a live link at the end' : '',
    d.maxMinutes ? `stops after ${limitText(d.maxMinutes)} of work` : '',
  ].filter(Boolean)
  return [
    `Folder: ${d.folder ? `<b>${esc(ctx.label(d.folder))}</b>` : '<i>pick one</i>'}`,
    ...(d.editJob ? [] : [`Chat: ${chatLine(d, ctx, chat)}`]),
    `How: <b>${HOW[how].summary}</b>${how === 'ask' ? '' : ` · ${PERMISSIONS[permissionOf(d)].label}`}`,
    ...(split ? [`Plan: <b>${esc(modelEffort(d.model, d.effort))}</b>`, `Work: <b>${esc(work)}</b>`] : [`Model: <b>${esc(modelEffort(d.model, d.effort))}</b>`]),
    `Starts: <b>${esc(startText(d, ctx))}</b>`,
    ...(extras.length > 0 ? [`Also: ${extras.join(' · ')}`] : []),
    ...(d.editJob ? [] : [attachLine(d.attachments.length)]),
  ]
}

/** Most screenshots and files one task can have. */
export const MAX_ATTACHMENTS = 10

/** Screenshots on the card, or how to add them: Telegram's 📎 is all it takes, but nothing says so otherwise. */
function attachLine(n: number): string {
  if (n === 0) return '📎 Screenshots: <i>send them here (📎 → Photo or File), up to 10, then tap Queue.</i>'
  return `📎 Screenshots and files: <b>${n} attached</b>${n < MAX_ATTACHMENTS ? '. Send more here, or remove them below.' : ' (the most a task can have).'}`
}

/** The card's tabs, each with what it shows above them. */
export type Tab = 'folder' | 'chat' | 'how' | 'model' | 'when' | 'more'
const TABS: Tab[] = ['folder', 'chat', 'how', 'model', 'when', 'more']
/** A card changing a waiting task: its folder and conversation stay. */
const EDIT_TABS: Tab[] = ['how', 'model', 'when', 'more']

/** What the card has open: a tab, and in it the work rather than the plan, or a folder being browsed or searched. */
export interface CardView {
  tab: Tab | null
  /** Model tab: setting the work (else the plan). */
  work: boolean
  folder: { mode: 'recent' } | { mode: 'browse'; page: number } | { mode: 'search'; query: string }
}

/** The card's open tab, as kept on the draft: "model:work", "folder:browse:2", "folder:search:api"… */
export function parseView(view: string | null | undefined): CardView {
  const [tab, sub, ...rest] = (view ?? '').split(':')
  const out: CardView = { tab: TABS.includes(tab as Tab) ? (tab as Tab) : null, work: false, folder: { mode: 'recent' } }
  if (out.tab === 'model') out.work = sub === 'work'
  if (out.tab === 'folder' && sub === 'browse') out.folder = { mode: 'browse', page: Math.max(0, Number(rest[0]) || 0) }
  if (out.tab === 'folder' && sub === 'search') out.folder = { mode: 'search', query: rest.join(':') }
  return out
}

/** What a tab needs from the machine: recent folders, a folder's subfolders, search hits, the folder's chats. */
export interface CardExtras {
  recent?: string[]
  browse?: FolderPage
  hits?: SearchHit[]
  chats?: { list: Chat[]; hasLast: boolean }
}

interface Section {
  html: string
  rows: InlineKeyboard
}

const PER_PAGE = 12

export interface FolderPage {
  dir: string
  parent: string | null
  children: FolderEntry[]
  page: number
}

function folderSection(d: Draft, ctx: UiContext, x: CardExtras, v: CardView): Section {
  const id = d.id
  const use = (path: string) => `d:${id}:u:${ctx.folderId(path)}`
  if (v.folder.mode === 'browse' && x.browse) {
    const f = x.browse
    const pages = Math.max(1, Math.ceil(f.children.length / PER_PAGE))
    const page = Math.min(Math.max(f.page, 0), pages - 1)
    const shown = f.children.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
    const dirId = ctx.folderId(f.dir)
    const first = page * PER_PAGE + 1
    const html =
      `<b>${esc(ctx.label(f.dir))}</b>\n` +
      (f.children.length === 0
        ? '<i>No folders inside. Use this folder picks it.</i>'
        : `${shown.map((c, i) => numbered(first + i, `${esc(c.name)}${c.isRepo ? ' (git)' : ''}${c.hasChildren ? ' ›' : ''}`)).join('\n')}\n` +
          `<i>${f.children.length} folders${pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}. A number with › opens that folder; one without picks it.</i>`)
    const goTo = (p: number) => `d:${id}:b:${dirId}:${Math.min(Math.max(p, 0), pages - 1)}`
    return {
      html,
      rows: [
        ...numberRows(
          shown.map(c => ({ data: c.hasChildren ? `d:${id}:b:${ctx.folderId(c.path)}:0` : use(c.path), chosen: c.path === d.folder })),
          first,
        ),
        ...(pages > 1 ? [[btn('Previous page', goTo(page - 1)), btn('Next page', goTo(page + 1))]] : []),
        [btn(chosen(f.dir === d.folder, 'Use this folder'), use(f.dir))],
        [btn('Up', f.parent ? `d:${id}:b:${ctx.folderId(f.parent)}:0` : goTo(0)), btn('Recent', `d:${id}:v:folder`), btn('Search', `d:${id}:s`)],
      ],
    }
  }
  if (v.folder.mode === 'search') {
    const hits = x.hits ?? []
    return {
      html:
        `<b>Folders matching “${esc(v.folder.query)}”</b>\n` +
        (hits.length > 0
          ? `${hits.map((h, i) => numbered(i + 1, `${esc(ctx.label(h.path))}${h.isRepo ? ' (git)' : ''}`)).join('\n')}\n<i>Tap a number to use that folder.</i>`
          : '<i>None. Search again with another word, or browse.</i>'),
      rows: [...numberRows(hits.map(h => ({ data: use(h.path), chosen: h.path === d.folder }))), [btn('Search again', `d:${id}:s`), btn('Browse', `d:${id}:f`), btn('Recent', `d:${id}:v:folder`)]],
    }
  }
  const recent = x.recent ?? []
  return {
    html:
      '<b>Recent folders</b>\n' +
      (recent.length > 0
        ? `${recent.map((path, i) => numbered(i + 1, esc(ctx.label(path)))).join('\n')}\n<i>Tap a number to use that folder, or Browse or Search for another.</i>`
        : '<i>None yet. Browse your code folders, or Search by name.</i>'),
    rows: [...numberRows(recent.map(path => ({ data: use(path), chosen: path === d.folder }))), [btn('Browse', `d:${id}:f`), btn('Search', `d:${id}:s`)]],
  }
}

function chatSection(d: Draft, ctx: UiContext, x: CardExtras): Section {
  const id = d.id
  if (!d.folder) return { html: '<i>Pick a folder first: a chat belongs to its folder.</i>', rows: [] }
  const { list, hasLast } = x.chats ?? { list: [], hasLast: false }
  const now = ctx.now ?? Date.now()
  const fresh = startsNewChat(d, ctx)
  const chat = d.sessionId ? ctx.chat(d.sessionId) : null
  const lines = list.map((c, i) => {
    const state = chatState(c)
    const prompt = c.lastPrompt ? `\n   <i>“${esc(clip(c.lastPrompt, 120))}”</i>` : ''
    return numbered(i + 1, `<b>${esc(clip(c.title, 200))}</b>${state ? ` · ${esc(state)}` : ''} · ${duration(now - c.updatedAt)} ago${prompt}`)
  })
  const html = [
    `<b>Chats in ${esc(ctx.label(d.folder))}</b>`,
    `<b>New chat</b>: a fresh conversation${fresh ? `, ${d.isolate ? 'on its own branch (your checkout stays as it is)' : 'in your checkout'}` : ''}.`,
    hasLast ? `<b>Last chat</b>: the last ${BRAND.name} chat in this folder.` : '',
    lines.length > 0 ? `${lines.join('\n')}\n<i>Tap a number to continue that chat, VS Code ones included.</i>` : '<i>No Claude Code chats here yet.</i>',
    chat?.where
      ? `<i>It's open in ${esc(chat.where)}. Take over on: it's closed there when the task starts. Off: the task waits until you close it there.</i>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    html,
    rows: [
      [btn(chosen(fresh, 'New chat'), `d:${id}:t:new`), ...(hasLast ? [btn(chosen(!d.sessionId && !fresh, 'Last chat'), `d:${id}:t:last`)] : [])],
      ...numberRows(list.map(c => ({ data: `d:${id}:t:${c.sessionId}`, chosen: d.sessionId === c.sessionId }))),
      ...(fresh ? [[btn(`Own branch: ${onOff(d.isolate)}`, `d:${id}:i`)]] : []),
      ...(chat?.where ? [[btn(`Take over: ${onOff(d.takeover)}`, `d:${id}:h`)]] : []),
    ],
  }
}

function howSection(d: Draft): Section {
  const id = d.id
  const how = howOf(d)
  const perm = permissionOf(d)
  const h = (key: HowKey) => btn(chosen(key === how, HOW[key].label), `d:${id}:o:h:${key}`)
  const p = (key: PermissionKey) => btn(chosen(how !== 'ask' && key === perm, PERMISSIONS[key].label), `d:${id}:o:p:${key}`)
  return {
    html: [
      '<b>How it goes about it</b>',
      ...(Object.keys(HOW) as HowKey[]).map(k => `<b>${HOW[k].label}</b>: ${HOW[k].hint}`),
      '',
      '<b>What it may do without asking</b>',
      ...(Object.keys(PERMISSIONS) as PermissionKey[]).map(k => `<b>${PERMISSIONS[k].label}</b>: ${PERMISSIONS[k].hint}`),
      ...(how === 'ask' ? ['<i>An answer changes nothing, so it never asks.</i>'] : []),
    ].join('\n'),
    rows: [[h('plan'), h('review')], [h('none'), h('ask')], [p('auto'), p('edits'), p('yolo')]],
  }
}

function modelSection(d: Draft, ctx: UiContext, v: CardView): Section {
  const id = d.id
  const models = [...new Set([...ctx.models, d.model, ...(d.workModel ? [d.workModel] : [])])]
  const effortRows = (current: Effort, op: string) =>
    rows(
      EFFORTS.map(e => btn(chosen(e === current, effortLabel(e)), `d:${id}:${op}:${e}`)),
      3,
    )
  if (!d.plan) {
    return {
      html: [
        '<b>Model and effort</b>',
        '<i>Higher effort thinks longer and uses more of your usage limit.</i>',
        !d.plan ? '<i>To plan with one model and effort and work with another (plan at High, work at Low), pick Plan first in How.</i>' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      rows: [...rows(models.map(m => btn(chosen(m === d.model, modelLabel(m)), `d:${id}:m:${m}`)), 3), ...effortRows(d.effort, 'e')],
    }
  }
  const work = v.work
  const workModel = d.workModel ?? d.model
  const workEffort = d.workEffort ?? d.effort
  return {
    html: work
      ? '<b>Setting the work</b>\n<i>The model and effort that carry the approved plan out, in the same conversation. Tap Plan to set the ones that write it.</i>'
      : '<b>Setting the plan</b>\n<i>The model and effort that write the plan. Tap Work to set the ones that carry it out: say High to plan and Low to work.</i>',
    rows: [
      [btn(opened(!work, 'Plan'), `d:${id}:v:model`), btn(opened(work, 'Work'), `d:${id}:v:work`)],
      ...rows(models.map(m => btn(chosen(m === (work ? workModel : d.model), modelLabel(m)), `d:${id}:${work ? 'w' : 'm'}:${m}`)), 3),
      ...effortRows(work ? workEffort : d.effort, work ? 'we' : 'e'),
    ],
  }
}

function whenSection(d: Draft, ctx: UiContext): Section {
  const id = d.id
  const now = ctx.now ?? Date.now()
  const at = (ms: number) => esc(formatClock(ms, now))
  const ahead = (ctx.ahead ?? []).filter(j => j.id !== d.editJob).slice(0, 10)
  const resets = ctx.resetsAt && ctx.resetsAt > now ? ctx.resetsAt : null
  const later = startsLater(d)
  const is = (ms: number) => d.notBefore === ms && d.repeatDaily === null && !d.atReset && d.afterJob === null
  return {
    html: [
      '<b>When it starts</b>',
      '<b>Now</b>: when it’s its turn. <b>Next</b>: before everything waiting.',
      `<b>In an hour</b>: ${at(LATER.hour(now))} · <b>Tonight</b>: ${at(LATER.tonight(now))} · <b>Morning</b>: ${at(LATER.morning(now))}`,
      resets ? `<b>At the reset</b>: ${at(resets)}, when the 5-hour limit resets.` : '<b>At the reset</b>: not known right now; it’s learned while a task runs.',
      `<b>Type a time</b>: 23:00, 11pm, in 2h, tomorrow 9am. <b>Every day</b>: at that time daily, on this ${esc(ctx.machine ?? 'computer')}’s clock.`,
      ahead.length > 0 ? `<b>After a task</b> has finished well (if it fails, this one doesn’t run):\n${ahead.map((j, i) => numbered(i + 1, `#${j.id} ${esc(oneLine(j.prompt, 70))}`)).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    rows: [
      [btn(chosen(!later && !d.front, 'Now'), `d:${id}:a:c`), btn(chosen(!later && d.front, 'Next'), `d:${id}:a:x`), btn(chosen(d.atReset, 'At the reset'), `d:${id}:a:r`)],
      [btn('In an hour', `d:${id}:a:h`), btn(chosen(is(LATER.tonight(now)), 'Tonight'), `d:${id}:a:n`), btn(chosen(is(LATER.morning(now)), 'Morning'), `d:${id}:a:m`)],
      [btn('Type a time', `d:${id}:a:t`), btn(d.repeatDaily !== null ? `✓ Every day ${timeOfDay(d.repeatDaily)}` : 'Every day at…', `d:${id}:a:d`)],
      ...numberRows(ahead.map(j => ({ data: `d:${id}:a:j:${j.id}`, chosen: d.afterJob === j.id }))),
    ],
  }
}

/** The time limits on offer, in minutes (0: none). */
export const TIME_LIMITS = [0, 30, 60, 120, 240]

function moreSection(d: Draft, ctx: UiContext): Section {
  const id = d.id
  return {
    html: [
      '<b>More</b>',
      `Live link: <b>${onOff(d.wantLink)}</b>. It ends with a claude.ai page showing the result, to open on your phone.`,
      `Time limit: <b>${d.maxMinutes ? limitText(d.maxMinutes) : 'none'}</b>. It stops after that much work; you can let it go on.`,
    ]
      .filter(Boolean)
      .join('\n'),
    rows: [
      [btn(`Live link: ${onOff(d.wantLink)}`, `d:${id}:l`)],
      TIME_LIMITS.map(m => btn(chosen((d.maxMinutes ?? 0) === m, m === 0 ? 'None' : m < 60 ? `${m}m` : `${m / 60}h`), `d:${id}:tl:${m}`)),
    ],
  }
}

/**
 * The task card: the prompt and one line per choice, then the tabs that change them and Queue. A tab
 * opens its choices above the tabs; picking one changes the card in place and leaves the tab open.
 */
export function draftCard(d: Draft, ctx: UiContext, x: CardExtras = {}): View {
  const id = d.id
  const editing = d.editJob !== null
  const v = parseView(d.view)
  const tab = v.tab && (editing ? EDIT_TABS : TABS).includes(v.tab) ? v.tab : null
  const chat = d.sessionId ? ctx.chat(d.sessionId) : null
  const prompt = d.prompt
    ? quote(d.prompt, 1500)
    : d.folder
      ? '<i>Now send the prompt as your next message.</i>'
      : '<i>Pick a folder, then send the prompt as your next message.</i>'
  const section =
    tab === 'folder'
      ? folderSection(d, ctx, x, v)
      : tab === 'chat'
        ? chatSection(d, ctx, x)
        : tab === 'how'
          ? howSection(d)
          : tab === 'model'
            ? modelSection(d, ctx, v)
            : tab === 'when'
              ? whenSection(d, ctx)
              : tab === 'more'
                ? moreSection(d, ctx)
                : null
  const html = [editing ? `<b>Changing #${d.editJob}</b>` : '<b>New task</b>', prompt, ...summaryLines(d, ctx, chat), ...(section ? ['', section.html] : [])].join('\n')
  const t = (key: Tab, label: string) => btn(opened(tab === key, label), `d:${id}:v:${tab === key ? '-' : key}`)
  const tabs: InlineKeyboard = editing
    ? [
        [btn('Prompt', `d:${id}:p`), t('how', 'How'), t('model', 'Model')],
        [t('when', 'When'), t('more', 'More')],
      ]
    : [
        [t('folder', 'Folder'), t('chat', 'Chat'), t('how', 'How')],
        [t('model', 'Model'), t('when', 'When'), t('more', 'More')],
      ]
  return {
    html,
    keyboard: [
      ...(section?.rows ?? []),
      ...tabs,
      ...(!editing && d.attachments.length > 0 ? [[btn(`📎 Remove the ${d.attachments.length === 1 ? 'attached file' : `${d.attachments.length} attached`}`, `d:${id}:at:x`)]] : []),
      editing ? [btn('Save', `d:${id}:q`), btn('Cancel', `d:${id}:x`)] : [btn('Queue', `d:${id}:q`), btn('Discard', `d:${id}:x`)],
    ],
  }
}

// --- your chats ---------------------------------------------------------------------------------------

export const CHATS_PER_PAGE = 8

/** Your recent chats from every project, newest first. */
/** Tells the owner a newer release is out and what to type on the computer. */
export function updateView(latest: string, current: string, command: string, name: string): View {
  return {
    html:
      `<b>${esc(name)} ${esc(latest)} is out</b> (this computer has ${esc(current)}).\n` +
      `On the computer, run: <code>${esc(command)}</code>\n` +
      '<i>It restarts itself with the new version; tasks keep going.</i>',
    silent: true,
  }
}

export function recentChatsView(chats: Chat[], page: number, more: boolean, ctx: NoticeContext): View {
  const lines = chats.map((c, i) => {
    const state = chatState(c)
    return numbered(page * CHATS_PER_PAGE + i + 1, `<b>${esc(clip(c.title, 200))}</b>\n   ${esc(c.cwd ? ctx.label(c.cwd) : '?')}${state ? ` · ${esc(state)}` : ''} · ${duration(ctx.now - c.updatedAt)} ago`)
  })
  const html =
    chats.length > 0
      ? `<b>Your chats</b>, newest first${page > 0 ? ` · page ${page + 1}` : ''}\n${lines.join('\n')}\n<i>Tap a number to open that chat.</i>`
      : page > 0
        ? '<i>No older chats.</i>'
        : '<i>No Claude Code chats yet.</i>'
  const nav = [...(page > 0 ? [btn('Newer', `c:l:${page - 1}`)] : []), ...(more ? [btn('Older', `c:l:${page + 1}`)] : [])]
  return {
    html,
    keyboard: [...numberRows(chats.map(c => ({ data: `c:o:${c.sessionId}` })), page * CHATS_PER_PAGE + 1), ...(nav.length > 0 ? [nav] : [])],
  }
}

/** One chat: where it is, your last prompt and Claude's last reply. */
export function chatView(c: Chat, ctx: NoticeContext, inside: boolean): View {
  const state = chatState(c)
  const long = (c.lastReply?.length ?? 0) > 1500
  const html = [
    `<b>${esc(clip(c.title, 120))}</b>`,
    `${esc(c.cwd ? ctx.label(c.cwd) : '?')}${state ? ` · ${esc(state)}` : ''} · ${duration(ctx.now - c.updatedAt)} ago`,
    c.lastPrompt ? `<b>You:</b>\n${quote(c.lastPrompt, 500)}` : '',
    c.lastReply ? `<b>Claude:</b>\n${quote(markdownToPlain(c.lastReply), 1500)}` : '',
    inside ? "<i>You're in this chat: what you type goes here.</i>" : '<i>Write here: everything you type then goes into this chat, until you leave it.</i>',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    html,
    keyboard: [[inside ? btn('Leave chat', 'c:x') : btn('Write here', `c:w:${c.sessionId}`), btn('Full reply', `c:r:${c.sessionId}`)], [btn('All chats', 'c:l:0')]],
  }
}

/** Sent when you enter a chat, with the keys for being inside it. */
export function enteredChatHtml(c: Chat, ctx: NoticeContext): string {
  const open = c.where ? ` It's open in ${esc(c.where)}: your first message closes it there and continues it here.` : ''
  return (
    `<b>You're in “${esc(clip(c.title, 80))}”</b> · ${esc(c.cwd ? ctx.label(c.cwd) : '?')}\n` +
    `Everything you type now goes into this chat, as if you typed it there.${open}\n<i>Tap ${KEYS.leave} under the text box to stop.</i>`
  )
}

// --- after it's queued --------------------------------------------------------------------------------

export function queuedView(job: Job, when: string, ctx: UiContext, o: { changed?: boolean } = {}): View {
  const now = ctx.now ?? Date.now()
  const later = job.notBefore && job.notBefore > now ? `Not before ${formatClock(job.notBefore, now)}. ` : ''
  return {
    html:
      `<b>${o.changed ? 'Changed' : 'Queued'} #${job.id}</b> · ${esc(ctx.label(job.projectDir))}\n` +
      `${quote(job.prompt, 1500)}\n${esc(setupLine(job))}\n<i>${esc(later)}${esc(when)}</i>`,
    keyboard: [[btn('Run next', `j:${job.id}:top`), btn('Change', `j:${job.id}:edit`), btn('Remove', `j:${job.id}:rm`)]],
  }
}

/** Finished tasks, newest first, by number; words narrow them. */
export function tasksView(jobs: Job[], o: { query: string; more: boolean }, ctx: NoticeContext): View {
  const state = (j: Job) => (j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'stopped')
  const lines = jobs.map((j, i) =>
    numbered(i + 1, `<b>#${j.id}</b> ${state(j)} · ${esc(ctx.label(j.projectDir))} · ${esc(oneLine(j.prompt, 70))}${j.finishedAt ? ` · <i>${esc(formatClock(j.finishedAt, ctx.now))}</i>` : ''}`),
  )
  const last = jobs.at(-1)
  return {
    html: `<b>Tasks</b>${o.query ? ` matching “${esc(o.query)}”` : ''}\n${lines.length > 0 ? `${lines.join('\n')}\n<i>Tap a number to open it.</i>` : '<i>Nothing finished yet.</i>'}`,
    keyboard: [
      ...numberRows(jobs.map(j => ({ data: `j:${j.id}:open` }))),
      [btn('Search', 'g:tsearch'), ...(o.more && last ? [btn('Older', `g:tasks:${last.id}`)] : []), ...(o.query ? [btn('Show all', 'g:tasks')] : [])],
    ],
  }
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
  return link ? { text: 'Open the live link', url: link.url } : btn('Get a live link', `j:${job.id}:link`)
}

/** A job's whole plan, for Full plan. */
export function planView(job: Job, ctx: UiContext): View {
  return longView(`<b>#${job.id} plan</b> · ${esc(ctx.label(job.projectDir))}`, job.planText ?? '(no plan)', undefined, { name: `plan-${job.id}.md`, caption: `#${job.id}'s plan` }, { silent: true })
}

/** What a task card keeps between edits. */
export interface Card {
  /** How the plan was approved, once it was. */
  plan?: string
}

/** A running task's buttons: its screen, Stop (or Continue), and Kill. */
function taskButtons(job: Job): InlineButton[] {
  const middle = job.status === 'held' ? btn('Continue', `j:${job.id}:go`) : job.phase === 'limited' ? btn('Continue now', `j:${job.id}:now`) : btn('Stop', `j:${job.id}:stop`)
  return [btn('Screen', `j:${job.id}:peek`), middle, btn('Kill', `j:${job.id}:kill`)]
}

/** A task's card: sent when it starts, then edited as its plan is approved and when it ends. */
export function taskCard(job: Job, card: Card, ctx: UiContext): View {
  const ended = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
  const lines = [`<b>#${job.id} started</b> · ${esc(ctx.label(job.projectDir))}`, quote(job.prompt, 600), esc(setupLine(job))]
  if (card.plan !== undefined) lines.push(`Plan approved (${esc(card.plan)})${job.planText ? `\n${quote(markdownToPlain(job.planText), 500)}` : ''}`)
  if (ended) {
    const took = job.startedAt && job.finishedAt ? ` in ${duration(job.finishedAt - job.startedAt)}` : ''
    lines.push(job.status === 'done' ? `<b>Done</b>${took}` : job.status === 'failed' ? `<b>Failed</b>${took}` : '<b>Stopped</b>')
  }
  const plan = card.plan !== undefined && job.planText ? [[btn('Full plan', `j:${job.id}:plan`)]] : []
  const keyboard = ended ? (plan.length > 0 ? plan : undefined) : [taskButtons(job), ...plan]
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

/** One question at a time: the question and every option in full, then a number button per option. */
export function questionView(job: Job, code: string, questions: Question[], s: QuestionState, minutes: number): View {
  const q = questions[s.step]!
  const multi = q.multiSelect === true
  const options = q.options ?? []
  const picked = s.answers[s.step]
  const head = [`<b>#${job.id} asks</b>`, q.header ? esc(q.header) : '', questions.length > 1 ? `${s.step + 1} of ${questions.length}` : ''].filter(Boolean).join(' · ')
  const hint = multi ? 'Tap the numbers that apply, then Done.' : 'Tap a number.'
  const after = `<i>${hint} Or type your own answer. If you don't answer within ${minutes}m, Claude decides itself.</i>`
  const render = (descriptionMax: number) =>
    [
      head,
      `<b>${inlineMarkdown(q.question)}</b>`,
      ...options.map((o, i) => `\n${numbered(i + 1, `<b>${esc(o.label)}</b>`)}${o.description ? `\n${inlineMarkdown(clip(o.description, descriptionMax))}` : ''}`),
      '',
      after,
    ].join('\n')
  // Everything in full, unless it can't fit in one message: then each description gets a fair share.
  let html = render(10_000)
  if (htmlToText(html).length > PART) {
    const fixed = htmlToText(render(0)).length
    html = render(Math.max(120, Math.floor((PART - fixed) / Math.max(1, options.length))))
  }
  const keyboard: InlineKeyboard = numberRows(
    options.map((_, i) => ({
      data: `o:${code}:${s.step}.${i}`,
      chosen: multi ? s.ticked.includes(i) : picked !== undefined && 'picks' in picked && picked.picks.includes(i),
    })),
  )
  if (multi) keyboard.push([btn(s.ticked.length > 0 ? `Done (${s.ticked.length} picked)` : 'Done', `o:${code}:${s.step}.d`)])
  keyboard.push([btn('Type an answer', `o:${code}:${s.step}.t`), ...(s.step > 0 ? [btn('Back', `o:${code}:${s.step}.b`)] : [])])
  return { html, keyboard }
}

/** The question message once you've answered: every question with your answer, no buttons. */
export function answeredView(job: Job, questions: Question[], answers: (QuestionAnswer | undefined)[]): View {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const value = !a ? '<i>no answer</i>' : 'text' in a ? `“${esc(a.text)}”` : a.picks.map(p => esc(q.options?.[p]?.label ?? '?')).join(', ')
    return `<b>${esc(q.question)}</b>\n→ ${value}`
  })
  return { html: `<b>#${job.id} asked</b> · answered\n\n${lines.join('\n\n')}` }
}

// --- messages from the queue ------------------------------------------------------------------

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
        html: `<b>#${n.job.id} plan approved</b> (${esc(n.choice)})\n${quote(n.job.planText ? markdownToPlain(n.job.planText) : null, 500)}`,
        keyboard: n.job.planText ? [[btn('Full plan', `j:${n.job.id}:plan`)]] : undefined,
        silent: true,
      }
    case 'plan_review':
      return longView(
        `<b>#${n.job.id} plan ready for your review</b> · ${esc(ctx.label(n.job.projectDir))}`,
        n.job.planText,
        [
          [btn('Approve', `a:${n.code}:y`), btn('Ask for changes', `a:${n.code}:c`)],
          [btn('Approve, then accept edits', `a:${n.code}:me`)],
          [btn('Approve, then no prompts', `a:${n.code}:my`)],
        ],
        { name: `plan-${n.job.id}.md`, caption: `#${n.job.id}'s plan` },
      )
    case 'permission': {
      // Claude Code's own "stop asking" choices: allow this and apply one of them.
      const rules = n.suggestions ?? []
      return {
        html:
          `<b>#${n.job.id} wants to use ${esc(n.tool)}</b> · ${esc(ctx.label(n.job.projectDir))}\n` +
          `<pre>${esc(clip(n.detail, 3000))}</pre>\n<i>Denied automatically in ${n.minutes}m.</i>` +
          (rules.length > 0 ? `\n\n<b>Or allow it and stop asking:</b>\n${rules.map((r, i) => numbered(i + 1, esc(clip(r, 160)))).join('\n')}\n<i>Tap a number to allow this and apply that rule.</i>` : ''),
        keyboard: [[btn('Allow', `a:${n.code}:y`), btn('Deny', `a:${n.code}:n`)], ...numberRows(rules.map((_, i) => ({ data: `a:${n.code}:r${i}` })))],
      }
    }
    case 'question':
      return questionView(n.job, n.code, n.questions, newQuestionState(), n.minutes)
    case 'trust':
      return {
        html: `<b>#${n.job.id}</b> is the first Claude Code run in <b>${esc(ctx.label(n.job.projectDir))}</b>.\nClaude asks whether to trust this folder.`,
        keyboard: [[btn('Trust it', `a:${n.code}:y`), btn('Cancel the task', `a:${n.code}:n`)]],
      }
    case 'limit': {
      const when = n.at ? `resets ${formatClock(n.at, ctx.now)}` : 'reset time unknown; retrying every 15 minutes'
      return {
        html: `<b>#${n.job.id} hit the ${windowLabel(n.window)}</b> · ${esc(when)} · it continues on its own`,
        keyboard: [[btn('Screen', `j:${n.job.id}:peek`), btn('Continue now', `j:${n.job.id}:now`), btn('Kill', `j:${n.job.id}:kill`)]],
      }
    }
    case 'resumed':
      return { html: `<b>#${n.job.id}</b> continued after the limit reset (${esc(resumedBy(n.how))})`, silent: true }
    case 'done': {
      const took = n.job.startedAt ? ` in ${duration((n.job.finishedAt ?? ctx.now) - n.job.startedAt)}` : ''
      const next = n.next ? `Next: #${n.next.id} · ${esc(ctx.label(n.next.projectDir))}` : 'Queue empty.'
      const head = [
        `<b>#${n.job.id} done</b>${took} · ${esc(ctx.label(n.job.projectDir))}`,
        n.diff ? `<i>${esc(n.diff)}</i>` : '',
        n.job.branch ? `On branch <code>${esc(n.job.branch)}</code>` : '',
        `<i>${next}</i>`,
      ]
        .filter(Boolean)
        .join('\n')
      const branch = n.job.branch && !n.job.branchNote ? [[btn('Merge', `j:${n.job.id}:merge`), btn('Pull request', `j:${n.job.id}:pr`), btn('Discard branch', `j:${n.job.id}:discard`)]] : []
      return longView(head, n.job.lastMessage, [[btn('Follow up', `j:${n.job.id}:fu`), btn('New task here', `j:${n.job.id}:new`)], [linkButton(n.job)], ...branch], {
        name: `answer-${n.job.id}.md`,
        caption: `#${n.job.id}: Claude's full answer`,
      })
    }
    case 'held':
      return {
        html: `<b>#${n.job.id} paused</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [[btn('Screen', `j:${n.job.id}:peek`), btn('Continue', `j:${n.job.id}:go`), btn('Kill', `j:${n.job.id}:kill`)]],
      }
    case 'failed':
      return {
        html: `<b>#${n.job.id} failed</b>: ${esc(n.reason)}${n.screen ? `\n<pre>${esc(clip(n.screen, 1500))}</pre>` : ''}`,
        keyboard: [[btn('Retry', `j:${n.job.id}:go`), btn('Kill', `j:${n.job.id}:kill`)]],
      }
    case 'conflict': {
      const id = n.job.id
      const where = esc(n.where)
      const html =
        n.state === 'waiting'
          ? `<b>#${id} is waiting</b> for its chat to finish its turn in ${where}, then takes it over (closing it there).`
          : n.state === 'stuck'
            ? `<b>#${id} couldn't take its chat over</b>: it's still open in ${where} (${esc(n.holder)}). Close it there, or continue in a copy.`
            : `<b>#${id} is waiting</b>: its chat is open in ${where}${n.busy ? ' and working' : ''} (${esc(n.holder)}). ` +
              `It starts by itself once you close it there.\n<i>Take over closes it there${n.busy ? ' after its current turn' : ''} and continues it here.</i>`
      return {
        html,
        keyboard: [[...(n.state === 'waiting' ? [] : [btn('Take over', `j:${id}:take`)]), btn('Use a copy', `j:${id}:fork`)], [btn('Kill', `j:${id}:kill`)]],
      }
    }
    case 'took_over':
      return { html: `<b>#${n.job.id} took its chat over from ${esc(n.where)}</b> (closed it there). Reopen it there later to see everything it did.`, silent: true }
    case 'session_limit': {
      const sid = n.chat.sessionId
      const when = n.at ? ` · resets ${formatClock(n.at, ctx.now)}` : ''
      const head = [
        `<b>Your chat in ${esc(n.where)} hit the ${windowLabel(n.window)}</b>${esc(when)}`,
        `${n.chat.cwd ? `${esc(ctx.label(n.chat.cwd))} · ` : ''}“${esc(clip(n.chat.title, 120))}”`,
        quote(n.chat.lastPrompt, 600),
      ]
      if (n.autoAt) {
        return {
          html: [...head, `<i>At ${esc(formatClock(n.autoAt, ctx.now))} I'll tell it to continue, so it carries on in ${esc(n.where)}. If it doesn't start, I'll continue it here.</i>`]
            .filter(Boolean)
            .join('\n'),
          keyboard: [[btn('Don’t continue', `w:${sid}:x`), btn('Continue here instead', `w:${sid}:c`)], [btn('Follow up…', `w:${sid}:f`)]],
        }
      }
      return {
        html: [...head, `<i>Continue after the reset continues it here. It closes the chat in ${esc(n.where)} first; reopen it there later to see everything.</i>`].filter(Boolean).join('\n'),
        keyboard: [[btn('Continue after the reset', `w:${sid}:c`)], [btn('Follow up…', `w:${sid}:f`), btn('Ignore', `w:${sid}:x`)]],
      }
    }
    case 'chat_continue': {
      const name = `“${esc(clip(n.chat.title, 120))}”`
      if (n.how === 'inbox') {
        return {
          html: `<b>The usage limit reset:</b> I told your chat ${name} in ${esc(n.where)} to continue.`,
          keyboard: [[btn('Continue here instead', `w:${n.chat.sessionId}:c`)]],
          silent: true,
        }
      }
      if (n.how === 'takeover') return { html: `<b>Your chat ${name} didn't restart</b> in ${esc(n.where)}, so #${n.jobId} continues it here (closing it there).`, silent: true }
      return { html: `<b>#${n.jobId} continues your chat ${name}</b> after the usage limit (it was closed in ${esc(n.where)}).`, silent: true }
    }
    case 'recovered':
      return {
        html: `<b>#${n.job.id}'s window was gone</b> (the computer restarted?), so it continues where it left off.`,
        keyboard: [[btn('Screen', `j:${n.job.id}:peek`), btn('Stop', `j:${n.job.id}:stop`), btn('Kill', `j:${n.job.id}:kill`)]],
        silent: true,
      }
    case 'killed':
      return { html: `<b>#${n.job.id} killed</b>${n.by ? ` by ${esc(n.by)}` : ''} · ${esc(ctx.label(n.job.projectDir))}`, silent: true }
    case 'link':
      return n.url
        ? { html: `<b>Live link for #${n.job.id}</b>${n.title ? `: ${esc(n.title)}` : ''}\n<i>Opens where you're signed in to claude.ai.</i>`, keyboard: [[{ text: 'Open the live link', url: n.url }]] }
        : { html: `<b>No live link for #${n.job.id}</b>: ${esc(clip(n.note ?? 'Claude didn’t make one.', 300))}` }
    case 'setup_warning':
      return { html: esc(n.message) }
    case 'sleeping':
      if (n.failed) return { html: `<b>It didn't go to sleep.</b> ${esc(n.failed)}` }
      return { html: `<b>Going to sleep</b>${n.by ? ` (asked from ${esc(n.by)})` : ''}.\n<i>It can't be woken from here: open its lid or press a key.</i>` }
    case 'empty':
      return { html: 'Queue empty.', silent: true }
  }
}

// --- Status -------------------------------------------------------------------------------------

export interface StatusInfo {
  /** Every task running, oldest first, each with its last tool and when it ran. */
  running: { job: Job; lastTool: { tool: string; at: number } | null }[]
  /** How many may run at once. */
  parallel: number
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
  return `<code>${name.padEnd(6)} ${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}</code> ${pct}%${reset}`
}

const WAITING: Record<Approval['kind'], string> = {
  permission: 'a permission request',
  question: 'a question',
  review: 'its plan, for your review',
  trust: 'trusting its folder',
}

/** Status: what's running, what's waiting on you (with its buttons), what's next, the limits. */
export function statusView(s: StatusInfo, ctx: NoticeContext): View {
  const lines = ['<b>Status</b>', '']
  if (s.running.length === 0) lines.push(s.paused ? 'Nothing running; the queue is paused.' : 'Nothing running.')
  else lines.push('<b>Running</b>')
  for (const { job: a, lastTool } of s.running) {
    const since = a.startedAt ? ` · ${duration(ctx.now - a.startedAt)}` : ''
    lines.push(`<b>#${a.id}</b> · ${esc(ctx.label(a.projectDir))} · ${esc(phaseText(a))}${since}`, `“${esc(oneLine(a.prompt, 140))}”`)
    if (lastTool) lines.push(`<i>Last step: ${esc(lastTool.tool)}, ${duration(ctx.now - lastTool.at)} ago</i>`)
  }
  if (s.running.length > 0 && s.parallel > 1) lines.push(`<i>Up to ${s.parallel} tasks at once.</i>`)
  if (s.approvals.length > 0) {
    lines.push('', '<b>Waiting on you</b>')
    for (const ap of s.approvals) lines.push(`#${ap.jobId}: ${WAITING[ap.kind]}`)
  }
  if (s.queued.length > 0) {
    lines.push('', `<b>Next</b>${s.queued.length > 3 ? ` (${s.queued.length} waiting)` : ''}`)
    for (const j of s.queued.slice(0, 3)) lines.push(`#${j.id} · ${esc(ctx.label(j.projectDir))}: “${esc(oneLine(j.prompt, 70))}”`)
  }
  const blocked = s.limits.blockedUntil && s.limits.blockedUntil > ctx.now ? `New tasks wait for the limit reset at ${esc(formatClock(s.limits.blockedUntil, ctx.now))}.` : ''
  const limits = [limitLine('5-hour', s.limits.fiveHour, ctx.now), limitLine('Weekly', s.limits.sevenDay, ctx.now), blocked].filter(Boolean)
  // Readings only come while a task runs: an old one says when it's from.
  const read = s.limits.updatedAt
  const stale = read && ctx.now - read > 30 * 60_000 ? `<i>Usage as of ${esc(formatClock(read, ctx.now))}; it updates while a task runs.</i>` : ''
  if (limits.length > 0) lines.push('', '<b>Usage</b>', ...limits, ...(stale ? [stale] : []))
  else if (read) lines.push('', `<i>No usage reading since the last reset; it updates while a task runs.</i>`)
  if (s.paused && s.running.length > 0) lines.push('', '<i>Paused: nothing new starts until you resume.</i>')
  if (s.running.length > 0) lines.push('', '<i>Stop pauses a task (Continue picks it up). Kill ends it, with everything it started.</i>')

  const keyboard: InlineKeyboard = []
  for (const ap of s.approvals.slice(0, 3)) {
    if (ap.kind === 'permission' || ap.kind === 'trust') {
      keyboard.push([btn(ap.kind === 'trust' ? `Trust #${ap.jobId}'s folder` : `Allow #${ap.jobId}`, `a:${ap.code}:y`), btn(ap.kind === 'trust' ? `Cancel #${ap.jobId}` : `Deny #${ap.jobId}`, `a:${ap.code}:n`)])
    } else {
      keyboard.push([btn(ap.kind === 'question' ? `Answer #${ap.jobId}'s question` : `Review #${ap.jobId}'s plan`, `a:${ap.code}:show`)])
    }
  }
  // Each running task has its own buttons, named by its number.
  for (const { job: a } of s.running) keyboard.push(taskButtons(a).map(b => ({ ...b, text: `${b.text} #${a.id}` }) as InlineButton))
  keyboard.push([btn('Refresh', 'g:st'), s.paused ? btn('Resume', 'g:resume') : btn('Pause', 'g:pause')])
  return { html: lines.join('\n'), keyboard }
}

// --- Queue -------------------------------------------------------------------------------------

/**
 * Queue: the running tasks, then each waiting one by number. Tap a number and that task's buttons
 * show under the numbers (Move up, Move down, Run next, Hold, Change, Remove), and stay with it as it
 * moves.
 */
export function queueView(running: Job[], queued: Job[], ctx: UiContext, paused: boolean, selected: number | null = null): View {
  const lines: string[] = ['<b>Queue</b>']
  for (const active of running) lines.push(`Running: <b>#${active.id}</b> · ${esc(ctx.label(active.projectDir))} · “${esc(oneLine(active.prompt, 90))}”`)
  const shown = queued.slice(0, 20)
  shown.forEach((job, i) =>
    lines.push(
      numbered(i + 1, `<b>#${job.id}</b>${job.onHold ? ' · <i>on hold</i>' : ''} · ${esc(ctx.label(job.projectDir))} · ${esc(setupLine(job))}\n   “${esc(oneLine(job.prompt, 90))}”`),
    ),
  )
  if (queued.length > shown.length) lines.push(`<i>And ${queued.length - shown.length} more.</i>`)
  const sel = shown.find(j => j.id === selected) ?? null
  if (queued.length === 0) lines.push('<i>Nothing waiting. Send a prompt to add a task.</i>')
  else lines.push(sel ? `<i>#${sel.id} is selected: its buttons are under the numbers.</i>` : '<i>Tap a number to move, hold, change or remove that task.</i>')
  if (paused) lines.push('<i>Paused: nothing new starts until you resume.</i>')
  const keyboard: InlineKeyboard = [...numberRows(shown.map(j => ({ data: `g:qs:${j.id === sel?.id ? 0 : j.id}`, chosen: j.id === sel?.id })))]
  if (sel) {
    const id = sel.id
    keyboard.push(
      [btn('Move up', `j:${id}:up`), btn('Move down', `j:${id}:down`), btn('Run next', `j:${id}:top`)],
      [sel.onHold ? btn('Release', `j:${id}:rel`) : btn('Hold', `j:${id}:hold`), btn('Change', `j:${id}:edit`), btn('Remove', `j:${id}:rm`)],
    )
  }
  keyboard.push([btn('Refresh', 'g:q'), paused ? btn('Resume', 'g:resume') : btn('Pause', 'g:pause'), ...(queued.length > 0 ? [btn('Clear', 'g:clear')] : [])])
  return { html: lines.join('\n'), keyboard }
}

// --- a running task's screen ---------------------------------------------------------------------

/** The keys you can press in a task, for a screen Afterhours can't answer by itself. */
const KEYPAD: [string, string][][] = [
  [
    ['1', '1'],
    ['2', '2'],
    ['3', '3'],
  ],
  [
    ['Enter', 'Enter'],
    ['Esc', 'Escape'],
    ['Tab', 'Tab'],
  ],
  [
    ['Up', 'Up'],
    ['Down', 'Down'],
    ['Shift-Tab', 'BTab'],
  ],
]

/** A running task's screen; `keys` shows the keypad over its buttons, and a key pressed shows the screen again. */
export function screenView(job: Job | null, screen: string, o: { keys?: boolean; label?: (path: string) => string } = {}): View {
  if (!job) return { html: 'Nothing is running.', keyboard: [[btn('Refresh', 'g:peek')]] }
  const id = job.id
  return {
    html: `<b>#${id} screen</b>${o.label ? ` · ${esc(o.label(job.projectDir))}` : ''}\n<pre>${esc(clip(screen, 3500)) || '(blank screen)'}</pre>`,
    keyboard: [
      ...(o.keys ? KEYPAD.map(row => row.map(([label, key]) => btn(label, `g:k:${key}:${id}`))) : []),
      [btn('Refresh', o.keys ? `g:pk:${id}` : `g:peek:${id}`), btn('Type', `g:type:${id}`), btn(opened(o.keys === true, 'Keys'), o.keys ? `g:peek:${id}` : `g:pk:${id}`)],
      taskButtons(job).slice(1),
    ],
  }
}

/** /kill with several running: which one. */
export function killPickerView(running: Job[], ctx: NoticeContext): View {
  return {
    html:
      '<b>Kill which task?</b>\n' +
      running.map((j, i) => numbered(i + 1, `<b>#${j.id}</b> · ${esc(ctx.label(j.projectDir))}\n   “${esc(oneLine(j.prompt, 120))}”`)).join('\n') +
      '\n<i>Tap its number, then again to confirm: Claude and everything it started stop.</i>',
    keyboard: numberRows(running.map(j => ({ data: `j:${j.id}:kill` }))),
  }
}

/** Which of the running tasks: the tasks numbered in the message, and their numbers as buttons (`verb`: peek, type, keys). */
export function runningPickerView(running: Job[], verb: 'peek' | 'type' | 'keys', ctx: NoticeContext): View {
  const what = { peek: 'Whose screen?', type: 'Type into which task?', keys: 'Press keys in which task?' }[verb]
  return {
    html:
      `<b>${what}</b>\n` +
      running.map((j, i) => numbered(i + 1, `<b>#${j.id}</b> · ${esc(ctx.label(j.projectDir))}\n   “${esc(oneLine(j.prompt, 120))}”`)).join('\n') +
      '\n<i>Tap its number.</i>',
    keyboard: numberRows(running.map(j => ({ data: verb === 'keys' ? `g:pk:${j.id}` : `g:${verb}:${j.id}` }))),
  }
}

// --- Settings ------------------------------------------------------------------------------------

export function settingsView(o: {
  notify: string
  folders: number
  builtAt: number | null
  roots: string[]
  models: string[]
  watch: boolean
  autoContinue: boolean
  /** How many tasks may run at once. */
  parallel: number
  now: number
}): View {
  const built = o.builtAt ? `rebuilt ${duration(o.now - o.builtAt)} ago` : 'not built yet'
  const n = (level: string, label: string) => btn(chosen(o.notify === level, label), `g:notify:${level}`)
  const notify = { all: 'every update', important: 'only what needs you, and tasks ending', off: 'nothing' }[o.notify] ?? o.notify
  return {
    html: [
      '<b>Settings</b>',
      `Notifications: <b>${esc(o.notify)}</b>, ${esc(notify)}.`,
      `Tasks at once: <b>${o.parallel}</b>${o.parallel > 1 ? '. The next starts beside the running ones only in another folder, on its own branch, or when it only answers.' : '.'}`,
      `Other chats: <b>${o.watch ? 'watched' : 'not watched'}</b>${o.watch ? `. I tell you when one in VS Code or a terminal hits a usage limit${o.autoContinue ? ', and continue it at the reset' : ''}.` : '.'}`,
      `Folders: ${o.folders} under ${o.roots.map(r => esc(basename(r))).join(', ')} · ${built}.`,
      `Models: ${esc(o.models.join(', '))} <i>(change in ~/${BRAND.homeDir}/config.json)</i>`,
      '<i>New tasks start with the choices you used last.</i>',
    ].join('\n'),
    keyboard: [
      [n('all', 'All'), n('important', 'Important'), n('off', 'Off')],
      [1, 2, 3].map(k => btn(chosen(o.parallel === k, `${k} at once`), `g:par:${k}`)),
      // Continuing a chat by itself follows from watching them: turning it on watches them too.
      [btn(`Watch chats: ${onOff(o.watch)}`, 'g:watch'), btn(`Auto-continue: ${onOff(o.watch && o.autoContinue)}`, 'g:auto')],
      [btn('Project folders', 'g:pf'), btn('Rescan folders', 'g:rescan')],
    ],
  }
}

// --- project folders: where Claude may work ----------------------------------------------------

/** The project folders, with a number each to stop using one, and the ways to change them. */
export function projectFoldersView(roots: { path: string; label: string }[], note?: string): View {
  return {
    html: [
      '<b>Project folders</b>',
      'Claude only works inside these, and you pick from them when you start a task.',
      ...roots.map((r, i) => numbered(i + 1, esc(r.label))),
      note ? `\n${esc(note)}` : '',
      roots.length > 1 ? '<i>Tap a number to stop using that folder. Nothing on the computer changes.</i>' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    keyboard: [...numberRows(roots.map((_, i) => ({ data: `g:pf:r:${i}` }))), [btn('Change folder', 'g:pf:c'), btn('Add another', 'g:pf:a')], [btn('Back', 'g:set')]],
  }
}

/** Choosing a folder by browsing: `c` replaces the project folders with it, `a` adds it. */
export interface FolderBrowser {
  /** This folder's id (button data) and how a person reads it. */
  id: number
  label: string
  /** The folder above (its id), or null at the top. */
  parentId: number | null
  page: number
  pages: number
  total: number
  items: { id: number; title: string; isRepo: boolean }[]
  /** This folder can be chosen (not the top of a disk, not This PC). */
  canChoose: boolean
  /** Found places, on the first screen only. */
  shortcuts: { label: string; why: string }[]
}

export function folderBrowserView(b: FolderBrowser, mode: 'c' | 'a'): View {
  const heading = mode === 'c' ? 'Choose the project folder' : 'Add another project folder'
  const kb: InlineKeyboard = [...numberRows(b.items.map(it => ({ data: `g:fb:${it.id}:0:${mode}` })))]
  const nav: InlineButton[] = []
  if (b.parentId !== null) nav.push(btn('Up', `g:fb:${b.parentId}:0:${mode}`))
  if (b.page > 0) nav.push(btn('Previous', `g:fb:${b.id}:${b.page - 1}:${mode}`))
  if (b.page < b.pages - 1) nav.push(btn('Next', `g:fb:${b.id}:${b.page + 1}:${mode}`))
  if (nav.length > 0) kb.push(nav)
  if (b.canChoose) kb.push([btn('Use this folder', `g:fu:${b.id}:${mode}`)])
  if (b.shortcuts.length > 0) kb.push(...rows(b.shortcuts.map((_, i) => btn(`Shortcut ${String.fromCharCode(97 + i)}`, `g:fs:${i}:${mode}`)), 3))
  kb.push([btn('Send a folder', `g:pf:t:${mode}`), btn('Back', 'g:pf')])
  return {
    html: [
      `<b>${heading}</b>`,
      `You are in: <b>${esc(b.label)}</b>${b.pages > 1 ? ` · page ${b.page + 1} of ${b.pages}` : ''}`,
      ...(b.items.length > 0 ? b.items.map((it, i) => numbered(i + 1, `${esc(it.title)}${it.isRepo ? ' <i>(a git project)</i>' : ''}`)) : ['<i>No folders in here.</i>']),
      ...(b.shortcuts.length > 0 ? ['', '<b>Shortcuts</b> <i>(where you have used Claude Code, and where your git projects are)</i>', ...b.shortcuts.map((x, i) => `<b>${String.fromCharCode(97 + i)}.</b> ${esc(x.label)} <i>(${esc(x.why)})</i>`)] : []),
      '',
      `<i>Tap a number to open a folder${b.canChoose ? ', or Use this folder to choose the one you are in' : ''}. Or send a folder like D:\\Projects or ~/code.</i>`,
    ].join('\n'),
    keyboard: kb,
  }
}

/** Right after pairing: where Claude will work, and the way to change it. */
export function foldersWelcomeView(roots: { label: string }[]): View {
  return {
    html: [
      '<b>Where Claude will work</b>',
      ...roots.map((r, i) => numbered(i + 1, esc(r.label))),
      '<i>These are the folders you will pick from when you start a task.</i>',
    ].join('\n'),
    keyboard: [[btn('Looks right', 'g:pf:ok'), btn('Change folder', 'g:pf:c')]],
  }
}

// --- this computer: awake and asleep -------------------------------------------------------------

/** How long Stay awake keeps it awake, in hours. */
export const AWAKE_HOURS = [1, 4, 12]

/** This computer: staying awake (while tasks run, with the lid closed, for a while) and sleeping. */
export function macView(s: PowerStatus, now: number): View {
  const word = machineWord(s.kind)
  const lid = s.kind === 'wsl' ? null : s.lidClosed
  const until = s.awake ? esc(formatClock(s.awake.until, now)) : null
  const state = until ? `awake until ${until}` : s.keepAwake && s.running !== null ? `awake while #${s.running} runs` : s.sleepWhenDone.on ? 'sleeps once the queue is done' : 'sleeps when idle, as usual'
  const lidText = !lid
    ? '<i>With the lid closed, Windows decides: set “When I close the lid: Do nothing” in its power settings.</i>'
    : `With the lid closed: <b>${onOff(lid.on)}</b>. ` +
      (lid.on && lid.ready
        ? `Closing the lid doesn’t sleep it while it stays awake${s.kind === 'mac' ? ' (below 20% battery it may)' : ''}${lid.holding ? '; doing so now' : ''}.`
        : s.kind === 'mac' && !lid.ready
          ? 'It needs a one-time setup at the Mac: in Terminal, run <code>cq awake lid on</code> (it asks for your password once).'
          : 'Closing the lid sleeps it, tasks or not.')
  const sections = [
    [`<b>This ${word}</b> · ${state}`],
    [
      '<b>Stay awake</b>',
      `While tasks run: <b>${onOff(s.keepAwake)}</b>. ${s.keepAwake ? 'It stays awake while anything runs or waits to start, then sleeps as usual.' : 'It may sleep while tasks run; they pause until it wakes.'}`,
      lidText,
      `For a while: <b>${until ? `until ${until}` : 'off'}</b>. ${until ? 'Tap the ticked one to stop.' : `${AWAKE_HOURS.map(h => `Awake ${h}h`).join(', ')}: that long, tasks or not.`}`,
    ],
    [
      '<b>Sleep</b>',
      `When the queue is done: <b>${onOff(s.sleepWhenDone.on)}</b>${s.sleepWhenDone.on && s.sleepWhenDone.waiting ? `, waiting for ${esc(s.sleepWhenDone.waiting)}` : ''}.`,
      s.running !== null ? `#${s.running} is running: it pauses while the ${word} sleeps.` : '',
      s.sleepDisabled ? `Sleep is turned off on this ${word} by something else (pmset disablesleep).` : '',
      "<i>It can't be woken from here: open its lid or press a key.</i>",
    ],
  ]
  const html = sections.map(lines => lines.filter(Boolean).join('\n')).join('\n\n')
  return {
    html,
    keyboard: [
      [btn(`While tasks run: ${onOff(s.keepAwake)}`, 'm:k'), ...(lid ? [btn(`Lid closed: ${onOff(lid.on)}`, 'm:l')] : [])],
      AWAKE_HOURS.map(h => btn(chosen(s.awake?.hours === h, `Awake ${h}h`), `m:a:${s.awake?.hours === h ? 0 : h}`)),
      [btn(`Sleep when done: ${onOff(s.sleepWhenDone.on)}`, 'm:d'), btn('Sleep now', 'm:s')],
      [btn('Refresh', 'm:r'), ...(lid && s.kind === 'mac' && !lid.ready ? [{ text: 'Copy the command', copy_text: { text: 'cq awake lid on' } }] : [])],
    ],
  }
}

/** /sleep: what sleeping does, with the buttons that do it (asking was the first tap). */
export function sleepView(s: PowerStatus): View {
  const word = machineWord(s.kind)
  const lines = [`<b>Put the ${word} to sleep?</b>`, s.running !== null ? `#${s.running} pauses until it wakes.` : '', "<i>It can't be woken from here: open its lid or press a key.</i>"]
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: [[btn('Sleep now', 'm:S')], [btn(chosen(s.sleepWhenDone.on, 'Sleep when the queue is done'), 'm:D')]],
  }
}

// --- help -----------------------------------------------------------------------------------------

export function helpHtml(machine: string): string {
  const key = machineKey(machine)
  return [
    '<b>Send me what Claude should do.</b> I answer with a task card set to your last choices. Tap Queue, or change something first: each line of the card has a button under it (Folder, Chat, How, Model, When, More). A button opens its choices right there, and tapping it again closes them.',
    '',
    '<b>Plan high, work low.</b> In How, pick Plan first. In Model, set the plan (say Opus at High), then tap Work and set the work (say Sonnet at Low).',
    '',
    '<b>The keys under the text box</b>',
    `<b>${KEYS.newTask}</b>: pick the folder first, then send the prompt.`,
    `<b>${KEYS.status}</b>: what's running, what waits on you, your usage. Each task has Screen, Stop and Kill.`,
    `<b>${KEYS.queue}</b>: tap a task's number to move, hold, change or remove it.`,
    `<b>${KEYS.tasks}</b>: finished tasks; open one to follow it up.`,
    `<b>${KEYS.chats}</b>: any Claude Code chat, VS Code ones too. Open one and tap Write here to type into it.`,
    `<b>${key}</b>: keep it awake (while tasks run, with the lid closed, or for a few hours) or put it to sleep.`,
    `<b>${KEYS.settings}</b>: notifications, tasks at once, your other chats.`,
    '',
    'Lists are numbered: every line is written out in full in the message, and the buttons are only the numbers. A ✓ marks what is chosen.',
    '<b>Screenshots.</b> Send them here with 📎 (Photo or File), one or several at once, before or after the prompt. They go on the task card you have open (or a new one; a caption becomes the prompt), up to 10, and Claude sees them. Inside a chat (Write here) they go into that chat.',
    'Kill, Sleep now and Clear ask for a second tap on the same button.',
    '',
    "I message you when a plan is ready, when Claude needs permission or asks something, when a usage limit pauses work, and when a task ends. News that needs nothing from you arrives silently.",
    '',
    'Commands: /new /status /queue /tasks /chats /mac /sleep /settings /kill /pause /resume /cancel /help',
    'Typing <code>q myapp plan opus max&gt;low: …</code> works too.',
  ].join('\n')
}
