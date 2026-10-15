// Home: every paired machine at a glance, and what waits on you. With none yet, how to pair one.

import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { Text, View } from 'react-native'
import { hub, useHub } from '../../src/app-state'
import { MachineCard } from '../../src/components/bits'
import { Button, Card, Label, Outcome, Row, Screen, Soft, Spinner, Title } from '../../src/components/ui'
import { needsYou } from '../../src/lib/state'
import { mono, radius, space, useColors } from '../../src/theme'

const KIND: Record<string, [string, string]> = {
  permission: ['permission', 'permissions'],
  question: ['question', 'questions'],
  review: ['plan to review', 'plans to review'],
  trust: ['folder to trust', 'folders to trust'],
}

export default function Home() {
  const { ready, error, machines } = useHub()
  const waiting = useMemo(() => needsYou(machines), [machines])
  const [refreshing, setRefreshing] = useState(false)

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Spinner />
      </View>
    )
  }

  const counts = new Map<string, number>()
  for (const n of waiting) counts.set(n.approval.kind, (counts.get(n.approval.kind) ?? 0) + 1)
  const summary = [...counts].map(([kind, n]) => `${n} ${KIND[kind]?.[n === 1 ? 0 : 1] ?? kind}`).join(' · ')

  return (
    <Screen
      testID="home"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      {error ? (
        <Card>
          <Outcome ok={false} text={`Afterhours couldn’t start: ${error}`} />
        </Card>
      ) : null}
      {machines.length === 0 ? (
        <Welcome />
      ) : (
        <>
          {waiting.length > 0 ? (
            <Card accent onPress={() => router.push('/inbox')} testID="needs-you-summary">
              <Title>
                {waiting.length} {waiting.length === 1 ? 'thing needs' : 'things need'} you
              </Title>
              <Soft>{summary}</Soft>
            </Card>
          ) : null}
          {machines.map(m => (
            <MachineCard key={m.id} machine={m} />
          ))}
          <Row>
            {machines.some(m => m.role !== 'viewer' && m.status !== 'refused') ? <Button flex title="New task" onPress={() => router.push('/new')} testID="new-task" /> : null}
            <Button flex kind="secondary" title="Pair a machine" onPress={() => router.push('/pair')} testID="pair-another" />
          </Row>
        </>
      )}
    </Screen>
  )
}

function Welcome() {
  const c = useColors()
  return (
    <Card testID="welcome">
      <Title>Welcome to Afterhours</Title>
      <Label>Your computers run Claude Code tasks from a queue. This app shows what they’re doing and answers what they ask, from anywhere.</Label>
      <Label>To add a computer, run this on it:</Label>
      <View style={{ backgroundColor: c.code, borderRadius: radius.s, padding: space.m }}>
        <Text selectable style={{ fontFamily: mono, color: c.ink, fontSize: 15 }}>
          cq pair
        </Text>
      </View>
      <Soft>Then scan the code it shows, or paste its link here.</Soft>
      <Button title="Pair a machine" onPress={() => router.push('/pair')} testID="pair-first" />
    </Card>
  )
}
