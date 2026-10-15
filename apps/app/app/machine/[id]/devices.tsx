// The devices paired with a machine (owners only): their roles, when they were last seen, and
// renaming or removing them. A removed device is cut off at once.

import { fingerprint, type DeviceInfo } from '@afterhours/protocol'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { hub, useHub, useMachine, useNow } from '../../../src/app-state'
import { Button, Card, ConfirmButton, Empty, Field, Label, Outcome, Pill, Row, Screen, Soft, Spinner } from '../../../src/components/ui'
import { useAction } from '../../../src/components/useAction'
import { ago } from '../../../src/lib/format'
import { DeviceList, UNREADABLE } from '../../../src/lib/results'
import { mono, useColors } from '../../../src/theme'

export default function Devices() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const { deviceId } = useHub()
  const c = useColors()
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
      <Screen>
        <Empty title="Not paired" text="This machine isn’t paired with this device any more." />
      </Screen>
    )
  }

  return (
    <Screen testID="devices" onRefresh={() => void load()} refreshing={false}>
      <Stack.Screen options={{ title: `Devices on ${m.name}` }} />
      {m.role !== 'owner' ? <Soft>Only an owner of {m.name} sees its devices.</Soft> : null}
      {error ? <Outcome ok={false} text={error} /> : null}
      {devices === null ? (
        online && !error ? <Spinner /> : null
      ) : (
        devices.map(d => (
          <Card key={d.id} testID={`device-${d.name}`}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Label style={{ fontWeight: '600', flex: 1 }}>
                {d.name}
                {d.id === deviceId ? ' (this device)' : ''}
              </Label>
              <Pill text={d.role} />
            </Row>
            <Soft>
              {d.platform} · paired {ago(d.addedAt, now)} · {d.lastSeen ? `seen ${ago(d.lastSeen, now)}` : 'not seen since'}
            </Soft>
            <Text selectable style={{ fontFamily: mono, color: c.soft, fontSize: 12 }}>
              key {fingerprint(d.id)}
            </Text>
            {renaming === d.id ? (
              <View style={{ gap: 8 }}>
                <Field value={name} onChangeText={setName} maxLength={80} autoFocus />
                <Row>
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
                  <Button flex small kind="secondary" title="Cancel" onPress={() => setRenaming(null)} />
                </Row>
              </View>
            ) : (
              <Row>
                <Button
                  small
                  kind="secondary"
                  title="Rename"
                  onPress={() => {
                    setRenaming(d.id)
                    setName(d.name)
                  }}
                />
                {d.id !== deviceId ? (
                  <ConfirmButton
                    small
                    title="Remove"
                    confirm="Remove it?"
                    testID={`remove-device-${d.name}`}
                    onConfirm={async () => {
                      const r = await act.run(m.id, { type: 'devices.remove', device: d.id })
                      if (r.ok) await load()
                    }}
                  />
                ) : null}
              </Row>
            )}
          </Card>
        ))
      )}
      {act.outcome ? <Outcome {...act.outcome} /> : null}
      <Soft>To add a device, run cq pair on {m.name}.</Soft>
    </Screen>
  )
}
