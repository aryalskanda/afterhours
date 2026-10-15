// Rows several screens share: a machine, a task, a usage limit; and the running task's terminal.

import type { JobInfo } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useNow } from '../app-state'
import { basename, clock, duration, oneLine, phaseLabel } from '../lib/format'
import type { MachineState } from '../lib/state'
import { mono, tabular, useTheme, type Colors } from '../theme'
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

/** A task in a list: done, failed, running or waiting, what it was asked, where and when. */
export function TaskRow(props: { machine: string; job: JobInfo; position?: number }) {
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
  const when = j.finishedAt ? clock(j.finishedAt, now) : j.startedAt ? duration(now - j.startedAt) : clock(j.createdAt, now)
  return (
    <Row
      testID={`job-${j.id}`}
      onPress={() => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: props.machine, job: String(j.id) } })}
      leading={<View style={{ width: size, alignItems: 'center' }}>{mark}</View>}
      title={oneLine(j.prompt, 160)}
      titleLines={2}
      subtitle={
        <Txt v="footnote" tone="soft" num lines={1}>
          <Txt v="footnote" tone="soft" mono>
            #{j.id}
          </Txt>
          {` · ${basename(j.folder)} · ${when}`}
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

/** A terminal's text, newest lines in view; it stays where you scrolled to if you scrolled up. */
export function Terminal(props: { text: string; testID?: string; height?: number }) {
  const { c, m, wide } = useTheme()
  const ref = useRef<ScrollView>(null)
  const atEnd = useRef(true)
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
    >
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: m.rowX }}>
        <Text selectable style={{ fontFamily: mono, fontSize: wide ? 12 : 12.5, lineHeight: wide ? 17 : 18, color: c.terminalInk }}>
          {props.text || ' '}
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
