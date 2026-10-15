// Needs you: every request waiting on you, across machines, soonest settled first. What you
// answered stays listed for a few minutes, so you can see it went through.

import { useMemo, useState } from 'react'
import { hub, useHub, useNow } from '../../../src/app-state'
import { RequestCard } from '../../../src/components/Requests'
import { EmptyState, Group, Page, Row, Txt } from '../../../src/components/ui'
import { clock } from '../../../src/lib/format'
import { needsYou } from '../../../src/lib/state'

const KEEP_MS = 10 * 60_000

export default function Inbox() {
  const { machines } = useHub()
  const needs = useMemo(() => needsYou(machines), [machines])
  const [answered, setAnswered] = useState<{ key: string; text: string; at: number }[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(30_000)
  const recent = answered.filter(a => now - a.at < KEEP_MS)

  return (
    <Page
      title="Needs you"
      testID="inbox"
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true)
        await hub.refresh()
        setRefreshing(false)
      }}
    >
      {needs.length === 0 ? (
        <EmptyState title="Nothing needs you" text="Permissions, questions and plans from your machines show up here." />
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
        <Group header="Just answered">
          {recent.map(a => (
            <Row key={a.key} title={<Txt v="subhead">{a.text}</Txt>} value={<Txt v="footnote" tone="soft" num>{clock(a.at, now)}</Txt>} />
          ))}
        </Group>
      ) : null}
    </Page>
  )
}
