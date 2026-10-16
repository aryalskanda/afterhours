// Rows several screens share: a machine, a task, a usage limit; and the running task's terminal.

import type { JobInfo } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { useMemo, useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { parseAnsi, type Run } from '../lib/ansi'
import { useNow } from '../app-state'
import { basename, clock, duration, oneLine, phaseLabel, whenLabel } from '../lib/format'
import type { MachineState } from '../lib/state'
import { mono, tabular, useTheme, type Colors } from '../theme'
import { openMenu, type MenuItem } from './Menu'
import { Badge, Row, StatusDot, Txt } from './ui'

export function statusColor(m: MachineState, c: Colors): string {
  return m.status === 'connected' ? c.okDot : m.status === 'refused' ? c.danger : c.faint
}

/** A machine in a list: its state, what it's doing, and how many things wait on you there. */
export function MachineRow(props: { machine: MachineState }) {
  const m = props.machine
  const { c } = useTheme()
  const now = useNow(15_000)
  const a = m.active
  const waiting = m.approvals.length
  let line: string
  if (m.status === 'refused') line = 'Removed this device'
  else if (m.status === 'offline') line = 'Offline'
  else if (!m.synced) line = 'Connecting…'
  else if (a) line = `${phaseLabel(a)}${a.startedAt ? ` · ${duration(now - a.startedAt)}` : ''}`
  else line = [m.paused ? 'Paused' : 'Idle', m.queued.length ? `${m.queued.length} queued` : ''].filter(Boolean).join(' · ')
  return (
    <Row
      testID={`machine-${m.name}`}
      label={`${m.name}. ${line}${a && m.status === 'connected' ? `. Running ${oneLine(a.prompt, 90)}` : ''}${waiting > 0 ? `. ${waiting} waiting for you` : ''}`}
      onPress={() => router.push({ pathname: '/machine/[id]', params: { id: m.id } })}
      leading={<StatusDot color={statusColor(m, c)} pulse={m.status === 'connected' && a?.status === 'running'} />}
      title={m.name}
      bold
      subtitle={
        <View style={{ gap: 1 }}>
          {a && m.status === 'connected' ? (
            <Txt v="subhead" tone="soft" lines={1}>
              <Txt v="subhead" tone="faint" mono>
                #{a.id}
              </Txt>{' '}
              {oneLine(a.prompt, 90)}
            </Txt>
          ) : null}
          <Txt v="footnote" tone="soft" num>
            {line}
          </Txt>
        </View>
      }
      trailing={waiting > 0 ? <Badge count={waiting} testID={`waiting-${m.name}`} /> : undefined}
      chevron
    />
  )
}

const STATUS_WORDS = { running: 'Running', queued: 'Queued', held: 'Held', done: 'Done', failed: 'Failed', cancelled: 'Stopped' } as const

/**
 * A task in a list: done, failed, running or waiting, what it was asked, where and when. `where`:
 * the machine's name, in lists across machines. A long press: Open, Copy the prompt, and `actions`.
 */
export function TaskRow(props: { machine: string; job: JobInfo; position?: number; where?: string; actions?: MenuItem[] }) {
  const j = props.job
  const { c, wide } = useTheme()
  const now = useNow(30_000)
  const size = wide ? 14 : 16
  const mark =
    j.status === 'running' ? (
      <StatusDot color={c.okDot} pulse />
    ) : j.status === 'queued' ? (
      <Txt v="footnote" tone="faint" num style={{ width: size, textAlign: 'center' }}>
        {props.position ?? ''}
      </Txt>
    ) : (
      <Ionicons
        size={size}
        name={({ held: 'pause', done: 'checkmark', failed: 'close', cancelled: 'remove' } as const)[j.status as 'held' | 'done' | 'failed' | 'cancelled']}
        color={{ held: c.accent, done: c.ok, failed: c.danger, cancelled: c.faint }[j.status as 'held' | 'done' | 'failed' | 'cancelled']}
      />
    )
  const when = j.finishedAt ? clock(j.finishedAt, now) : j.startedAt ? duration(now - j.startedAt) : (whenLabel(j, now) ?? clock(j.createdAt, now))
  const open = () => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: props.machine, job: String(j.id) } })
  const status = j.status === 'queued' && props.position ? `Queued, number ${props.position}` : STATUS_WORDS[j.status]
  return (
    <Row
      testID={`job-${j.id}`}
      label={`${status}. ${oneLine(j.prompt, 160)}. Task ${j.id}${props.where ? ` on ${props.where}` : ''}, ${basename(j.folder)}, ${when}`}
      onPress={open}
      onLongPress={() =>
        openMenu({
          title: oneLine(j.prompt, 90),
          items: [{ label: 'Open', onPress: open }, { label: 'Copy the prompt', onPress: () => Clipboard.setStringAsync(j.prompt) }, ...(props.actions ?? [])],
        })
      }
      leading={<View style={{ width: size, alignItems: 'center' }}>{mark}</View>}
      title={oneLine(j.prompt, 160)}
      titleLines={2}
      subtitle={
        <Txt v="footnote" tone="soft" num lines={1}>
          <Txt v="footnote" tone="soft" mono>
            #{j.id}
          </Txt>
          {` · ${props.where ? `${props.where} · ` : ''}${basename(j.folder)} · ${when}`}
        </Txt>
      }
      chevron
    />
  )
}

/** A usage limit: how much is used, a thin bar, and when it resets. */
export function LimitRow(props: { label: string; window?: { usedPct: number | null; resetsAt: number | null } }) {
  const { c, t } = useTheme()
  const now = useNow(60_000)
  const w = props.window
  if (!w || w.usedPct === null) return null
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPct)))
  const color = pct >= 90 ? c.danger : pct >= 70 ? c.accent : c.okDot
  return (
    <Row title={props.label} value={`${pct}%`}>
      <View style={{ height: 3, backgroundColor: c.fill, borderRadius: 2, overflow: 'hidden', marginTop: 6 }}>
        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 2 }} />
      </View>
      {w.resetsAt ? <Text style={[t.footnote, tabular, { color: c.soft, marginTop: 4 }]}>Resets {clock(w.resetsAt, now)}</Text> : null}
    </Row>
  )
}

/** The 16 terminal colours, readable on the terminal's dark background. */
const ANSI = ['#4a5060', '#ff6b6b', '#5fd27e', '#f5c451', '#6aa8ff', '#d48cff', '#56d4e0', '#d7dae0', '#7d8494', '#ff8f8f', '#8ce99a', '#ffe08a', '#9cc4ff', '#e6a8ff', '#8ae6ee', '#ffffff']
const MATCH = '#ffd60a'

function colour(v: Run['fg'], fallback: string): string {
  return v === undefined ? fallback : typeof v === 'number' ? (ANSI[v] ?? fallback) : v
}

/** Matches of `find` in a line, as [start, end) ranges, case-insensitive. */
function matches(line: string, find: string): [number, number][] {
  if (!find) return []
  const out: [number, number][] = []
  const hay = line.toLowerCase()
  const needle = find.toLowerCase()
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length])
  return out
}

/** How many times `find` appears in a terminal's text (its colour codes aside). */
export function countMatches(text: string, find: string, ansi: boolean): number {
  if (!find.trim()) return 0
  const lines = ansi ? parseAnsi(text).map(l => l.map(r => r.text).join('')) : text.split('\n')
  return lines.reduce((n, l) => n + matches(l, find.trim()).length, 0)
}

/** One line's runs, with `find`'s matches highlighted across them. */
function Line(props: { runs: Run[]; find: string; ink: string; last: boolean }) {
  const hits = matches(props.runs.map(r => r.text).join(''), props.find)
  const parts: { text: string; run: Run; hit: boolean }[] = []
  let pos = 0
  for (const run of props.runs) {
    let start = 0
    while (start < run.text.length) {
      const at = pos + start
      const hit = hits.find(([a, b]) => at >= a && at < b)
      const next = hit ? Math.min(hit[1] - pos, run.text.length) : Math.min(...hits.map(([a]) => a - pos).filter(a => a > start), run.text.length)
      parts.push({ text: run.text.slice(start, next), run, hit: hit !== undefined })
      start = next
    }
    pos += run.text.length
  }
  return (
    <Text>
      {parts.map((p, i) => {
        const fg = colour(p.run.inverse ? p.run.bg : p.run.fg, props.ink)
        const bg = p.run.inverse ? colour(p.run.fg, props.ink) : p.run.bg === undefined ? undefined : colour(p.run.bg, 'transparent')
        return (
          <Text
            key={i}
            style={{
              color: p.hit ? '#000000' : p.run.dim ? '#8a90a0' : fg,
              backgroundColor: p.hit ? MATCH : bg,
              fontWeight: p.run.bold ? '700' : undefined,
              fontStyle: p.run.italic ? 'italic' : undefined,
              textDecorationLine: p.run.underline ? 'underline' : undefined,
            }}
          >
            {p.text}
          </Text>
        )
      })}
      {props.last ? '' : '\n'}
    </Text>
  )
}

/**
 * A terminal's text, newest lines in view; it stays where you scrolled to if you scrolled up.
 * `ansi`: the text carries colour codes. `find` highlights matches.
 */
export function Terminal(props: { text: string; testID?: string; height?: number; ansi?: boolean; find?: string; fontSize?: number }) {
  const { c, m, wide } = useTheme()
  const ref = useRef<ScrollView>(null)
  const atEnd = useRef(true)
  const lines = useMemo(() => (props.ansi ? parseAnsi(props.text) : props.text.split('\n').map(text => [{ text }])), [props.text, props.ansi])
  const size = props.fontSize ?? (wide ? 12 : 12.5)
  const find = (props.find ?? '').trim()
  return (
    <ScrollView
      ref={ref}
      nestedScrollEnabled
      style={{ backgroundColor: c.terminal, borderRadius: m.radius, maxHeight: props.height ?? 460 }}
      onContentSizeChange={() => {
        if (atEnd.current) ref.current?.scrollToEnd({ animated: false })
      }}
      onScroll={e => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
        atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40
      }}
      scrollEventThrottle={100}
      testID={props.testID}
      aria-label="The task’s screen"
    >
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: m.rowX }}>
        <Text selectable style={{ fontFamily: mono, fontSize: size, lineHeight: Math.round(size * 1.42), color: c.terminalInk }}>
          {props.text ? lines.map((runs, i) => <Line key={i} runs={runs} find={find} ink={c.terminalInk} last={i === lines.length - 1} />) : ' '}
        </Text>
      </ScrollView>
    </ScrollView>
  )
}

/** "Denied in 13m": when a request is settled without you. */
export function countdown(at: number | undefined, now: number, verb: string): string | null {
  if (!at) return null
  const left = at - now
  return left > 0 ? `${verb} in ${duration(left)}` : `${verb} any moment`
}
