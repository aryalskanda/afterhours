// Machines: every paired machine at a glance, what waits on you, what finished while you were
// away, and with several machines what each is running. With none yet, how to pair one.

import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { hub, useHub, useNow } from '../../../src/app-state'
import { MachineRow, TaskRow } from '../../../src/components/bits'
import { Block, Button, EmptyState, Group, GroupAction, HStack, Page, Row, StatusDot, Txt } from '../../../src/components/ui'
import { clock } from '../../../src/lib/format'
import { finishedSince, needsYou, runningNow, supports } from '../../../src/lib/state'
import { TitleButton } from '../../../src/navigation'
import { useTheme } from '../../../src/theme'

/** "3 done, 1 failed since 9:40 PM." */
function awaySummary(jobs: { job: { status: string } }[], since: number, now: number): string {
  const count = (status: string) => jobs.filter(x => x.job.status === status).length
  const parts = [
    [count('done'), 'done'],
    [count('failed'), 'failed'],
    [count('cancelled'), 'stopped'],
  ].filter(([n]) => (n as number) > 0)
  return `${parts.map(([n, word]) => `${n} ${word}`).join(', ')} since ${clock(since, now)}.`
}

export default function Machines() {
  const { ready, error, machines, away } = useHub()
  const { c } = useTheme()
  const now = useNow(60_000)
  const waiting = useMemo(() => needsYou(machines), [machines])
  const running = useMemo(() => runningNow(machines), [machines])
  const missed = useMemo(() => (away ? finishedSince(machines, away) : []), [machines, away])
  const [allMissed, setAllMissed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const canQueue = machines.some(m => m.role !== 'viewer' && m.status !== 'refused')
  const canSearch = machines.some(m => supports(m, 'history'))
  const several = machines.length > 1

  if (!ready) return <View style={{ flex: 1, backgroundColor: c.page }} />

  return (
    <Page
      title="Machines"
      testID="home"
      action={
        canQueue || canSearch ? (
          <HStack gap={20}>
            {canSearch ? <TitleButton icon="search" label="Search" onPress={() => router.push('/search')} testID="header-search" /> : null}
            {canQueue ? <TitleButton icon="add" label="New task" onPress={() => router.push('/new')} testID="header-new" /> : null}
          </HStack>
        ) : undefined
      }
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      {error ? (
        <Group>
          <Block>
            <Txt tone="danger">Couldn’t start: {error}</Txt>
          </Block>
        </Group>
      ) : null}
      {machines.length === 0 ? (
        <EmptyState
          testID="welcome"
          title="No machines yet"
          text="On a computer, run cq pair, then scan its code."
          action={
            <View style={{ gap: 10, alignSelf: 'stretch' }}>
              <Button title="Pair a machine" onPress={() => router.push('/pair')} testID="pair-first" />
              <Button kind="plain" title="Try a demo machine" onPress={() => void hub.addDemo()} testID="try-demo" />
            </View>
          }
        />
      ) : (
        <>
          {waiting.length > 0 ? (
            <Group>
              <Row testID="needs-you-summary" leading={<StatusDot color={c.accent} />} title={`${waiting.length} waiting for you`} bold chevron onPress={() => router.push('/inbox')} />
            </Group>
          ) : null}
          {away && missed.length > 0 ? (
            <Group header="While you were away" right={<GroupAction title="Clear" onPress={() => hub.dismissAway()} testID="away-clear" />} footer={awaySummary(missed, away, now)} testID="away">
              {(allMissed ? missed : missed.slice(0, 4)).map(x => (
                <TaskRow key={`${x.machine.id}:${x.job.id}`} machine={x.machine.id} job={x.job} where={several ? x.machine.name : undefined} />
              ))}
              {!allMissed && missed.length > 4 ? <Row title={`${missed.length - 4} more`} tone="accent" onPress={() => setAllMissed(true)} /> : null}
            </Group>
          ) : null}
          <Group>
            {machines.map(m => (
              <MachineRow key={m.id} machine={m} />
            ))}
          </Group>
          {several && running.length > 0 ? (
            <Group header="Running now" testID="running-now">
              {running.map(x => (
                <TaskRow key={`${x.machine.id}:${x.job.id}`} machine={x.machine.id} job={x.job} where={x.machine.name} />
              ))}
            </Group>
          ) : null}
          <Group>
            {canQueue ? <Row testID="new-task" title="New task" tone="accent" onPress={() => router.push('/new')} /> : null}
            <Row testID="pair-another" title="Pair a machine" tone="accent" onPress={() => router.push('/pair')} />
          </Group>
        </>
      )}
    </Page>
  )
}
