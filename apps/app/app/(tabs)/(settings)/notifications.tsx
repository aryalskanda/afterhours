// Notifications: push on a phone (through the machines), the browser's when its tab is in the
// background, the desktop app's when its window isn't in front. Then what they're about, whether
// they say what the task asks, and quiet hours.

import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { hub, useHub } from '../../../src/app-state'
import { FieldRow, Group, Note, Page, Row, SwitchRow, Txt } from '../../../src/components/ui'
import { desktop } from '../../../src/desktop'
import { parseTimeOfDay, timeOfDay } from '../../../src/lib/format'
import type { NotifyPrefs } from '../../../src/lib/push'
import { supports } from '../../../src/lib/state'
import { enablePush, pushAvailable } from '../../../src/notifications'

/** A time you type ("10 pm", "22:00"), kept when it reads as one. */
function TimeField(props: { label: string; minutes: number; onChange: (m: number) => void; testID: string }) {
  const [text, setText] = useState(timeOfDay(props.minutes))
  useEffect(() => setText(timeOfDay(props.minutes)), [props.minutes])
  const parsed = parseTimeOfDay(text)
  return (
    <FieldRow
      label={props.label}
      value={text}
      onChangeText={setText}
      onSubmitEditing={() => parsed !== null && props.onChange(parsed)}
      onBlur={() => (parsed === null ? setText(timeOfDay(props.minutes)) : parsed !== props.minutes && props.onChange(parsed))}
      autoCapitalize="none"
      autoCorrect={false}
      testID={props.testID}
    />
  )
}

export default function NotificationSettings() {
  const s = useHub()
  const n = s.prefs.notify
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const set = (patch: Partial<NotifyPrefs>) => void hub.setPrefs({ notify: { ...n, ...patch } })
  const event = (key: keyof NotifyPrefs['events']) => (v: boolean) => set({ events: { ...n.events, [key]: v } })
  const pushOn = Boolean(s.push.token)
  const old = pushAvailable && pushOn ? s.machines.filter(m => m.synced && !supports(m, 'push')) : []

  return (
    <Page testID="notifications">
      <Stack.Screen options={{ title: 'Notifications' }} />
      {pushAvailable ? (
        <Group footer={s.push.error ? undefined : pushOn ? 'Machines push to this phone when the app isn’t open.' : 'When the app isn’t open, machines can push to this phone.'}>
          <SwitchRow
            title="Push notifications"
            value={pushOn}
            disabled={busy}
            testID="push-switch"
            onChange={async v => {
              setBusy(true)
              if (!v) await hub.setPush(null)
              else {
                const r = await enablePush()
                await ('token' in r ? hub.setPush(r.token) : hub.setPush(null, r.error))
              }
              setBusy(false)
            }}
          />
          {s.push.error ? <Row title={<Txt tone="soft" v="subhead">{s.push.error}</Txt>} testID="push-error" /> : null}
        </Group>
      ) : desktop ? (
        <Group footer="When the app’s window isn’t in front.">
          <Row title="Desktop notifications" value="On" />
        </Group>
      ) : Platform.OS === 'web' ? (
        <Group footer={blocked ? 'The browser blocks notifications for this site. Allow them in its settings.' : 'When the tab is in the background.'}>
          <SwitchRow
            title="Notifications"
            value={s.prefs.browserNotifications}
            testID="browser-notifications"
            onChange={async v => {
              if (v && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
                const answer = await Notification.requestPermission()
                setBlocked(answer !== 'granted')
                if (answer !== 'granted') return
              }
              await hub.setPrefs({ browserNotifications: v })
            }}
          />
        </Group>
      ) : null}

      <Group header="About">
        <SwitchRow title="Requests" subtitle="Permissions, questions, plans" value={n.events.requests} onChange={event('requests')} testID="notify-requests" />
        <SwitchRow title="Finished tasks" value={n.events.done} onChange={event('done')} testID="notify-done" />
        <SwitchRow title="Failed or stuck" value={n.events.failed} onChange={event('failed')} testID="notify-failed" />
        <SwitchRow title="Usage limits" value={n.events.limits} onChange={event('limits')} testID="notify-limits" />
      </Group>

      <Group
        footer={
          n.details
            ? pushAvailable
              ? 'They say what the task asks. Pushes pass through Expo and Apple or Google, outside the encryption.'
              : 'They say what the task asks.'
            : 'They only say that a task needs you, or finished; open the app for the rest.'
        }
      >
        <SwitchRow title="Show details" value={n.details} onChange={v => set({ details: v })} testID="notify-details" />
      </Group>

      <Group footer={n.quiet ? `Nothing from ${timeOfDay(n.quiet.start)} to ${timeOfDay(n.quiet.end)}, this device’s time. Requests still wait in Needs you.` : undefined}>
        <SwitchRow title="Quiet hours" value={Boolean(n.quiet)} onChange={v => set({ quiet: v ? { start: 22 * 60, end: 7 * 60 } : null })} testID="notify-quiet" />
        {n.quiet ? <TimeField label="From" minutes={n.quiet.start} onChange={start => set({ quiet: { ...n.quiet!, start } })} testID="quiet-from" /> : null}
        {n.quiet ? <TimeField label="To" minutes={n.quiet.end} onChange={end => set({ quiet: { ...n.quiet!, end } })} testID="quiet-to" /> : null}
      </Group>
      {old.length > 0 ? <Note text={`${old.map(m => m.name).join(', ')} can’t push yet: update Afterhours there.`} /> : null}
    </Page>
  )
}
