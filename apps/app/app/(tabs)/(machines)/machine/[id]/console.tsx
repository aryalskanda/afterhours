// The machine's text commands, for its owners: what you'd type to the Telegram bot or `cq`.
// The machine's rules still apply; trust and rule changes stay on the machine itself.

import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { hub, useMachine } from '../../../../../src/app-state'
import { Block, Button, EmptyState, FieldRow, Group, HStack, Page } from '../../../../../src/components/ui'
import { withoutEmoji } from '../../../../../src/lib/format'
import { mono, useTheme } from '../../../../../src/theme'

interface Line {
  command: string
  reply: string
  ok: boolean
}

export default function ConsoleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const { c, t } = useTheme()
  const [lines, setLines] = useState<Line[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const scroll = useRef<ScrollView>(null)

  const run = async (command: string) => {
    if (!id || !command.trim()) return
    setBusy(true)
    const r = await hub.request(id, { type: 'command', text: command.trim() }, { timeoutMs: 30_000 })
    setBusy(false)
    setLines(all => [...all, { command: command.trim(), reply: withoutEmoji(r.ok ? (r.text ?? 'Done.') : (r.error ?? 'It didn’t go through.')), ok: r.ok }])
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50)
  }

  // What the machine understands, first.
  useEffect(() => {
    if (m?.status === 'connected' && m.role === 'owner' && lines.length === 0) void run('help')
  }, [m?.status])

  if (!m) return <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
  if (m.role !== 'owner') {
    return (
      <Page>
        <Stack.Screen options={{ title: 'Commands' }} />
        <EmptyState title="Owners only" text={`Only an owner of ${m.name} can send it commands.`} />
      </Page>
    )
  }
  return (
    <Page testID="console">
      <Stack.Screen options={{ title: 'Commands' }} />
      <Group footer="The machine’s rules apply: folder trust and its rules for apps stay on the machine.">
        <FieldRow placeholder="A command, like status" value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void run(text).then(() => setText(''))} testID="console-input" />
        <Block>
          <HStack>
            <Button
              flex
              title={busy ? 'Sending…' : 'Send'}
              disabled={!text.trim() || busy}
              onPress={async () => {
                await run(text)
                setText('')
              }}
              testID="console-send"
            />
          </HStack>
        </Block>
      </Group>
      <View style={{ backgroundColor: c.terminal, borderRadius: 10, maxHeight: 520 }}>
        <ScrollView ref={scroll} contentContainerStyle={{ padding: 12, gap: 12 }} nestedScrollEnabled>
          {lines.map((l, i) => (
            <View key={i} style={{ gap: 4 }}>
              <Text selectable style={{ fontFamily: mono, fontSize: t.footnote.fontSize, color: c.okDot }}>
                {`› ${l.command}`}
              </Text>
              <Text selectable style={{ fontFamily: mono, fontSize: t.footnote.fontSize, lineHeight: t.footnote.lineHeight, color: l.ok ? c.terminalInk : '#ff8a83' }}>
                {l.reply}
              </Text>
            </View>
          ))}
          {lines.length === 0 ? <Text style={{ fontFamily: mono, color: c.terminalInk }}>…</Text> : null}
        </ScrollView>
      </View>
    </Page>
  )
}
