// Is everything reachable: each machine's state, the relay it's reached through, and how long a
// request takes there and back.

import { Stack } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { hub, useHub } from '../../../src/app-state'
import { statusColor } from '../../../src/components/bits'
import { Group, Page, Row, StatusDot, Txt } from '../../../src/components/ui'
import { statusLabel } from '../../../src/lib/format'
import { useTheme } from '../../../src/theme'

function host(relay: string): string {
  try {
    return new URL(relay).host
  } catch {
    return relay
  }
}

export default function Connection() {
  const { machines } = useHub()
  const { c } = useTheme()
  const [times, setTimes] = useState<Record<string, number | string>>({})
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    const results = await Promise.all(
      hub.getState().machines.map(async m => {
        if (m.status !== 'connected') return [m.id, m.status === 'refused' ? 'Removed this device' : 'Not reachable'] as const
        const started = Date.now()
        const r = await hub.request(m.id, { type: 'jobs', recent: 0 }, { timeoutMs: 15_000 })
        return [m.id, r.ok ? Date.now() - started : (r.error ?? 'No answer')] as const
      }),
    )
    setTimes(Object.fromEntries(results))
    setChecking(false)
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  return (
    <Page testID="connection" refreshing={false} onRefresh={() => void check()}>
      <Stack.Screen options={{ title: 'Connection' }} />
      <Group footer="Everything goes through the relay, end-to-end encrypted. When a machine can’t be reached, the app keeps trying.">
        {machines.map(m => {
          const t = times[m.id]
          return (
            <Row
              key={m.id}
              leading={<StatusDot color={statusColor(m, c)} />}
              title={m.name}
              subtitle={`${statusLabel(m.status, m.statusDetail)} · through ${host(m.relay)}`}
              value={typeof t === 'number' ? <Txt num tone={t > 2000 ? 'danger' : 'soft'}>{`${t} ms`}</Txt> : typeof t === 'string' ? <Txt tone="danger" v="subhead">{t}</Txt> : undefined}
              testID={`connection-${m.name}`}
            />
          )
        })}
        <Row title={checking ? 'Checking…' : 'Check again'} tone="accent" disabled={checking} onPress={() => void check()} testID="connection-check" />
      </Group>
    </Page>
  )
}
