// One task: what it was asked and how it runs, Claude's final answer and its plan, and what
// happened. A queued task can run next or come off the queue; a finished one can be followed up.

import type { JobInfo, TaskDetail as Detail } from '@afterhours/protocol'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { hub, useMachine, useNow } from '../../../../../../src/app-state'
import { Markdown } from '../../../../../../src/components/Markdown'
import { Block, ConfirmRow, EmptyState, Group, HStack, LoadingRows, Note, Page, Row, StatusDot, Txt } from '../../../../../../src/components/ui'
import { useAction } from '../../../../../../src/components/useAction'
import { clock, duration, effortLabel, modelLabel, oneLine, permissionsLabel, phaseLabel, planLabel, shortPath, withoutEmoji } from '../../../../../../src/lib/format'
import { TaskDetail, UNREADABLE } from '../../../../../../src/lib/results'
import { findJob, timeline } from '../../../../../../src/lib/state'
import { useTheme } from '../../../../../../src/theme'

export default function TaskScreen() {
  const { id, job } = useLocalSearchParams<{ id: string; job: string }>()
  const jobId = Number(job)
  const m = useMachine(id)
  const { c } = useTheme()
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
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }

  // The live copy says where it is now; the full one has the whole prompt.
  const j: JobInfo | null = live ? { ...live, prompt: detail?.job.prompt ?? live.prompt } : (detail?.job ?? null)
  if (!j) {
    return (
      <Page testID="task">
        <Stack.Screen options={{ title: `#${job}` }} />
        {error ? <Note ok={false} text={error} /> : online ? <LoadingRows count={2} /> : <Note text={`${m.name} is offline. The task shows when it’s back.`} />}
      </Page>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  const isActive = m.active?.id === j.id
  const finished = j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
  const took = j.startedAt ? (j.finishedAt ?? now) - j.startedAt : null
  const session = j.session
  const tone = { queued: c.faint, running: c.okDot, held: c.accent, done: c.okDot, failed: c.danger, cancelled: c.faint }[j.status]

  return (
    <Page testID="task">
      <Stack.Screen options={{ title: `#${j.id}` }} />
      <Group>
        <Block>
          <HStack>
            <StatusDot color={tone} pulse={j.status === 'running'} />
            <Txt v="footnote" tone="soft" num>
              {phaseLabel(j)}
              {took !== null ? ` · ${duration(took)}` : ''}
              {j.status === 'held' && j.holdReason ? ` · ${j.holdReason}` : ''}
            </Txt>
          </HStack>
          <Txt selectable testID="task-prompt">
            {j.prompt}
          </Txt>
          {j.error ? <Txt tone="danger">{j.error}</Txt> : null}
        </Block>
      </Group>

      <Group>
        <Row title="Folder" value={shortPath(j.folder, 34)} />
        <Row title="Plan" value={planLabel(j)} />
        <Row title="Permissions" value={permissionsLabel(j.mode)} />
        <Row title="Model" value={modelLabel(j.model)} />
        <Row title="Effort" value={effortLabel(j.effort)} />
        {j.branch ? <Row title="Branch" value={j.branch} /> : null}
        <Row title="Queued" value={clock(j.createdAt, now)} />
        {j.startedAt ? <Row title="Started" value={clock(j.startedAt, now)} /> : null}
        {j.finishedAt ? <Row title="Finished" value={clock(j.finishedAt, now)} /> : null}
      </Group>

      {canAct && (isActive || j.status === 'queued' || finished) ? (
        <Group>
          {isActive && m.policy?.allowScreens ? <Row title="Screen" chevron onPress={() => router.push({ pathname: '/machine/[id]/screen', params: { id: m.id } })} /> : null}
          {isActive ? <Row title="Stop or skip" chevron onPress={() => router.push({ pathname: '/machine/[id]', params: { id: m.id } })} /> : null}
          {j.status === 'queued' ? <Row title="Run next" tone="accent" onPress={() => act.run(m.id, { type: 'job', action: 'top', job: j.id })} testID="task-top" /> : null}
          {j.status === 'queued' ? <ConfirmRow title="Remove from the queue" confirm="Tap again to remove" onConfirm={() => act.run(m.id, { type: 'job', action: 'remove', job: j.id })} testID="task-remove" /> : null}
          {finished && session ? (
            <Row
              title="Follow up"
              tone="accent"
              testID="follow-up"
              onPress={() => router.push({ pathname: '/new', params: { machine: m.id, session, folder: j.folder, title: oneLine(j.prompt, 60) } })}
            />
          ) : null}
          {finished && !session ? <Row title="New task in this folder" tone="accent" onPress={() => router.push({ pathname: '/new', params: { machine: m.id, folder: j.folder } })} /> : null}
        </Group>
      ) : null}
      {act.outcome ? <Note ok={act.outcome.ok} text={act.outcome.text} /> : null}
      {error && detail ? <Note ok={false} text={error} /> : null}

      {detail?.answer ? (
        <Group header="Claude’s answer" testID="task-answer">
          <Block>
            <Markdown text={detail.answer} />
          </Block>
        </Group>
      ) : null}

      {detail?.plan ? (
        <Group header="Plan" testID="task-plan">
          {showPlan || !detail.answer ? (
            <Block>
              <Markdown text={detail.plan} />
            </Block>
          ) : (
            <Row title="Show the plan" chevron onPress={() => setShowPlan(true)} />
          )}
        </Group>
      ) : null}

      <Group header="What happened">
        {events.map(e => (
          <Row key={e.seq} title={withoutEmoji(e.text.split('\n')[0] ?? '')} titleLines={3} value={<Txt v="footnote" tone="soft" num>{clock(e.at, now)}</Txt>} />
        ))}
        {events.length === 0 ? <Row title={<Txt tone="soft">Nothing this device has seen</Txt>} /> : null}
      </Group>
    </Page>
  )
}
