// One machine: whether it's online, what's running (Screen, Stop, Skip, Continue), what waits on
// you there, the queue, its usage limits, recent tasks, and the rules it sets for apps.

import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import { hub, useMachine, useNow } from '../../../../../src/app-state'
import { LimitRow, statusColor, TaskRow } from '../../../../../src/components/bits'
import { Block, Button, ConfirmButton, ConfirmRow, EmptyState, Group, GroupAction, HStack, Note, Page, Row, StatusDot, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { clock, roleLabel, shortPath, statusLabel } from '../../../../../src/lib/format'
import { needsYou } from '../../../../../src/lib/state'
import { useTheme } from '../../../../../src/theme'

export default function MachineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const { c } = useTheme()
  const now = useNow(5_000)
  const running = useAction()
  const queue = useAction()
  const [refreshing, setRefreshing] = useState(false)
  const needs = useMemo(() => (m ? needsYou([m]) : []), [m])

  if (!m) {
    return (
      <Page>
        <Stack.Screen options={{ title: 'Machine' }} />
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." action={<Button kind="tinted" title="Machines" onPress={() => router.replace('/')} />} />
      </Page>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  const p = m.policy
  const a = m.active
  const blocked = m.limits.blockedUntil && m.limits.blockedUntil > now ? m.limits.blockedUntil : null
  const noUsage = m.limits.fiveHour?.usedPct == null && m.limits.sevenDay?.usedPct == null

  return (
    <Page
      testID="machine"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      <Stack.Screen options={{ title: m.name }} />
      <Group
        footer={
          m.status === 'offline'
            ? 'Not reachable right now. It reconnects by itself; this is what it last said.'
            : m.status === 'refused'
              ? 'This machine removed this device. Pair it again to use it.'
              : undefined
        }
      >
        <Row
          leading={<StatusDot color={statusColor(m, c)} pulse={m.status === 'connected' && a?.status === 'running'} />}
          title={<Txt testID="machine-status">{statusLabel(m.status, m.statusDetail)}</Txt>}
          subtitle={m.info ? `${m.info.os} ${m.info.arch} · Afterhours ${m.info.version}` : undefined}
          value={m.role ? roleLabel(m.role) : undefined}
        />
        {m.status === 'refused' ? <Row title="Pair again" tone="accent" onPress={() => router.push('/pair')} /> : null}
      </Group>

      {needs.length > 0 ? (
        <Group>
          <Row leading={<StatusDot color={c.accent} />} title={`${needs.length} waiting for you`} bold chevron onPress={() => router.push('/inbox')} />
        </Group>
      ) : null}

      <Group header="Running" testID="running">
        {a ? <TaskRow machine={m.id} job={a} /> : <Row title={m.synced ? 'Nothing' : 'Waiting for the machine…'} />}
        {a && canAct ? (
          <Block>
            <HStack wrap>
              {p?.allowScreens ? <Button small kind="gray" title="Screen" onPress={() => router.push({ pathname: '/machine/[id]/screen', params: { id: m.id } })} testID="open-screen" /> : null}
              {a.status === 'held' ? (
                <Button small title="Continue" onPress={() => running.run(m.id, { type: 'control', action: 'go' })} testID="go" />
              ) : a.phase === 'limited' ? (
                <Button small title="Continue now" onPress={() => running.run(m.id, { type: 'control', action: 'continue', job: a.id })} testID="continue-now" />
              ) : (
                <ConfirmButton small title="Stop" confirm="Stop it" onConfirm={() => running.run(m.id, { type: 'control', action: 'stop', job: a.id })} testID="stop" />
              )}
              <ConfirmButton small title={a.status === 'held' ? 'Drop' : 'Skip'} confirm={a.status === 'held' ? 'Drop it' : 'Skip it'} onConfirm={() => running.run(m.id, { type: 'control', action: 'skip', job: a.id })} testID="skip" />
            </HStack>
          </Block>
        ) : null}
      </Group>
      {running.outcome ? <Note ok={running.outcome.ok} text={running.outcome.text} /> : null}

      <Group
        header="Queue"
        right={canAct ? <GroupAction title={m.paused ? 'Resume' : 'Pause'} onPress={() => queue.run(m.id, { type: 'control', action: m.paused ? 'go' : 'pause' })} testID="pause" /> : null}
        footer={m.paused ? 'Paused: nothing new starts until you resume.' : undefined}
      >
        {m.queued.map((j, i) => (
          <TaskRow key={j.id} machine={m.id} job={j} position={i + 1} />
        ))}
        {m.queued.length === 0 ? <Row title={<Txt tone="soft">Empty</Txt>} /> : null}
        {canAct ? <Row testID="machine-new" title="New task here" tone="accent" onPress={() => router.push({ pathname: '/new', params: { machine: m.id } })} /> : null}
      </Group>
      {queue.outcome ? <Note ok={queue.outcome.ok} text={queue.outcome.text} /> : null}

      <Group header="Usage">
        <LimitRow label="5-hour limit" window={m.limits.fiveHour} />
        <LimitRow label="Weekly limit" window={m.limits.sevenDay} />
        {blocked ? <Row title="Next task starts" value={clock(blocked, now)} /> : null}
        {noUsage && !blocked ? <Row title={<Txt tone="soft">Nothing reported yet</Txt>} /> : null}
      </Group>

      <Group header="Recent">
        {m.recent.slice(0, 10).map(j => (
          <TaskRow key={j.id} machine={m.id} job={j} />
        ))}
        {m.recent.length === 0 ? <Row title={<Txt tone="soft">None yet</Txt>} /> : null}
      </Group>

      {p ? (
        <Group header="Rules for apps" footer="Set on the machine, with cq remote.">
          <Row title="Folders" subtitle={p.allowedRoots.map(r => shortPath(r, 200)).join('\n')} subtitleLines={8} />
          <Row title="Skip permission prompts" value={p.allowBypass ? 'Allowed' : 'Off'} />
          <Row title="See the screen" value={p.allowScreens ? 'Allowed' : 'Off'} />
          <Row title="Type into tasks" value={p.allowTyping ? 'Allowed' : 'Off'} />
          {m.role === 'owner' ? <Row title="Devices" chevron onPress={() => router.push({ pathname: '/machine/[id]/devices', params: { id: m.id } })} testID="open-devices" /> : null}
          {m.role === 'owner' ? <Row title="Commands" chevron onPress={() => router.push({ pathname: '/machine/[id]/console', params: { id: m.id } })} testID="open-console" /> : null}
        </Group>
      ) : null}

      <Group>
        <ConfirmRow
          title="Remove from this device"
          confirm="Tap again to remove"
          testID="forget"
          onConfirm={async () => {
            await hub.forget(m.id)
            router.replace('/')
          }}
        />
      </Group>
    </Page>
  )
}
