// The running task's screen, live while you look at it, with typing and keys for a screen
// Afterhours can't answer by itself.

import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { hub, useMachine } from '../../../../../src/app-state'
import { Terminal } from '../../../../../src/components/bits'
import { Block, Button, EmptyState, Group, HStack, Note, Page, TextArea, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { ScreenText } from '../../../../../src/lib/results'

const EVERY_MS = 2500

const KEYS: [string, string][] = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['Enter', 'Enter'],
  ['Esc', 'Escape'],
  ['Tab', 'Tab'],
  ['↑', 'Up'],
  ['↓', 'Down'],
  ['⇧Tab', 'BTab'],
  ['^C', 'C-c'],
]

export default function ScreenView() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const [text, setText] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [say, setSay] = useState('')
  const act = useAction()
  const poke = useRef<() => void>(() => {})
  const jobId = m?.active?.id

  useFocusEffect(
    useCallback(() => {
      if (!id) return
      let stopped = false
      let inflight = false
      let again = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const tick = async () => {
        if (inflight) {
          again = true
          return
        }
        inflight = true
        if (timer) clearTimeout(timer)
        timer = null
        const r = await hub.request(id, { type: 'peek', lines: 60 }, { timeoutMs: 10_000 })
        inflight = false
        if (stopped) return
        if (r.ok) {
          const parsed = ScreenText.safeParse(r.data ?? null)
          const screen = parsed.success ? parsed.data : null
          setText(screen ? screen.text : null)
          setNote(screen ? null : (r.text ?? 'Nothing is running.'))
        } else {
          setNote(r.error ?? 'Couldn’t read the screen.')
        }
        if (again) {
          again = false
          void tick()
          return
        }
        timer = setTimeout(tick, EVERY_MS)
      }
      poke.current = () => void tick()
      void tick()
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
        poke.current = () => {}
      }
    }, [id]),
  )

  if (!m) {
    return (
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }

  const p = m.policy
  const canAct = m.role === 'owner' || m.role === 'operator'
  const soon = () => setTimeout(() => poke.current(), 400)
  return (
    <Page testID="screen">
      <Stack.Screen options={{ title: jobId ? `#${jobId}` : 'Screen' }} />
      {p && !p.allowScreens ? (
        <EmptyState title="The screen stays on the machine" text="To share it, run cq remote screens on, on the machine." />
      ) : (
        <>
          {text !== null ? <Terminal text={text} testID="terminal" /> : <Note text={note ?? 'Reading the screen…'} />}
          {text !== null && note ? <Note ok={false} text={note} /> : null}
          {canAct && jobId && p?.allowTyping ? (
            <>
              <Group header="Type">
                <TextArea placeholder="Sent to Claude with Enter" value={say} onChangeText={setSay} minHeight={70} testID="say" />
                <Block>
                  <Button
                    title="Send"
                    disabled={!say.trim()}
                    testID="say-send"
                    onPress={async () => {
                      const r = await act.run(m.id, { type: 'say', text: say.trim(), job: jobId })
                      if (r.ok) setSay('')
                      soon()
                    }}
                  />
                </Block>
              </Group>
              <Group header="Keys" footer="For a prompt Afterhours can’t answer by itself.">
                <Block>
                  <HStack wrap>
                    {KEYS.map(([label, key]) => (
                      <Button
                        key={key}
                        small
                        kind="gray"
                        title={label}
                        testID={`key-${key}`}
                        onPress={async () => {
                          await act.run(m.id, { type: 'keys', keys: [key], job: jobId })
                          soon()
                        }}
                      />
                    ))}
                  </HStack>
                </Block>
              </Group>
            </>
          ) : canAct && jobId && p && !p.allowTyping ? (
            <Txt v="footnote" tone="soft">
              Typing is off on this machine (cq remote typing on).
            </Txt>
          ) : null}
          {act.outcome ? <Note ok={act.outcome.ok} text={act.outcome.text} /> : null}
        </>
      )}
    </Page>
  )
}
