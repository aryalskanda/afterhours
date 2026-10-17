// What devices did on a machine (owners only), newest first: which device asked for what, and
// whether it went through. The machine keeps it; prompts and answers aren't in it.

import Ionicons from '@expo/vector-icons/Ionicons'
import { Stack, useLocalSearchParams } from 'expo-router'
import { View } from 'react-native'
import { useMachine, useNow } from '../../../../../src/app-state'
import { EmptyState, NotPaired, Group, LoadingRows, Note, Page, Row, Txt } from '../../../../../src/components/ui'
import { useLoad } from '../../../../../src/components/useLoad'
import { auditLabel, clock } from '../../../../../src/lib/format'
import { AuditList } from '../../../../../src/lib/results'
import { supports } from '../../../../../src/lib/state'
import { useTheme } from '../../../../../src/theme'

export default function Audit() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const now = useNow(60_000)
  const { c, wide } = useTheme()
  const allowed = m?.role === 'owner' && supports(m, 'audit')
  const log = useLoad(id, allowed && m?.status === 'connected' ? { type: 'audit', limit: 200 } : null, AuditList, `audit:${id}:${m?.status}`)

  if (!m) {
    return (
      <Page>
        <NotPaired />
      </Page>
    )
  }
  const size = wide ? 14 : 16
  return (
    <Page testID="audit" refreshing={false} onRefresh={log.reload}>
      <Stack.Screen options={{ title: 'Activity' }} />
      {m.role !== 'owner' ? <Note text={`Only an owner of ${m.name} sees what devices did there.`} /> : null}
      {m.role === 'owner' && !supports(m, 'audit') ? <Note text={`Update Afterhours on ${m.name} to see this.`} /> : null}
      {log.error ? <Note ok={false} text={log.error} /> : null}
      {allowed && !log.data && !log.error ? <LoadingRows count={6} /> : null}
      {log.data && log.data.entries.length === 0 ? <EmptyState title="Nothing yet" text="What paired devices do here shows up here." /> : null}
      {log.data && log.data.entries.length > 0 ? (
        <Group footer="The newest 200." testID="audit-list">
          {log.data.entries.map((e, i) => (
            <Row
              key={`${e.at}-${i}`}
              leading={
                <View style={{ width: size, alignItems: 'center' }}>
                  <Ionicons name={e.ok ? 'checkmark' : 'close'} size={size} color={e.ok ? c.faint : c.danger} />
                </View>
              }
              title={auditLabel(e.action)}
              subtitle={
                <Txt v="footnote" tone="soft" num lines={2}>
                  {[e.device ?? 'On the machine', clock(e.at, now), e.detail].filter(Boolean).join(' · ')}
                </Txt>
              }
            />
          ))}
        </Group>
      ) : null}
    </Page>
  )
}
