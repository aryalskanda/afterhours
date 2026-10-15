// One task: what it was asked and how it runs, what happened (its events), Claude's final answer
// and its plan, rendered. A finished task can be followed up in the same conversation.

import type { JobInfo, TaskDetail as Detail } from '@afterhours/protocol'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { hub, useMachine, useNow } from '../../../../src/app-state'
import { Icon, NOTICE_ICON } from '../../../../src/components/icons'
import { Markdown } from '../../../../src/components/Markdown'
import { Button, Card, ConfirmButton, Empty, Label, Outcome, Pill, Row, Screen, Section, Soft, Spinner } from '../../../../src/components/ui'
import { useAction } from '../../../../src/components/useAction'
import { clock, duration, modeLabel, oneLine, phaseLabel, shortPath, withoutEmoji } from '../../../../src/lib/format'
import { TaskDetail, UNREADABLE } from '../../../../src/lib/results'
import { findJob, timeline } from '../../../../src/lib/state'
import { useColors } from '../../../../src/theme'

const TONE = { queued: 'plain', running: 'accent', held: 'accent', done: 'ok', failed: 'danger', cancelled: 'plain' } as const

export default function TaskScreen() {
  const { id, job } = useLocalSearchParams<{ id: string; job: string }>()
  const jobId = Number(job)
  const m = useMachine(id)
  const c = useColors()
  const now = useNow(5_000)
  const live = m ? findJob(m, jobId) : null
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const act = useAction()
  const online = m?.status === 'connected'
  // Asked again when the task moves on, for its final answer.
  const stage = live ? `${live.status}:${live.phase}:${live.finishedAt}` : ''

  useEffect(() => {
    if (!id || !Number.isInteger(jobId) || !online) return
    let cancelled = false
    void (async () => {
      const r = await hub.request(id, { type: 'task', job: jobId }, { timeoutMs: 15_000 })
      if (cancelled) return
      if (!r.ok) {
        setError(r.error ?? 'Couldn’t load the task.')
        return
      }
      const parsed = TaskDetail.safeParse(r.data)
      if (!parsed.success) {
        setError(UNREADABLE)
        return
      }
      setError(null)
      setDetail(parsed.data)
    })()
    return () => {
      cancelled = true
    }
  }, [id, jobId, online, stage])

  const events = useMemo(() => (m ? timeline(m, jobId) : []), [m, jobId])

  if (!m) {
    return (
      <Screen>
        <Empty title="Not paired" text="This machine isn’t paired with this device any more." />
      </Screen>
    )
  }

  // The live copy says where it is now; the full one has the whole prompt.
  const j: JobInfo | null = live ? { ...live, prompt: detail?.job.prompt ?? live.prompt } : (detail?.job ?? null)
  if (!j) {
    return (
      <Screen testID="task">
        <Stack.Screen options={{ title: `#${job}` }} />
        {error ? <Outcome ok={false} text={error} /> : online ? <Spinner /> : <Soft>{m.name} is offline: the task shows when it’s back.</Soft>}
      </Screen>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  const isActive = m.active?.id === j.id
  const finished = j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
  const took = j.startedAt ? (j.finishedAt ?? now) - j.startedAt : null
  const session = j.session
  return (
    <Screen testID="task">
      <Stack.Screen options={{ title: `#${j.id}` }} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Pill tone={TONE[j.status]} text={j.status === 'running' || j.status === 'held' ? phaseLabel(j) : j.status} />
          {took !== null ? <Soft>{duration(took)}</Soft> : null}
        </Row>
        <Label selectable testID="task-prompt">
          {j.prompt}
        </Label>
        <Soft>{shortPath(j.folder, 60)}</Soft>
        <Soft>
          {modeLabel(j)} · {j.model} · {j.effort}
          {j.branch ? ` · branch ${j.branch}` : ''}
        </Soft>
        <Soft>
          Queued {clock(j.createdAt, now)}
          {j.startedAt ? ` · started ${clock(j.startedAt, now)}` : ''}
          {j.finishedAt ? ` · finished ${clock(j.finishedAt, now)}` : ''}
        </Soft>
        {j.status === 'held' && j.holdReason ? <Soft>Paused: {j.holdReason}</Soft> : null}
        {j.error ? <Outcome ok={false} text={j.error} /> : null}
      </Card>

      {canAct ? (
        <Row wrap>
          {isActive && m.policy?.allowScreens ? <Button flex kind="secondary" title="Screen" onPress={() => router.push({ pathname: '/machine/[id]/screen', params: { id: m.id } })} /> : null}
          {isActive ? <Button flex kind="secondary" title="Stop, Skip…" onPress={() => router.push({ pathname: '/machine/[id]', params: { id: m.id } })} /> : null}
          {j.status === 'queued' ? <Button flex kind="secondary" title="Run next" onPress={() => act.run(m.id, { type: 'job', action: 'top', job: j.id })} /> : null}
          {j.status === 'queued' ? <ConfirmButton title="Remove" confirm="Remove it?" onConfirm={() => act.run(m.id, { type: 'job', action: 'remove', job: j.id })} /> : null}
          {finished && session ? (
            <Button
              flex
              title="Follow up"
              testID="follow-up"
              onPress={() => router.push({ pathname: '/new', params: { machine: m.id, session, folder: j.folder, title: oneLine(j.prompt, 60) } })}
            />
          ) : null}
          {finished && !session ? <Button flex kind="secondary" title="New task in this folder" onPress={() => router.push({ pathname: '/new', params: { machine: m.id, folder: j.folder } })} /> : null}
        </Row>
      ) : null}
      {act.outcome ? <Outcome {...act.outcome} /> : null}
      {error && detail ? <Outcome ok={false} text={error} /> : null}

      {detail?.answer ? (
        <Section title="Claude’s answer">
          <Card testID="task-answer">
            <Markdown text={detail.answer} />
          </Card>
        </Section>
      ) : null}

      {detail?.plan ? (
        <Section title="The plan">
          <Card testID="task-plan">
            {showPlan || !detail.answer ? (
              <Markdown text={detail.plan} />
            ) : (
              <Pressable onPress={() => setShowPlan(true)}>
                <Text style={{ color: c.accent, fontWeight: '600' }}>Show the plan</Text>
              </Pressable>
            )}
          </Card>
        </Section>
      ) : null}

      <Section title="What happened">
        <Card>
          {events.length === 0 ? (
            <Soft>Nothing this device has seen yet.</Soft>
          ) : (
            events.map(e => (
              <Row key={e.seq} style={{ alignItems: 'flex-start' }}>
                <View style={{ paddingTop: 2 }}>
                  <Icon name={NOTICE_ICON[e.notice.type]} color={c.soft} size={16} />
                </View>
                <Label style={{ flex: 1 }}>{withoutEmoji(e.text.split('\n')[0] ?? '')}</Label>
                <Soft>{clock(e.at, now)}</Soft>
              </Row>
            ))
          )}
        </Card>
      </Section>
    </Screen>
  )
}
