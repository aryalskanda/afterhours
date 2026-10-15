// One machine: whether it's online, what's running (with Screen, Stop, Skip, Continue), what
// waits on you there, the queue, its usage limits, recent tasks, and its rules.

import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { hub, useMachine, useNow } from '../../../src/app-state'
import { JobRow, LimitBar, statusColor } from '../../../src/components/bits'
import { RequestCard } from '../../../src/components/Requests'
import { Button, Card, ConfirmButton, Dot, Empty, Label, Outcome, Pill, Row, Screen, Section, Soft } from '../../../src/components/ui'
import { useAction } from '../../../src/components/useAction'
import { basename, clock, duration, oneLine, phaseLabel, statusLabel } from '../../../src/lib/format'
import { needsYou } from '../../../src/lib/state'
import { useColors } from '../../../src/theme'

export default function MachineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const c = useColors()
  const now = useNow(5_000)
  const running = useAction()
  const queue = useAction()
  const [refreshing, setRefreshing] = useState(false)
  const needs = useMemo(() => (m ? needsYou([m]) : []), [m])

  if (!m) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Machine' }} />
        <Empty title="Not paired" text="This machine isn’t paired with this device any more.">
          <Button title="Back to machines" onPress={() => router.replace('/')} />
        </Empty>
      </Screen>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  const p = m.policy
  const a = m.active
  const blocked = m.limits.blockedUntil && m.limits.blockedUntil > now ? m.limits.blockedUntil : null
  const task = (job: number) => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(job) } })

  return (
    <Screen
      testID="machine"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      <Stack.Screen options={{ title: m.name }} />
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row>
            <Dot color={statusColor(m, c)} />
            <Label testID="machine-status">{statusLabel(m.status, m.statusDetail)}</Label>
          </Row>
          {m.role ? <Pill text={m.role} /> : null}
        </Row>
        {m.info ? (
          <Soft>
            {m.info.os} · {m.info.arch} · Afterhours {m.info.version}
          </Soft>
        ) : null}
        {m.status === 'refused' ? (
          <>
            <Label>{m.name} removed this device, so it can’t see or answer anything there. Pair it again to come back.</Label>
            <Button title="Pair again" onPress={() => router.push('/pair')} />
          </>
        ) : null}
        {m.status === 'offline' ? <Soft>Afterhours on {m.name} isn’t reachable right now. The app connects again by itself when it’s back; below is what it last said.</Soft> : null}
        {m.paused ? <Pill tone="accent" text="Paused: nothing new starts" /> : null}
      </Card>

      {needs.length > 0 ? (
        <Section title="Needs you">
          {needs.map(n => (
            <RequestCard key={n.approval.code} need={n} />
          ))}
        </Section>
      ) : null}

      <Section title="Running">
        {a ? (
          <Card testID="running">
            <Pressable onPress={() => task(a.id)}>
              <Label numberOfLines={4}>
                #{a.id} {oneLine(a.prompt, 400)}
              </Label>
            </Pressable>
            <Soft>
              {phaseLabel(a)}
              {a.startedAt ? ` · ${duration(now - a.startedAt)}` : ''} · {basename(a.folder)}
              {a.branch ? ` · ${a.branch}` : ''}
            </Soft>
            {canAct ? (
              <Row wrap>
                {p?.allowScreens ? <Button small kind="secondary" title="Screen" onPress={() => router.push({ pathname: '/machine/[id]/screen', params: { id: m.id } })} testID="open-screen" /> : null}
                {a.status === 'held' ? (
                  <Button small title="Continue" onPress={() => running.run(m.id, { type: 'control', action: 'go' })} testID="go" />
                ) : a.phase === 'limited' ? (
                  <Button small title="Continue now" onPress={() => running.run(m.id, { type: 'control', action: 'continue', job: a.id })} testID="continue-now" />
                ) : (
                  <ConfirmButton small title="Stop" confirm="Stop it?" onConfirm={() => running.run(m.id, { type: 'control', action: 'stop', job: a.id })} testID="stop" />
                )}
                <ConfirmButton small title={a.status === 'held' ? 'Drop it' : 'Skip'} confirm="Sure?" onConfirm={() => running.run(m.id, { type: 'control', action: 'skip', job: a.id })} testID="skip" />
              </Row>
            ) : null}
            {a.status === 'running' && canAct ? <Soft>Stop pauses it where it is (Continue picks it up again); Skip drops it and moves on.</Soft> : null}
            {running.outcome ? <Outcome {...running.outcome} /> : null}
          </Card>
        ) : (
          <Card>
            <Soft>{m.synced ? 'Nothing is running.' : 'Waiting for the machine…'}</Soft>
            {running.outcome ? <Outcome {...running.outcome} /> : null}
          </Card>
        )}
      </Section>

      <Section
        title={`Queue${m.queued.length ? ` · ${m.queued.length}` : ''}`}
        right={
          canAct ? (
            <Button
              small
              kind="ghost"
              title={m.paused ? 'Resume' : 'Pause'}
              onPress={() => queue.run(m.id, { type: 'control', action: m.paused ? 'go' : 'pause' })}
              testID="pause"
            />
          ) : null
        }
      >
        {m.queued.length === 0 ? (
          <Card>
            <Soft>Nothing waiting.</Soft>
          </Card>
        ) : (
          m.queued.map((j, i) => (
            <JobRow
              key={j.id}
              machine={m.id}
              job={j}
              actions={
                canAct ? (
                  <Row style={{ justifyContent: 'flex-end' }}>
                    {i > 0 ? <Button small kind="secondary" title="Run next" onPress={() => queue.run(m.id, { type: 'job', action: 'top', job: j.id })} testID={`top-${j.id}`} /> : null}
                    <ConfirmButton small title="Remove" confirm="Remove it?" onConfirm={() => queue.run(m.id, { type: 'job', action: 'remove', job: j.id })} testID={`remove-${j.id}`} />
                  </Row>
                ) : null
              }
            />
          ))
        )}
        {queue.outcome ? <Outcome {...queue.outcome} /> : null}
        {canAct ? <Button kind="secondary" title="New task here" onPress={() => router.push({ pathname: '/new', params: { machine: m.id } })} testID="machine-new" /> : null}
      </Section>

      <Section title="Usage limits">
        <Card>
          <LimitBar label="5-hour" window={m.limits.fiveHour} />
          <LimitBar label="Weekly" window={m.limits.sevenDay} />
          {blocked ? <Soft>No new task starts before {clock(blocked, now)}.</Soft> : null}
          {m.limits.fiveHour?.usedPct == null && m.limits.sevenDay?.usedPct == null ? <Soft>No usage reported yet.</Soft> : null}
        </Card>
      </Section>

      <Section title="Recent">
        {m.recent.length === 0 ? (
          <Card>
            <Soft>No finished tasks yet.</Soft>
          </Card>
        ) : (
          m.recent.slice(0, 10).map(j => <JobRow key={j.id} machine={m.id} job={j} />)
        )}
      </Section>

      <Section title="This machine">
        <Card>
          {p ? (
            <View style={{ gap: 4 }}>
              <Label>Apps may use these folders, and the folders inside them:</Label>
              {p.allowedRoots.map(r => (
                <Soft key={r}>{r}</Soft>
              ))}
              <Soft>
                {p.allowBypass ? 'Tasks from apps may skip permission prompts.' : 'Tasks from apps can’t skip permission prompts.'} {p.allowScreens ? 'Apps may see the running task’s screen.' : 'The screen stays on the machine.'}{' '}
                {p.allowTyping ? 'Apps may type into tasks.' : 'Apps can’t type into tasks.'}
              </Soft>
              <Soft>Only the machine can change these: cq remote on it.</Soft>
            </View>
          ) : null}
          {m.role === 'owner' ? <Button kind="secondary" title="Devices on this machine" onPress={() => router.push({ pathname: '/machine/[id]/devices', params: { id: m.id } })} testID="open-devices" /> : null}
          <ConfirmButton
            title="Remove from this app"
            confirm="Remove it? Tap again"
            testID="forget"
            onConfirm={async () => {
              await hub.forget(m.id)
              router.replace('/')
            }}
          />
        </Card>
      </Section>
    </Screen>
  )
}
