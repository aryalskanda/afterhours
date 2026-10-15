// The running task's screen, live while you look at it, with typing and keys for a screen
// Afterhours can't answer by itself.

import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { hub, useMachine } from '../../../src/app-state'
import { Terminal } from '../../../src/components/bits'
import { Button, Card, Empty, Field, Outcome, Row, Screen, Soft } from '../../../src/components/ui'
import { useAction } from '../../../src/components/useAction'
import { ScreenText } from '../../../src/lib/results'

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
  ['Shift-Tab', 'BTab'],
  ['Ctrl-C', 'C-c'],
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
      <Screen>
        <Empty title="Not paired" text="This machine isn’t paired with this device any more." />
      </Screen>
    )
  }

  const p = m.policy
  const canAct = m.role === 'owner' || m.role === 'operator'
  const soon = () => setTimeout(() => poke.current(), 400)
  return (
    <Screen testID="screen">
      <Stack.Screen options={{ title: jobId ? `#${jobId} on ${m.name}` : m.name }} />
      {p && !p.allowScreens ? (
        <Empty title="The screen stays on the machine" text={`${m.name} doesn’t share task screens with apps. To change that, on the machine: cq remote screens on.`} />
      ) : (
        <>
          {text !== null ? <Terminal text={text} testID="terminal" /> : <Card>{<Soft>{note ?? 'Reading the screen…'}</Soft>}</Card>}
          {text !== null && note ? <Outcome ok={false} text={note} /> : null}
          {canAct && jobId && p?.allowTyping ? (
            <>
              <Card>
                <Field placeholder="Type to Claude (sent with Enter)" value={say} onChangeText={setSay} multiline testID="say" style={{ minHeight: 70 }} />
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
              </Card>
              <Card>
                <Soft>Press keys, for a screen Afterhours can’t answer by itself:</Soft>
                <Row wrap>
                  {KEYS.map(([label, key]) => (
                    <Button
                      key={key}
                      small
                      kind="secondary"
                      title={label}
                      testID={`key-${key}`}
                      onPress={async () => {
                        await act.run(m.id, { type: 'keys', keys: [key], job: jobId })
                        soon()
                      }}
                    />
                  ))}
                </Row>
              </Card>
            </>
          ) : canAct && jobId && p && !p.allowTyping ? (
            <Soft>{m.name} doesn’t let apps type into tasks. To change that, on the machine: cq remote typing on.</Soft>
          ) : null}
          {act.outcome ? <Outcome {...act.outcome} /> : null}
        </>
      )}
    </Screen>
  )
}
