// The devices paired with a machine (owners only): their roles, when they were last seen, and
// renaming or removing them. A removed device is cut off at once.

import { fingerprint, type DeviceInfo } from '@afterhours/protocol'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { hub, useHub, useMachine, useNow } from '../../../../../src/app-state'
import { Block, Button, ConfirmRow, EmptyState, FieldRow, Group, HStack, LoadingRows, Note, Page, Row, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { ago, roleLabel } from '../../../../../src/lib/format'
import { DeviceList, UNREADABLE } from '../../../../../src/lib/results'

export default function Devices() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const { deviceId } = useHub()
  const now = useNow(60_000)
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const act = useAction()
  const online = m?.status === 'connected'

  const load = useCallback(async () => {
    if (!id) return
    const r = await hub.request(id, { type: 'devices' }, { timeoutMs: 15_000 })
    if (!r.ok) {
      setError(r.error ?? 'Couldn’t load the devices.')
      return
    }
    const parsed = DeviceList.safeParse(r.data)
    setError(parsed.success ? null : UNREADABLE)
    if (parsed.success) setDevices(parsed.data)
  }, [id])

  useEffect(() => {
    if (online) void load()
  }, [online, load])

  if (!m) {
    return (
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }

  return (
    <Page testID="devices" onRefresh={() => void load()} refreshing={false}>
      <Stack.Screen options={{ title: 'Devices' }} />
      {m.role !== 'owner' ? <Note text={`Only an owner of ${m.name} sees its devices.`} /> : null}
      {error ? <Note ok={false} text={error} /> : null}
      {devices === null && online && !error ? <LoadingRows /> : null}
      {(devices ?? []).map(d => (
        <Group key={d.id} testID={`device-${d.name}`}>
          <Row
            title={d.id === deviceId ? `${d.name} (this device)` : d.name}
            bold
            value={roleLabel(d.role)}
            subtitle={
              <>
                <Txt v="subhead" tone="soft">
                  {d.platform} · paired {ago(d.addedAt, now)} · {d.lastSeen ? `seen ${ago(d.lastSeen, now)}` : 'not seen since'}
                </Txt>
                <Txt v="footnote" tone="faint" mono selectable>
                  {fingerprint(d.id)}
                </Txt>
              </>
            }
          />
          {renaming === d.id ? <FieldRow value={name} onChangeText={setName} maxLength={80} autoFocus placeholder="Name" /> : null}
          {renaming === d.id ? (
            <Block>
              <HStack>
                <Button
                  flex
                  small
                  title="Save"
                  disabled={!name.trim()}
                  onPress={async () => {
                    const r = await act.run(m.id, { type: 'devices.rename', device: d.id, name: name.trim() })
                    if (r.ok) {
                      setRenaming(null)
                      await load()
                    }
                  }}
                />
                <Button small kind="plain" title="Cancel" onPress={() => setRenaming(null)} />
              </HStack>
            </Block>
          ) : (
            <Row
              title="Rename"
              tone="accent"
              onPress={() => {
                setRenaming(d.id)
                setName(d.name)
              }}
            />
          )}
          {d.id !== deviceId ? (
            <ConfirmRow
              title="Remove"
              confirm="Tap again to remove"
              testID={`remove-device-${d.name}`}
              onConfirm={async () => {
                const r = await act.run(m.id, { type: 'devices.remove', device: d.id })
                if (r.ok) await load()
              }}
            />
          ) : null}
        </Group>
      ))}
      {act.outcome ? <Note ok={act.outcome.ok} text={act.outcome.text} /> : null}
      <Txt v="footnote" tone="soft" style={{ paddingHorizontal: 16 }}>
        To add one, run cq pair on {m.name}.
      </Txt>
    </Page>
  )
}
