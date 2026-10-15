// Pieces several screens share: a machine's card, a task's row, a usage-limit bar, a terminal.

import type { JobInfo } from '@afterhours/protocol'
import { router } from 'expo-router'
import { useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { useNow } from '../app-state'
import { basename, clock, duration, modeLabel, oneLine, phaseLabel, statusLabel } from '../lib/format'
import type { MachineState } from '../lib/state'
import { mono, radius, space, type as T, useColors } from '../theme'
import { Icon, STATUS_ICON } from './icons'
import { Card, Dot, Label, Pill, Row, Soft, Title } from './ui'

export function statusColor(m: MachineState, c: ReturnType<typeof useColors>): string {
  return m.status === 'connected' ? c.ok : m.status === 'refused' ? c.danger : m.status === 'connecting' ? c.accent : c.faint
}

export function MachineCard(props: { machine: MachineState }) {
  const m = props.machine
  const c = useColors()
  const now = useNow(15_000)
  const waiting = m.approvals.length
  const a = m.active
  return (
    <Card onPress={() => router.push(`/machine/${m.id}`)} testID={`machine-${m.name}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row>
          <Dot color={statusColor(m, c)} />
          <Title numberOfLines={1}>{m.name}</Title>
        </Row>
        {waiting > 0 ? <Pill tone="accent" text={`${waiting} need${waiting === 1 ? 's' : ''} you`} /> : <Soft>{statusLabel(m.status, m.statusDetail)}</Soft>}
      </Row>
      {m.status === 'refused' ? (
        <Soft>This device was removed there. Pair it again to come back.</Soft>
      ) : a ? (
        <View style={{ gap: 2 }}>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ paddingTop: 2 }}>
              <Icon name={STATUS_ICON[a.status]} color={c.accent} />
            </View>
            <Label numberOfLines={2} style={{ flex: 1 }}>
              #{a.id} {oneLine(a.prompt, 140)}
            </Label>
          </Row>
          <Soft>
            {phaseLabel(a)}
            {a.startedAt ? ` · ${duration(now - a.startedAt)}` : ''} · {basename(a.folder)}
          </Soft>
        </View>
      ) : (
        <Soft>{m.synced ? (m.paused ? 'Paused: nothing new starts.' : 'Nothing running.') : 'Waiting for the machine…'}</Soft>
      )}
      {m.queued.length > 0 ? <Soft>{m.queued.length} waiting in the queue</Soft> : null}
      <LimitBar label="5-hour" window={m.limits.fiveHour} />
    </Card>
  )
}

/** A task in a list; `actions` go under it, inside its card. */
export function JobRow(props: { machine: string; job: JobInfo; actions?: React.ReactNode }) {
  const j = props.job
  const c = useColors()
  const now = useNow(30_000)
  const tone = { queued: c.soft, running: c.accent, held: c.accent, done: c.ok, failed: c.danger, cancelled: c.faint }[j.status]
  const when = j.finishedAt ? clock(j.finishedAt, now) : j.startedAt ? `started ${clock(j.startedAt, now)}` : `queued ${clock(j.createdAt, now)}`
  return (
    <Card onPress={() => router.push(`/machine/${props.machine}/task/${j.id}`)} testID={`job-${j.id}`}>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 1 }}>
          <Icon name={STATUS_ICON[j.status]} color={tone} size={19} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Label numberOfLines={2}>
            #{j.id} {oneLine(j.prompt, 160)}
          </Label>
          <Soft numberOfLines={1}>
            {basename(j.folder)} · {modeLabel(j)} · {j.model}/{j.effort} · {when}
          </Soft>
        </View>
      </Row>
      {props.actions}
    </Card>
  )
}

export function LimitBar(props: { label: string; window?: { usedPct: number | null; resetsAt: number | null } }) {
  const c = useColors()
  const now = useNow(60_000)
  const w = props.window
  if (!w || w.usedPct === null) return null
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPct)))
  const color = pct >= 90 ? c.danger : pct >= 70 ? c.accent : c.ok
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Soft>
          {props.label} limit · {pct}%
        </Soft>
        {w.resetsAt ? <Soft>resets {clock(w.resetsAt, now)}</Soft> : null}
      </Row>
      <View style={{ height: 6, backgroundColor: c.raised, borderRadius: radius.pill, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} />
      </View>
    </View>
  )
}

/** A terminal's text, newest lines in view; it stays where you scrolled to if you scrolled up. */
export function Terminal(props: { text: string; testID?: string; height?: number }) {
  const c = useColors()
  const ref = useRef<ScrollView>(null)
  const atEnd = useRef(true)
  return (
    <ScrollView
      ref={ref}
      nestedScrollEnabled
      style={{ backgroundColor: c.terminal, borderRadius: radius.m, maxHeight: props.height ?? 440 }}
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
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: space.m }}>
        <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, color: c.terminalInk }}>
          {props.text || '(blank screen)'}
        </Text>
      </ScrollView>
    </ScrollView>
  )
}

/** A small "in 12m" for when a request is settled without you. */
export function Countdown(props: { at?: number; verb: string }) {
  const now = useNow(15_000)
  if (!props.at) return null
  const left = props.at - now
  return <Soft style={T.tiny}>{left > 0 ? `${props.verb} in ${duration(left)}` : `${props.verb} any moment`}</Soft>
}
