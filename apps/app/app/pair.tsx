// Pairing: scan the code `cq pair` shows, paste its link, or open the link on this device. The
// machine then asks for a yes, unless `cq pair` was told to say yes by itself.

import { parsePairingLink, type Paired, type Role } from '@afterhours/protocol'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Linking, Platform, View } from 'react-native'
import { hub, useHub } from '../src/app-state'
import { pairingLinkFrom } from '../src/lib/links'
import { Button, Card, Field, Outcome, Row, Screen, Soft, Spinner, Title } from '../src/components/ui'
import { radius } from '../src/theme'

type Phase = { kind: 'idle' } | { kind: 'waiting'; name: string } | { kind: 'paired'; paired: Paired } | { kind: 'failed'; text: string }

const ROLE: Record<Role, string> = {
  owner: 'an owner there: it can do everything, including adding and removing devices',
  operator: 'an operator there: it can start tasks and answer them',
  viewer: 'a viewer there: it can look, but not act',
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function Pair() {
  const params = useLocalSearchParams()
  const fromLink = pairingLinkFrom(params)
  const { ready } = useHub()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [text, setText] = useState('')
  const [permission, requestPermission] = useCameraPermissions()
  const busy = useRef(false)
  const lastScan = useRef<string | null>(null)

  const start = async (link: string) => {
    if (busy.current) return
    let name: string
    try {
      name = parsePairingLink(link).name
    } catch (err) {
      setPhase({ kind: 'failed', text: message(err) })
      return
    }
    busy.current = true
    setPhase({ kind: 'waiting', name })
    try {
      setPhase({ kind: 'paired', paired: await hub.pair(link) })
    } catch (err) {
      setPhase({ kind: 'failed', text: message(err) })
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    if (ready && fromLink) void start(fromLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fromLink])

  if (phase.kind === 'waiting') {
    return (
      <Screen testID="pair">
        <Card accent testID="pair-waiting">
          <Row>
            <Spinner />
            <Title>Waiting for {phase.name}…</Title>
          </Row>
          <Soft>Where cq pair is running on {phase.name}, say yes to this device.</Soft>
        </Card>
      </Screen>
    )
  }

  if (phase.kind === 'paired') {
    const { machine, role } = phase.paired
    return (
      <Screen testID="pair">
        <Card accent testID="pair-done">
          <Title>Paired with {machine.name}</Title>
          <Soft>This device is {ROLE[role]}.</Soft>
          <Button
            title={`Open ${machine.name}`}
            testID="pair-open"
            onPress={() => {
              if (router.canGoBack()) router.back()
              router.push({ pathname: '/machine/[id]', params: { id: machine.id } })
            }}
          />
        </Card>
      </Screen>
    )
  }

  const scanning = Platform.OS !== 'web'
  return (
    <Screen testID="pair">
      {phase.kind === 'failed' ? (
        <Card testID="pair-failed">
          <Outcome ok={false} text={phase.text} />
        </Card>
      ) : null}
      {scanning ? (
        <Card>
          <Title>Scan the code</Title>
          {permission?.granted ? (
            <View style={{ height: 300, borderRadius: radius.m, overflow: 'hidden' }}>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => {
                  // The same code is seen many times a second: try each one once.
                  if (data === lastScan.current) return
                  lastScan.current = data
                  void start(data)
                }}
              />
            </View>
          ) : (
            <>
              <Soft>The camera reads the QR code cq pair shows on the computer.</Soft>
              <Button
                title={permission?.canAskAgain === false ? 'Allow the camera in Settings' : 'Use the camera'}
                onPress={async () => {
                  if (permission?.canAskAgain === false) await Linking.openSettings()
                  else await requestPermission()
                }}
              />
            </>
          )}
        </Card>
      ) : null}
      <Card>
        <Title>{scanning ? 'Or paste the link' : 'Paste the link'}</Title>
        <Soft>Run cq pair on the computer. It shows a link that starts with afterhours://pair.</Soft>
        <Field placeholder="afterhours://pair?…" value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} multiline testID="pair-link" style={{ minHeight: 90 }} />
        <Row>
          <Button
            flex
            kind="secondary"
            title="Paste"
            onPress={async () => {
              try {
                setText(await Clipboard.getStringAsync())
              } catch {
                setPhase({ kind: 'failed', text: 'This browser didn’t let the app read the clipboard. Paste into the box instead.' })
              }
            }}
          />
          <Button
            flex
            title="Pair"
            disabled={!text.trim()}
            onPress={() => {
              lastScan.current = null
              return start(text)
            }}
            testID="pair-go"
          />
        </Row>
      </Card>
    </Screen>
  )
}
