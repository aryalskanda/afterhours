// Settings: this device (its name and key), the app lock, the paired machines, and about.

import { PROTOCOL } from '@afterhours/protocol'
import * as LocalAuthentication from 'expo-local-authentication'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { APP_VERSION, hub, useHub, useNow } from '../../src/app-state'
import { statusColor } from '../../src/components/bits'
import { desktop } from '../../src/desktop'
import { Button, Card, Dot, Field, Label, Outcome, Row, Screen, Section, Soft, Toggle } from '../../src/components/ui'
import { ago, statusLabel } from '../../src/lib/format'
import { mono, useColors } from '../../src/theme'

export default function Settings() {
  const s = useHub()
  const c = useColors()
  const now = useNow(60_000)
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
  return (
    <Screen testID="settings">
      <Section title="This device">
        <Card>
          <Field label="Its name, as machines see it" value={name} onChangeText={t => (setName(t), setSaved(false))} maxLength={80} testID="device-name" />
          <Button
            small
            kind="secondary"
            title="Save the name"
            testID="save-name"
            disabled={!clean || clean === s.deviceName}
            onPress={async () => {
              await hub.setDeviceName(clean)
              setSaved(true)
            }}
          />
          {saved ? <Outcome ok text="Saved, and sent to the machines that are online." /> : null}
          <View style={{ gap: 2 }}>
            <Soft>Key fingerprint</Soft>
            <Text selectable style={{ fontFamily: mono, color: c.ink, fontSize: 14 }} testID="fingerprint">
              {s.fingerprint}
            </Text>
            <Soft>On a machine, cq devices shows the same one for this device.</Soft>
          </View>
        </Card>
      </Section>

      <Section title="Security">
        <Card>
          {desktop ? (
            <>
              <Toggle
                label="Start at login"
                hint="Afterhours starts in the tray, so notifications reach you without opening it."
                value={atLogin}
                testID="start-at-login"
                onChange={async v => {
                  await desktop?.loginItem.set(v)
                  setAtLogin((await desktop?.loginItem.get()) ?? v)
                }}
              />
              <Soft testID="key-storage">
                {desktop.info.keyProtected
                  ? `This device’s key is encrypted by ${desktop.info.platform === 'darwin' ? 'the macOS Keychain' : desktop.info.platform === 'win32' ? 'Windows' : 'your keyring'} and stays on this computer.`
                  : 'This computer has no keyring (such as GNOME Keyring or KWallet), so the key is stored unencrypted in the app’s data folder.'}
              </Soft>
            </>
          ) : Platform.OS === 'web' ? (
            <>
              <Toggle
                label="Notifications in this browser"
                hint={blocked ? 'This browser blocks notifications for this site: allow them in its settings.' : 'When something needs you while this tab is in the background.'}
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
              <Soft>In a browser, this device’s key is kept in the site’s storage, where anything that can read this browser’s data can find it. The phone and desktop apps keep it in the system’s keychain.</Soft>
            </>
          ) : (
            <>
              <Toggle
                label="Lock the app"
                hint={biometrics ? 'Face ID or a fingerprint to open it, and after a minute away.' : 'Set up Face ID or a fingerprint on this phone first.'}
                value={s.prefs.lockApp}
                disabled={!biometrics}
                onChange={v => void hub.setPrefs({ lockApp: v })}
              />
              <Toggle
                label="Confirm Allow"
                hint="Face ID or a fingerprint before a task may use a tool."
                value={s.prefs.confirmAllow}
                disabled={!biometrics}
                onChange={v => void hub.setPrefs({ confirmAllow: v })}
              />
              <Soft>This device’s key stays in the Keychain or Keystore, on this device only: it’s never backed up or sent anywhere.</Soft>
            </>
          )}
        </Card>
      </Section>

      <Section title="Machines" right={<Button small kind="ghost" title="Pair a machine" onPress={() => router.push('/pair')} testID="settings-pair" />}>
        {s.machines.length === 0 ? (
          <Card>
            <Soft>None yet.</Soft>
          </Card>
        ) : (
          s.machines.map(m => (
            <Card key={m.id} onPress={() => router.push({ pathname: '/machine/[id]', params: { id: m.id } })} testID={`settings-machine-${m.name}`}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row>
                  <Dot color={statusColor(m, c)} />
                  <Label>{m.name}</Label>
                </Row>
                {m.role ? <Soft>{m.role}</Soft> : null}
              </Row>
              <Soft>
                {statusLabel(m.status, m.statusDetail)} · paired {ago(m.addedAt, now)} · {m.relay.replace(/^wss?:\/\//, '')}
              </Soft>
            </Card>
          ))
        )}
      </Section>

      <Section title="About">
        <Card>
          <Label>
            Afterhours {APP_VERSION}
            {desktop ? ` · desktop ${desktop.info.version}` : ''}
          </Label>
          <Soft>The app and your machines talk end to end encrypted (Noise, protocol {PROTOCOL}), through a relay that passes messages along without being able to read them.</Soft>
        </Card>
      </Section>
    </Screen>
  )
}
