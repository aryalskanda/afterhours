// A machine's usage limits over time: the 5-hour limit over the last day, the weekly one over the
// last week, and when each runs out at the pace it's going. The queue can wait for the reset.

import { Stack, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { hub, useMachine, useNow } from '../../../../../src/app-state'
import { LimitRow } from '../../../../../src/components/bits'
import { Block, EmptyState, Group, LoadingRows, Note, Page, Row, Segmented, Txt } from '../../../../../src/components/ui'
import { useLoad } from '../../../../../src/components/useLoad'
import { clock } from '../../../../../src/lib/format'
import { forecast, forecastLabel, usageBars, type LimitWindow } from '../../../../../src/lib/forecast'
import { LimitHistory } from '../../../../../src/lib/results'
import { supports } from '../../../../../src/lib/state'
import { useTheme } from '../../../../../src/theme'

const HOUR = 3_600_000
const WINDOWS: { value: LimitWindow; label: string }[] = [
  { value: 'fiveHour', label: '5-hour' },
  { value: 'sevenDay', label: 'Weekly' },
]
/** What each chart shows: how far back, in how many bars. */
const SPAN: Record<LimitWindow, { ms: number; bars: number; from: string }> = {
  fiveHour: { ms: 24 * HOUR, bars: 48, from: '24 hours ago' },
  sevenDay: { ms: 7 * 24 * HOUR, bars: 56, from: '7 days ago' },
}

/** Bars of the highest use in each slice of time; gaps where the machine sampled nothing. */
function Chart(props: { bars: (number | null)[]; label: string; from: string }) {
  const { c, m } = useTheme()
  const height = 120
  return (
    <View accessible role="img" aria-label={props.label} testID="usage-chart">
      <View style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderBottomWidth: 1, borderColor: c.line }}>
        {props.bars.map((v, i) => (
          <View key={i} style={{ flex: 1, height: v === null ? 0 : Math.max(2, (Math.min(100, v) / 100) * height), backgroundColor: v !== null && v >= 90 ? c.danger : c.soft, borderTopLeftRadius: 2, borderTopRightRadius: 2, opacity: 0.85 }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: m.gap / 3 }}>
        <Txt v="caption" tone="faint">
          {props.from}
        </Txt>
        <Txt v="caption" tone="faint">
          Now
        </Txt>
      </View>
    </View>
  )
}

export default function Usage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const now = useNow(60_000)
  const [w, setW] = useState<LimitWindow>('fiveHour')
  const history = useLoad(id, m && supports(m, 'limits.history') ? { type: 'limits.history' } : null, LimitHistory, `limits:${id}`, { every: 120_000 })
  const [holding, setHolding] = useState(false)
  const [held, setHeld] = useState<{ ok: boolean; text: string } | null>(null)

  if (!m) {
    return (
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }

  const samples = history.data?.samples ?? []
  const span = SPAN[w]
  const bars = usageBars(samples, w, now - span.ms, now, span.bars)
  const current = m.limits[w]
  const f = forecast(samples, w, now, current ? { usedPct: current.usedPct, resetsAt: current.resetsAt } : undefined)
  const line = forecastLabel(f, current?.resetsAt ?? null, now)
  const peak = Math.max(0, ...bars.map(b => b ?? 0))
  const resetsAt = m.limits.fiveHour?.resetsAt && m.limits.fiveHour.resetsAt > now ? m.limits.fiveHour.resetsAt : null
  const canAct = m.role === 'owner' || m.role === 'operator'
  // Queued tasks that would start before the 5-hour limit resets.
  const early = resetsAt ? m.queued.filter(j => !j.notBefore || j.notBefore < resetsAt) : []

  const holdQueue = async () => {
    setHolding(true)
    setHeld(null)
    let moved = 0
    let refused: string | null = null
    for (const j of early) {
      // What else it waits for stays: the task before it, its daily time, its time budget.
      const options = {
        atReset: true,
        ...(j.afterJob != null ? { afterJob: j.afterJob } : {}),
        ...(j.repeatDaily != null ? { repeatDaily: j.repeatDaily } : {}),
        ...(j.maxMinutes != null ? { maxMinutes: j.maxMinutes } : {}),
      }
      const r = await hub.request(m.id, { type: 'job', action: 'edit', job: j.id, options })
      if (r.ok) moved++
      else refused ??= `#${j.id}: ${r.error ?? 'It didn’t go through.'}`
    }
    setHolding(false)
    setHeld(refused ? { ok: false, text: refused } : { ok: true, text: `${moved === 1 ? 'It waits' : `${moved} tasks wait`} until ${clock(resetsAt!, Date.now())}.` })
  }

  return (
    <Page testID="usage" refreshing={false} onRefresh={history.reload}>
      <Stack.Screen options={{ title: 'Usage' }} />
      <Group>
        <LimitRow label="5-hour limit" window={m.limits.fiveHour} />
        <LimitRow label="Weekly limit" window={m.limits.sevenDay} />
      </Group>
      {supports(m, 'limits.history') ? (
        <Group footer={line ?? (history.data ? 'Not enough use lately to tell when it runs out.' : undefined)} testID="usage-history">
          <Block>
            <Segmented options={WINDOWS} value={w} onChange={setW} testID="usage-window" />
            {history.data ? (
              samples.length > 0 ? (
                <Chart bars={bars} from={span.from} label={`${w === 'fiveHour' ? '5-hour' : 'Weekly'} limit, ${span.from} until now: at most ${Math.round(peak)}%.`} />
              ) : (
                <Txt tone="soft">Nothing recorded yet. {m.name} keeps a week of it while it works.</Txt>
              )
            ) : null}
          </Block>
          {!history.data && !history.error ? <LoadingRows count={2} /> : null}
        </Group>
      ) : (
        <Note text={`Update Afterhours on ${m.name} to see its usage over time.`} />
      )}
      {history.error ? <Note ok={false} text={history.error} /> : null}
      {canAct && resetsAt && early.length > 0 ? (
        <Group footer={`Queued tasks start at ${clock(resetsAt, now)}, when the 5-hour limit resets, and not before.`}>
          <Row title={holding ? 'Holding…' : 'Hold the queue until it resets'} tone="accent" disabled={holding} onPress={() => void holdQueue()} testID="hold-until-reset" />
        </Group>
      ) : null}
      {held ? <Note ok={held.ok} text={held.text} testID="hold-outcome" /> : null}
    </Page>
  )
}
