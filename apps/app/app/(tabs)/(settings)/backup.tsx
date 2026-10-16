// Back up this device (its key, machines, name and settings, sealed with a passphrase) and restore
// a backup on a new phone, which then is that device: no pairing again.

import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { Stack } from 'expo-router'
import { useState } from 'react'
import { Platform, Share } from 'react-native'
import { hub, useHub } from '../../../src/app-state'
import { Block, Button, ConfirmRow, FieldRow, Group, HStack, Note, Page, Row, TextArea, Txt } from '../../../src/components/ui'
import { MIN_PASSPHRASE } from '../../../src/lib/backup'

/** In a browser: the backup as a file to save. */
function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `afterhours-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function readPicked(): Promise<string | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true })
  if (r.canceled) return null
  const asset = r.assets[0]
  if (!asset) return null
  if (Platform.OS === 'web' && asset.file) return asset.file.text()
  return new File(asset.uri).text()
}

export default function Backup() {
  const { machines, deviceName } = useHub()
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [made, setMade] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState<{ ok: boolean; text: string } | null>(null)
  const ready = pass.length >= MIN_PASSPHRASE && pass === again

  return (
    <Page testID="backup">
      <Stack.Screen options={{ title: 'Back up and restore' }} />
      <Group
        header="Back up this device"
        footer={`It holds this device’s key: with it and the passphrase, anyone can act as this device on ${machines.length === 1 ? machines[0]!.name : 'your machines'}. Keep the passphrase somewhere else.`}
      >
        <FieldRow label="Passphrase" value={pass} onChangeText={t => (setPass(t), setMade(null))} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={`${MIN_PASSPHRASE}+ characters`} testID="backup-pass" />
        <FieldRow label="Again" value={again} onChangeText={t => (setAgain(t), setMade(null))} secureTextEntry autoCapitalize="none" autoCorrect={false} testID="backup-again" />
        {!made ? (
          <Row
            title={making ? 'Sealing…' : 'Make a backup'}
            tone="accent"
            disabled={!ready || making}
            onPress={async () => {
              setMaking(true)
              setError(null)
              try {
                setMade(await hub.backup(pass))
                setCopied(false)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              }
              setMaking(false)
            }}
            testID="backup-make"
          />
        ) : null}
        {pass && again && pass !== again ? <Row title={<Txt tone="danger" v="subhead">The two don’t match.</Txt>} /> : null}
        {error ? <Row title={<Txt tone="danger" v="subhead">{error}</Txt>} /> : null}
      </Group>
      {made ? (
        <Group footer="Save it where you’ll find it on the new phone: your files, a password manager." testID="backup-made">
          <Block>
            <Txt v="footnote" mono tone="soft" lines={3} selectable testID="backup-text">
              {made}
            </Txt>
            <HStack>
              <Button
                flex
                kind="gray"
                title={copied ? 'Copied' : 'Copy'}
                onPress={async () => {
                  await Clipboard.setStringAsync(made)
                  setCopied(true)
                }}
                testID="backup-copy"
              />
              {Platform.OS === 'web' ? (
                <Button flex kind="gray" title="Download" onPress={() => download(made)} testID="backup-download" />
              ) : (
                <Button flex kind="gray" title="Share" onPress={() => void Share.share({ message: made, title: 'Afterhours backup' })} />
              )}
            </HStack>
          </Block>
        </Group>
      ) : null}

      <Group header="Restore a backup" footer={`This device becomes the one in the backup: its key, machines and settings replace ${deviceName}’s.`}>
        <TextArea placeholder="Paste a backup" value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} minHeight={88} testID="restore-text" />
        <Row
          title="Choose a file"
          tone="accent"
          onPress={async () => {
            const picked = await readPicked().catch(() => null)
            if (picked) setText(picked.trim())
          }}
          testID="restore-file"
        />
        <FieldRow label="Passphrase" value={restorePass} onChangeText={setRestorePass} secureTextEntry autoCapitalize="none" autoCorrect={false} testID="restore-pass" />
        {text.trim() && restorePass ? (
          <ConfirmRow
            title={restoring ? 'Restoring…' : 'Restore'}
            confirm="Tap again to replace this device"
            tone="danger"
            testID="restore-go"
            onConfirm={async () => {
              setRestoring(true)
              setRestored(null)
              try {
                await hub.restore(text, restorePass)
                const s = hub.getState()
                setRestored({ ok: true, text: `Restored: this is ${s.deviceName} again, with ${s.machines.length === 1 ? s.machines[0]!.name : `${s.machines.length} machines`}.` })
                setText('')
                setRestorePass('')
              } catch (err) {
                setRestored({ ok: false, text: err instanceof Error ? err.message : String(err) })
              }
              setRestoring(false)
            }}
          />
        ) : null}
      </Group>
      {restored ? <Note ok={restored.ok} text={restored.text} testID="restore-outcome" /> : null}
    </Page>
  )
}
