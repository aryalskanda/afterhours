// The same prompt tried several ways (each task on its own branch): how each went, what it cost,
// what it changed. Keep one: its branch is merged into your checkout and the others are thrown away.

import type { JobInfo as Job } from '@afterhours/protocol'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { hub, useMachine, useNow } from '../../../../../src/app-state'
import { LineCounts } from '../../../../../src/components/Changes'
import { ConfirmRow, EmptyState, NotPaired, Group, LoadingRows, Note, Page, Row, Txt } from '../../../../../src/components/ui'
import { useLoad } from '../../../../../src/components/useLoad'
import { duration, modelLabel, money, oneLine, phaseLabel } from '../../../../../src/lib/format'
import { DiffSummary, Jobs } from '../../../../../src/lib/results'
import { supports, type MachineState } from '../../../../../src/lib/state'

function Way(props: { m: MachineState; job: Job; now: number }) {
  const { m, job: j, now } = props
  const finished = j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
  const diff = useLoad(m.id, finished ? { type: 'diff', job: j.id } : null, DiffSummary, `diff:${j.id}:${j.status}`, { timeoutMs: 60_000 })
  const added = diff.data?.files.reduce((n, f) => n + (f.added ?? 0), 0) ?? 0
  const removed = diff.data?.files.reduce((n, f) => n + (f.removed ?? 0), 0) ?? 0
  const took = j.startedAt ? (j.finishedAt ?? now) - j.startedAt : null
  return (
    <Group header={`#${j.id} · ${modelLabel(j.model)}`} testID={`way-${j.id}`}>
      <Row title="State" value={`${phaseLabel(j)}${took !== null ? ` · ${duration(took)}` : ''}`} />
      {j.costUsd ? <Row title="Cost" value={money(j.costUsd)} /> : null}
      {finished ? (
        <Row
          title="Changes"
          value={diff.data ? (diff.data.files.length ? <LineCounts added={added} removed={removed} /> : 'None') : diff.error ? '—' : '…'}
          subtitle={diff.data && diff.data.files.length ? `${diff.data.files.length} ${diff.data.files.length === 1 ? 'file' : 'files'}` : undefined}
        />
      ) : null}
      {j.branchNote ? <Row title={<Txt tone="soft">{j.branchNote}</Txt>} /> : null}
      <Row title="Open" chevron onPress={() => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(j.id) } })} testID={`way-open-${j.id}`} />
    </Group>
  )
}

export default function CompareScreen() {
  const { id, group } = useLocalSearchParams<{ id: string; group: string }>()
  const m = useMachine(id)
  const now = useNow(15_000)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const older = useLoad(id, { type: 'jobs', recent: 100 }, Jobs, `jobs:${group}`)
  if (!m) return <NotPaired />

  // The machine's live copies first; older finished ones from its history.
  const byId = new Map<number, Job>()
  for (const j of [...(older.data?.recent ?? []), ...(older.data?.queued ?? []), ...(older.data?.active ? [older.data.active] : [])]) byId.set(j.id, j)
  for (const j of [...m.recent, ...m.queued, ...(m.active ? [m.active] : [])]) byId.set(j.id, j)
  const ways = [...byId.values()].filter(j => j.group === group).sort((a, b) => a.id - b.id)
  const canAct = (m.role === 'owner' || m.role === 'operator') && supports(m, 'branch')
  const done = ways.filter(j => (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') && j.branch && !j.branchNote)

  const keep = async (winner: Job) => {
    setOutcome(null)
    const merged = await hub.request(m.id, { type: 'branch', job: winner.id, action: 'merge' }, { timeoutMs: 120_000 })
    if (!merged.ok) return setOutcome({ ok: false, text: merged.error ?? 'It didn’t merge.' })
    for (const other of done.filter(j => j.id !== winner.id)) await hub.request(m.id, { type: 'branch', job: other.id, action: 'discard' })
    setOutcome({ ok: true, text: `Kept #${winner.id}: ${merged.text ?? 'merged'}. The others are thrown away.` })
    void hub.refresh()
  }

  return (
    <Page testID="compare">
      <Stack.Screen options={{ title: 'Compare' }} />
      {ways.length === 0 ? older.data ? <Note text="These tasks are no longer on the machine." /> : <LoadingRows count={3} /> : null}
      {ways[0] ? <Txt v="footnote" tone="soft">“{oneLine(ways[0].prompt, 160)}”</Txt> : null}
      {ways.map(j => (
        <Way key={j.id} m={m} job={j} now={now} />
      ))}
      {canAct && done.length > 1 ? (
        <Group header="Keep one" footer="Its branch is merged into your checkout (if it has nothing uncommitted), and the other branches are thrown away.">
          {done.map(j => (
            <ConfirmRow key={j.id} tone="accent" title={`Keep #${j.id} (${modelLabel(j.model)})`} confirm={`Tap again to keep #${j.id}`} onConfirm={() => keep(j)} testID={`keep-${j.id}`} />
          ))}
        </Group>
      ) : null}
      {outcome ? <Note ok={outcome.ok} text={outcome.text} /> : null}
    </Page>
  )
}
