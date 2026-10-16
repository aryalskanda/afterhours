// The devices paired with a machine (owners only): their roles, when they were last seen, and
// renaming or removing them. A removed device is cut off at once. Owners can invite another
// device: a pairing link and its QR code, good for one device for a few minutes.

import { fingerprint, type DeviceInfo, type Role } from '@afterhours/protocol'
import * as Clipboard from 'expo-clipboard'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Platform, Share } from 'react-native'
import { hub, useHub, useMachine, useNow } from '../../../../../src/app-state'
import { QrCode } from '../../../../../src/components/QrCode'
import { Block, Button, ConfirmRow, EmptyState, FieldRow, Group, HStack, LoadingRows, Note, Page, Row, Segmented, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { ago, clock, roleLabel } from '../../../../../src/lib/format'
import { DeviceList, Offer, UNREADABLE } from '../../../../../src/lib/results'
import { supports } from '../../../../../src/lib/state'

const ROLES: { value: Role; label: string }[] = [
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'owner', label: 'Owner' },
]

const ROLE_HINT: Record<Role, string> = {
  operator: 'Queues tasks and answers requests.',
  viewer: 'Sees tasks and requests, changes nothing.',
  owner: 'Everything, devices and commands too.',
}

/** A link another device pairs with: shown as a QR code, copied or shared. */
function Invite(props: { machine: string; name: string; onUsed: () => void }) {
  const now = useNow(5_000)
  const [role, setRole] = useState<Role>('operator')
  const [offer, setOffer] = useState<{ link: string; expires: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { onUsed } = props
  const live = offer && offer.expires > now

  // While it's open, the new device shows up as soon as it pairs.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(onUsed, 5_000)
    return () => clearInterval(timer)
  }, [live, onUsed])

  const create = async () => {
    setError(null)
    setCopied(false)
    const r = await hub.request(props.machine, { type: 'pair.offer', role }, { timeoutMs: 15_000 })
    const parsed = r.ok ? Offer.safeParse(r.data) : null
    if (parsed?.success) setOffer(parsed.data)
    else setError(r.error ?? UNREADABLE)
  }

  if (!live) {
    return (
      <Group header="Invite a device" footer={ROLE_HINT[role]} testID="invite">
        <Block>
          <Segmented options={ROLES} value={role} onChange={setRole} testID="invite-role" />
        </Block>
        <Row title={offer ? 'That link expired. Make another' : 'Make a pairing link'} tone="accent" onPress={() => void create()} testID="invite-create" />
        {error ? <Row title={<Txt tone="danger">{error}</Txt>} /> : null}
      </Group>
    )
  }
  return (
    <Group
      header={`Invite a device as ${roleLabel(role).toLowerCase()}`}
      footer={`Scan it in the Afterhours app on the other device, or send it the link. It pairs one device, until ${clock(offer.expires, now)}; anyone with it can, so keep it to your own devices.`}
      testID="invite"
    >
      <Block gap={12}>
        <QrCode value={offer.link} size={220} label={`Pairing code for ${props.name}`} testID="invite-qr" />
        <Txt v="footnote" tone="soft" mono selectable testID="invite-link">
          {offer.link}
        </Txt>
        <HStack>
          <Button
            flex
            kind="gray"
            title={copied ? 'Copied' : 'Copy link'}
            onPress={async () => {
              await Clipboard.setStringAsync(offer.link)
              setCopied(true)
            }}
            testID="invite-copy"
          />
          {Platform.OS !== 'web' ? <Button flex kind="gray" title="Share" onPress={() => void Share.share({ message: offer.link })} /> : null}
          <Button kind="plain" title="Done" onPress={() => setOffer(null)} testID="invite-done" />
        </HStack>
      </Block>
    </Group>
  )
}

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
      {m.role === 'owner' && online && supports(m, 'invite') ? <Invite machine={m.id} name={m.name} onUsed={load} /> : null}
      <Txt v="footnote" tone="soft" style={{ paddingHorizontal: 16 }}>
        {supports(m, 'invite') ? `Or run cq pair on ${m.name}.` : `To add one, run cq pair on ${m.name}.`}
      </Txt>
    </Page>
  )
}
