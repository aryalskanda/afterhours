// Machines: every paired machine at a glance, and what waits on you. With none yet, how to pair one.

import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { hub, useHub } from '../../../src/app-state'
import { MachineRow } from '../../../src/components/bits'
import { Block, Button, EmptyState, Group, Page, Row, StatusDot, Txt } from '../../../src/components/ui'
import { needsYou } from '../../../src/lib/state'
import { TitleButton } from '../../../src/navigation'
import { useTheme } from '../../../src/theme'

export default function Machines() {
  const { ready, error, machines } = useHub()
  const { c } = useTheme()
  const waiting = useMemo(() => needsYou(machines), [machines])
  const [refreshing, setRefreshing] = useState(false)
  const canQueue = machines.some(m => m.role !== 'viewer' && m.status !== 'refused')

  if (!ready) return <View style={{ flex: 1, backgroundColor: c.page }} />

  return (
    <Page
      title="Machines"
      testID="home"
      action={canQueue ? <TitleButton icon="add" label="New task" onPress={() => router.push('/new')} testID="header-new" /> : undefined}
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
          action={<Button title="Pair a machine" onPress={() => router.push('/pair')} testID="pair-first" />}
        />
      ) : (
        <>
          {waiting.length > 0 ? (
            <Group>
              <Row testID="needs-you-summary" leading={<StatusDot color={c.accent} />} title={`${waiting.length} waiting for you`} bold chevron onPress={() => router.push('/inbox')} />
            </Group>
          ) : null}
          <Group>
            {machines.map(m => (
              <MachineRow key={m.id} machine={m} />
            ))}
          </Group>
          <Group>
            {canQueue ? <Row testID="new-task" title="New task" tone="accent" onPress={() => router.push('/new')} /> : null}
            <Row testID="pair-another" title="Pair a machine" tone="accent" onPress={() => router.push('/pair')} />
          </Group>
        </>
      )}
    </Page>
  )
}
