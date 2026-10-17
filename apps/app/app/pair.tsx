// Pairing: scan the code `cq pair` shows, paste its link, or open the link on this device. The
// machine then asks for a yes, unless `cq pair` was told to say yes by itself. Inside Telegram the
// bot's Finish setup opens this with its link, and the machine checks with Telegram that it's you.

import { parsePairingLink, type Paired, type Role } from '@afterhours/protocol'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Linking, Platform, View } from 'react-native'
import { hub, useHub } from '../src/app-state'
import { Block, Button, Group, HStack, Note, Page, Row, Spinner, TextArea, Txt } from '../src/components/ui'
import { pairingLinkFrom } from '../src/lib/links'
import { HeaderButton, noBack } from '../src/navigation'
import { inTelegram, telegramReady, telegramScanner } from '../src/telegram'
import { useTheme } from '../src/theme'

type Phase = { kind: 'idle' } | { kind: 'waiting'; name: string } | { kind: 'paired'; paired: Paired } | { kind: 'failed'; text: string }

const ROLE: Record<Role, string> = {
  owner: 'As an owner, this device can do everything there, including adding and removing devices.',
  operator: 'As an operator, this device can start tasks and answer them.',
  viewer: 'As a viewer, this device can look but not act.',
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function Pair() {
  const params = useLocalSearchParams()
  const fromLink = pairingLinkFrom(params)
  const { ready } = useHub()
  const { m } = useTheme()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [text, setText] = useState('')
  const [permission, requestPermission] = useCameraPermissions()
  const busy = useRef(false)
  const lastScan = useRef<string | null>(null)
  // Telegram's own QR scanner, once its script has loaded (phones only).
  const [scan, setScan] = useState<ReturnType<typeof telegramScanner>>(null)
  useEffect(() => {
    if (inTelegram) void telegramReady.then(() => setScan(() => telegramScanner()))
  }, [])

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

  const header = <Stack.Screen options={{ headerLeft: Platform.OS === 'web' ? noBack : () => <HeaderButton title="Cancel" onPress={() => router.back()} /> }} />

  if (phase.kind === 'waiting') {
    return (
      <Page sheet testID="pair">
        {header}
        <Group testID="pair-waiting" footer={inTelegram && fromLink ? 'It checks with Telegram that it’s you.' : 'Say yes where cq pair is running.'}>
          <Row leading={<Spinner />} title={`Waiting for ${phase.name}…`} />
        </Group>
      </Page>
    )
  }

  if (phase.kind === 'paired') {
    const { machine, role } = phase.paired
    return (
      <Page sheet testID="pair">
        <Group testID="pair-done" footer={ROLE[role]}>
          <Block>
            <Txt v="headline">Paired with {machine.name}</Txt>
          </Block>
        </Group>
        <Button
          title={`Open ${machine.name}`}
          testID="pair-open"
          onPress={() => {
            if (router.canGoBack()) router.back()
            router.push({ pathname: '/machine/[id]', params: { id: machine.id } })
          }}
        />
      </Page>
    )
  }

  const scanning = Platform.OS !== 'web'
  return (
    <Page sheet testID="pair">
      {header}
      {phase.kind === 'failed' ? (
        <View testID="pair-failed">
          <Note ok={false} text={phase.text} />
        </View>
      ) : null}
      {scan ? (
        <Group header="Scan the code cq pair shows">
          <Row
            title="Scan with Telegram"
            tone="accent"
            testID="pair-scan-telegram"
            onPress={async () => {
              const data = await scan('Scan the code cq pair shows')
              if (data) void start(data)
            }}
          />
        </Group>
      ) : null}
      {scanning ? (
        <Group header="Scan the code cq pair shows">
          {permission?.granted ? (
            <View style={{ height: 300, borderRadius: m.radius, overflow: 'hidden' }}>
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
            <Row
              title={permission?.canAskAgain === false ? 'Allow the camera in Settings' : 'Use the camera'}
              tone="accent"
              onPress={async () => {
                if (permission?.canAskAgain === false) await Linking.openSettings()
                else await requestPermission()
              }}
            />
          )}
        </Group>
      ) : null}
      <Group header={scanning || scan ? 'Or paste its link' : 'Paste the link cq pair shows'}>
        <TextArea placeholder="afterhours://pair?…" value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} minHeight={88} testID="pair-link" />
        <Block>
          <HStack>
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
            <Button
              kind="plain"
              title="Paste"
              onPress={async () => {
                try {
                  setText(await Clipboard.getStringAsync())
                } catch {
                  setPhase({ kind: 'failed', text: 'The browser didn’t allow reading the clipboard. Paste into the box instead.' })
                }
              }}
            />
          </HStack>
        </Block>
      </Group>
    </Page>
  )
}
