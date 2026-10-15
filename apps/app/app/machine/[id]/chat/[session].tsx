// One Claude Code conversation: where it left off (your last prompt, Claude's last reply), and a
// box to write the next message.

import type { ChatInfo } from '@afterhours/protocol'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { chatCache, hub, useMachine, useNow } from '../../../../src/app-state'
import { Markdown } from '../../../../src/components/Markdown'
import { Button, Card, Empty, Field, Label, Outcome, Screen, Section, Soft, Spinner, Title } from '../../../../src/components/ui'
import { useAction } from '../../../../src/components/useAction'
import { ago, oneLine, shortPath } from '../../../../src/lib/format'
import { ChatList, Queued } from '../../../../src/lib/results'

export default function ChatScreen() {
  const { id, session } = useLocalSearchParams<{ id: string; session: string }>()
  const m = useMachine(id)
  const now = useNow(60_000)
  const [chat, setChat] = useState<ChatInfo | null>(() => (session ? (chatCache.get(session) ?? null) : null))
  const [missing, setMissing] = useState(false)
  const [text, setText] = useState('')
  const [sent, setSent] = useState<number | null>(null)
  const act = useAction()
  const online = m?.status === 'connected'
  const folder = chat?.folder ?? undefined

  // Fresh from the machine: the list may be old, and a link may have brought you here.
  useEffect(() => {
    if (!id || !session || !online) return
    let cancelled = false
    void (async () => {
      const r = await hub.request(id, { type: 'chats', limit: 50, ...(folder ? { folder } : {}) }, { timeoutMs: 15_000 })
      if (cancelled || !r.ok) return
      const parsed = ChatList.safeParse(r.data)
      const found = parsed.success ? parsed.data.chats.find(x => x.session === session) : undefined
      if (found) {
        chatCache.set(found.session, found)
        setChat(found)
      } else setMissing(true)
    })()
    return () => {
      cancelled = true
    }
  }, [id, session, online, folder])

  if (!m || !session) {
    return (
      <Screen>
        <Empty title="Not paired" text="This machine isn’t paired with this device any more." />
      </Screen>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  return (
    <Screen testID="chat">
      <Stack.Screen options={{ title: chat ? oneLine(chat.title, 32) : 'Chat' }} />
      {chat ? (
        <>
          <Card>
            <Title>{chat.title}</Title>
            <Soft>
              {chat.folder ? shortPath(chat.folder, 60) : 'no folder'} · {ago(chat.updatedAt, now)}
              {chat.model ? ` · ${chat.model}` : ''}
            </Soft>
            {chat.where ? <Soft>Open in {chat.where}{chat.busy ? ', and working' : ''}.</Soft> : null}
          </Card>
          {chat.lastPrompt ? (
            <Section title="You asked">
              <Card>
                <Label selectable>{chat.lastPrompt}</Label>
              </Card>
            </Section>
          ) : null}
          {chat.lastReply ? (
            <Section title="Claude replied">
              <Card testID="chat-reply">
                <Markdown text={chat.lastReply} />
              </Card>
            </Section>
          ) : null}
        </>
      ) : missing ? (
        <Card>
          <Soft>This conversation isn’t among the recent ones {m.name} shares with apps.</Soft>
        </Card>
      ) : online ? (
        <Spinner />
      ) : (
        <Soft>{m.name} is offline: the conversation shows when it’s back.</Soft>
      )}

      {canAct ? (
        <Section title="Write">
          <Field placeholder="Your next message" value={text} onChangeText={setText} multiline testID="chat-text" />
          <Soft>It’s typed into the conversation if the queue is running it and Claude is free; otherwise it runs as a task that continues it.</Soft>
          <Button
            title="Send"
            disabled={!text.trim()}
            testID="chat-send"
            onPress={async () => {
              const r = await act.run(m.id, { type: 'chat.write', session, text: text.trim() })
              if (!r.ok) return
              setText('')
              const queued = Queued.safeParse(r.data)
              setSent(queued.success ? queued.data.job.id : null)
            }}
          />
          {act.outcome ? <Outcome {...act.outcome} /> : null}
          {sent ? <Button kind="secondary" title={`Open #${sent}`} onPress={() => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(sent) } })} /> : null}
          <Button
            kind="ghost"
            title="Write with options (model, mode…)"
            onPress={() => router.push({ pathname: '/new', params: { machine: m.id, session, folder: chat?.folder ?? '', title: chat?.title ?? '' } })}
          />
        </Section>
      ) : null}
    </Screen>
  )
}
