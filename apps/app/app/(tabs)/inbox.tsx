// Needs you: every request waiting on you, across machines, soonest settled first. What you
// answered stays listed for a few minutes, so you can see it went through.

import { useMemo, useState } from 'react'
import { hub, useHub, useNow } from '../../src/app-state'
import { RequestCard } from '../../src/components/Requests'
import { Card, Empty, Outcome, Screen, Section } from '../../src/components/ui'
import { needsYou } from '../../src/lib/state'

const KEEP_MS = 10 * 60_000

export default function Inbox() {
  const { machines } = useHub()
  const needs = useMemo(() => needsYou(machines), [machines])
  const [answered, setAnswered] = useState<{ key: string; text: string; at: number }[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(30_000)
  const recent = answered.filter(a => now - a.at < KEEP_MS)

  return (
    <Screen
      testID="inbox"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      {needs.length === 0 ? (
        <Empty title="Nothing needs you" text="When a task asks for a permission, has questions, or has a plan for you to review, it shows up here." />
      ) : (
        needs.map(n => {
          const key = `${n.machine.id}:${n.approval.code}`
          return (
            <RequestCard
              key={key}
              need={n}
              onAnswered={text => setAnswered(list => [{ key: `${key}:${Date.now()}`, text: `${n.machine.name}: ${text}`, at: Date.now() }, ...list].slice(0, 10))}
            />
          )
        })
      )}
      {recent.length > 0 ? (
        <Section title="Answered just now">
          <Card>
            {recent.map(a => (
              <Outcome key={a.key} ok text={a.text} />
            ))}
          </Card>
        </Section>
      ) : null}
    </Screen>
  )
}
