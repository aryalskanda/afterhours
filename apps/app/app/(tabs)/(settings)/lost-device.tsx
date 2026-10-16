// A lost or stolen phone: every device paired with the machines this one owns, and removing one
// from all of them at once. Machines that are offline, or that this device doesn't own, are named.

import { fingerprint, type DeviceInfo } from '@afterhours/protocol'
import { Stack } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { hub, useHub, useNow } from '../../../src/app-state'
import { ConfirmRow, EmptyState, Group, LoadingRows, Note, Page, Row, Txt } from '../../../src/components/ui'
import { ago, roleLabel } from '../../../src/lib/format'
import { DeviceList } from '../../../src/lib/results'

interface Known {
  device: DeviceInfo
  /** The machines it's paired with, by id. */
  on: string[]
}

export default function LostDevice() {
  const { machines, deviceId } = useHub()
  const now = useNow(60_000)
  const [known, setKnown] = useState<Known[] | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const owned = machines.filter(m => m.role === 'owner' && m.status === 'connected')
  const unchecked = machines.filter(m => !owned.includes(m))
  const ids = owned.map(m => m.id).join(',')
  const name = (id: string) => machines.find(m => m.id === id)?.name ?? 'a machine'

  const load = useCallback(async () => {
    const lists = await Promise.all(
      ids
        .split(',')
        .filter(Boolean)
        .map(async id => {
          const r = await hub.request(id, { type: 'devices' }, { timeoutMs: 15_000 })
          const parsed = r.ok ? DeviceList.safeParse(r.data) : null
          return { id, devices: parsed?.success ? parsed.data : [] }
        }),
    )
    const all = new Map<string, Known>()
    for (const { id, devices } of lists) {
      for (const d of devices) {
        if (d.id === deviceId) continue
        const k = all.get(d.id)
        if (k) {
          k.on.push(id)
          if ((d.lastSeen ?? 0) > (k.device.lastSeen ?? 0)) k.device = d
        } else all.set(d.id, { device: d, on: [id] })
      }
    }
    setKnown([...all.values()].sort((a, b) => (b.device.lastSeen ?? 0) - (a.device.lastSeen ?? 0)))
  }, [ids, deviceId])

  useEffect(() => {
    void load()
  }, [load])

  const removeEverywhere = async (k: Known) => {
    setOutcome(null)
    const results = await Promise.all(k.on.map(async id => ({ id, r: await hub.request(id, { type: 'devices.remove', device: k.device.id }, { timeoutMs: 15_000 }) })))
    const failed = results.filter(x => !x.r.ok)
    setOutcome(
      failed.length === 0
        ? { ok: true, text: `Removed ${k.device.name} from ${k.on.map(name).join(', ')}.` }
        : { ok: false, text: `Not removed from ${failed.map(x => `${name(x.id)} (${x.r.error ?? 'no answer'})`).join(', ')}.` },
    )
    await load()
  }

  return (
    <Page testID="lost-device" refreshing={false} onRefresh={() => void load()}>
      <Stack.Screen options={{ title: 'Remove a device' }} />
      <Note text="Removing a device cuts it off from a machine at once. It would need a new pairing to come back." />
      {owned.length === 0 ? <EmptyState title="No machines to check" text="This device needs to be an owner of a machine that’s online." /> : null}
      {owned.length > 0 && known === null ? <LoadingRows count={3} /> : null}
      {known && known.length === 0 ? <EmptyState title="No other devices" text="Only this one is paired with the machines it owns." /> : null}
      {(known ?? []).map(k => (
        <Group key={k.device.id} testID={`lost-${k.device.name}`}>
          <Row
            title={k.device.name}
            bold
            value={roleLabel(k.device.role)}
            subtitle={
              <>
                <Txt v="subhead" tone="soft">
                  {k.device.platform} · {k.device.lastSeen ? `seen ${ago(k.device.lastSeen, now)}` : 'not seen since pairing'} · on {k.on.map(name).join(', ')}
                </Txt>
                <Txt v="footnote" tone="faint" mono selectable>
                  {fingerprint(k.device.id)}
                </Txt>
              </>
            }
          />
          <ConfirmRow title={k.on.length > 1 ? 'Remove from every machine' : `Remove from ${name(k.on[0]!)}`} confirm="Tap again to remove" onConfirm={() => removeEverywhere(k)} testID={`lost-remove-${k.device.name}`} />
        </Group>
      ))}
      {outcome ? <Note ok={outcome.ok} text={outcome.text} testID="lost-outcome" /> : null}
      {unchecked.length > 0 ? (
        <Txt v="footnote" tone="soft" style={{ paddingHorizontal: 16 }}>
          Not checked: {unchecked.map(m => `${m.name} (${m.status !== 'connected' ? 'offline' : 'not an owner here'})`).join(', ')}. Remove it there with cq devices remove.
        </Txt>
      ) : null}
    </Page>
  )
}
