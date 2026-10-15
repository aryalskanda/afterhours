// One Claude Code conversation: where it left off (your last message, Claude's last reply), and a
// box to write the next one.

import type { ChatInfo } from '@afterhours/protocol'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { chatCache, hub, useMachine, useNow } from '../../../../../src/app-state'
import { Markdown } from '../../../../../src/components/Markdown'
import { Block, Button, EmptyState, Group, HStack, LoadingRows, Note, Page, Row, TextArea, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { ago, oneLine, shortPath } from '../../../../../src/lib/format'
import { ChatList, Queued } from '../../../../../src/lib/results'

export default function ChatScreen() {
  const { machine: id, session } = useLocalSearchParams<{ machine: string; session: string }>()
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
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }

  const canAct = m.role === 'owner' || m.role === 'operator'
  return (
    <Page testID="chat">
      <Stack.Screen options={{ title: chat ? oneLine(chat.title, 28) : 'Chat' }} />
      {chat ? (
        <>
          <Group>
            <Block>
              <Txt v="headline">{chat.title}</Txt>
              <Txt v="footnote" tone="soft" num>
                {chat.folder ? shortPath(chat.folder, 48) : 'No folder'} · {ago(chat.updatedAt, now)}
                {chat.model ? ` · ${chat.model}` : ''}
                {chat.where ? ` · open in ${chat.where}${chat.busy ? ', working' : ''}` : ''}
              </Txt>
            </Block>
          </Group>
          {chat.lastPrompt ? (
            <Group header="You">
              <Block>
                <Txt selectable>{chat.lastPrompt}</Txt>
              </Block>
            </Group>
          ) : null}
          {chat.lastReply ? (
            <Group header="Claude" testID="chat-reply">
              <Block>
                <Markdown text={chat.lastReply} />
              </Block>
            </Group>
          ) : null}
        </>
      ) : missing ? (
        <Note text={`Not among the recent chats ${m.name} shares with apps.`} />
      ) : online ? (
        <LoadingRows count={2} />
      ) : (
        <Note text={`${m.name} is offline. The chat shows when it’s back.`} />
      )}

      {canAct ? (
        <Group header="Reply" footer="Goes straight into the chat if the queue is running it; otherwise it continues as a new task.">
          <TextArea placeholder="Message" value={text} onChangeText={setText} minHeight={90} testID="chat-text" />
          <Block>
            <HStack>
              <Button
                flex
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
              <Button
                kind="plain"
                title="Options…"
                onPress={() => router.push({ pathname: '/new', params: { machine: m.id, session, folder: chat?.folder ?? '', title: chat?.title ?? '' } })}
              />
            </HStack>
          </Block>
        </Group>
      ) : null}
      {act.outcome ? <Note ok={act.outcome.ok} text={act.outcome.text} /> : null}
      {sent ? (
        <Group>
          <Row title={`Open #${sent}`} chevron onPress={() => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(sent) } })} />
        </Group>
      ) : null}
    </Page>
  )
}
