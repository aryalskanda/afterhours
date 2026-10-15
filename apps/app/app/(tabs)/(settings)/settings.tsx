// Settings: this device (its name and key), security, the paired machines, and the version.

import * as LocalAuthentication from 'expo-local-authentication'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { APP_VERSION, hub, useHub } from '../../../src/app-state'
import { statusColor } from '../../../src/components/bits'
import { FieldRow, Group, Note, Page, Row, StatusDot, SwitchRow, Txt } from '../../../src/components/ui'
import { desktop } from '../../../src/desktop'
import { statusLabel } from '../../../src/lib/format'
import { useTheme } from '../../../src/theme'

export default function Settings() {
  const s = useHub()
  const { c } = useTheme()
  const [name, setName] = useState(s.deviceName)
  const [saved, setSaved] = useState(false)
  const [biometrics, setBiometrics] = useState(false)
  const [atLogin, setAtLogin] = useState(false)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => setName(s.deviceName), [s.deviceName])
  useEffect(() => {
    if (desktop) void desktop.loginItem.get().then(setAtLogin)
    if (Platform.OS === 'web') return
    void (async () => setBiometrics((await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync())))()
  }, [])

  const clean = name.trim()
  const keyStore = desktop?.info.platform === 'darwin' ? 'the Keychain' : desktop?.info.platform === 'win32' ? 'Windows' : 'the keyring'
  return (
    <Page title="Settings" testID="settings">
      <Group header="This device" footer={saved ? 'Saved, and sent to the machines that are online.' : 'Machines see this name.'}>
        <FieldRow label="Name" value={name} onChangeText={t => (setName(t), setSaved(false))} maxLength={80} testID="device-name" />
        {clean && clean !== s.deviceName ? (
          <Row
            title="Save the name"
            tone="accent"
            testID="save-name"
            onPress={async () => {
              await hub.setDeviceName(clean)
              setSaved(true)
            }}
          />
        ) : null}
        <Row
          title="Key"
          value={
            <Txt tone="soft" mono selectable testID="fingerprint">
              {s.fingerprint}
            </Txt>
          }
        />
      </Group>

      {desktop ? (
        <Group
          header="This computer"
          footer={
            <Txt v="footnote" tone="soft" testID="key-storage">
              {desktop.info.keyProtected ? `The key is encrypted by ${keyStore}.` : 'No keyring found, so the key is stored unencrypted in the app’s data folder.'}
            </Txt>
          }
        >
          <SwitchRow
            title="Start at login"
            value={atLogin}
            testID="start-at-login"
            onChange={async v => {
              await desktop?.loginItem.set(v)
              setAtLogin((await desktop?.loginItem.get()) ?? v)
            }}
          />
        </Group>
      ) : Platform.OS === 'web' ? (
        <Group header="This browser" footer={blocked ? 'The browser blocks notifications for this site. Allow them in its settings.' : 'The key is kept in this site’s storage.'}>
          <SwitchRow
            title="Notifications"
            subtitle="When the tab is in the background"
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
      ) : (
        <Group header="Security" footer={biometrics ? 'The key never leaves this phone’s Keychain.' : 'Set up Face ID or a fingerprint to use these.'}>
          <SwitchRow title="Lock the app" value={s.prefs.lockApp} disabled={!biometrics} onChange={v => void hub.setPrefs({ lockApp: v })} />
          <SwitchRow title="Confirm Allow" subtitle="Face ID before a task may use a tool" value={s.prefs.confirmAllow} disabled={!biometrics} onChange={v => void hub.setPrefs({ confirmAllow: v })} />
        </Group>
      )}

      <Group header="Machines">
        {s.machines.map(m => (
          <Row
            key={m.id}
            testID={`settings-machine-${m.name}`}
            leading={<StatusDot color={statusColor(m, c)} />}
            title={m.name}
            value={statusLabel(m.status, m.statusDetail)}
            chevron
            onPress={() => router.push({ pathname: '/machine/[id]', params: { id: m.id } })}
          />
        ))}
        <Row title="Pair a machine" tone="accent" onPress={() => router.push('/pair')} testID="settings-pair" />
      </Group>

      <Group footer="End-to-end encrypted. The relay in between can’t read anything.">
        <Row title="Version" value={desktop ? `${APP_VERSION} · desktop ${desktop.info.version}` : APP_VERSION} />
      </Group>
      {s.error ? <Note ok={false} text={s.error} /> : null}
    </Page>
  )
}
