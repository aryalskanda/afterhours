// Chats: your Claude Code conversations on a machine (the ones in folders it shares with apps),
// newest first. Open one to read where it left off and write into it.

import type { ChatInfo } from '@afterhours/protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { chatCache, hub, useHub, useNow } from '../../src/app-state'
import { Button, Card, Choice, Empty, Label, Outcome, Pill, Row, Screen, Soft, Spinner } from '../../src/components/ui'
import { ago, basename, oneLine } from '../../src/lib/format'
import { ChatList, UNREADABLE } from '../../src/lib/results'

export default function Chats() {
  const { machines } = useHub()
  const now = useNow(60_000)
  const [picked, setPicked] = useState<string | null>(null)
  const m = machines.find(x => x.id === picked) ?? machines[0]
  const [chats, setChats] = useState<ChatInfo[] | null>(null)
  const [more, setMore] = useState(false)
  const [page, setPage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const id = m?.id
  const online = m?.status === 'connected'

  const load = useCallback(
    async (p: number) => {
      if (!id) return
      setLoading(true)
      const r = await hub.request(id, { type: 'chats', page: p, limit: 20 }, { timeoutMs: 15_000 })
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? 'Couldn’t load the chats.')
        return
      }
      const parsed = ChatList.safeParse(r.data)
      if (!parsed.success) {
        setError(UNREADABLE)
        return
      }
      for (const chat of parsed.data.chats) chatCache.set(chat.session, chat)
      setError(null)
      setChats(prev => (p === 0 ? parsed.data.chats : [...(prev ?? []), ...parsed.data.chats]))
      setMore(parsed.data.more)
      setPage(p)
    },
    [id],
  )

  useFocusEffect(
    useCallback(() => {
      if (online) void load(0)
    }, [load, online]),
  )

  if (!m) return <Screen><Empty title="No machines yet" text="Pair a machine to see its Claude Code chats here." /></Screen>

  return (
    <Screen
      testID="chats"
      refreshing={loading && chats !== null && page === 0}
      onRefresh={() => void load(0)}
    >
      {machines.length > 1 ? (
        <Choice
          options={machines.map(x => ({ value: x.id, label: x.name }))}
          value={m.id}
          onChange={v => {
            setPicked(v)
            setChats(null)
            setError(null)
          }}
        />
      ) : null}
      {!online ? <Soft>{m.name} is offline: its chats show when it’s back.</Soft> : null}
      {error ? <Outcome ok={false} text={error} /> : null}
      {chats === null ? (
        online && !error ? <Spinner /> : null
      ) : chats.length === 0 ? (
        <Empty title="No chats" text={`No Claude Code conversations in the folders ${m.name} shares with apps.`} />
      ) : (
        chats.map(chat => (
          <Card
            key={chat.session}
            testID={`chat-${chat.session.slice(0, 8)}`}
            onPress={() => router.push({ pathname: '/machine/[id]/chat/[session]', params: { id: m.id, session: chat.session } })}
          >
            <Label numberOfLines={2} style={{ fontWeight: '600' }}>
              {chat.title}
            </Label>
            <Soft numberOfLines={1}>
              {chat.folder ? basename(chat.folder) : 'no folder'} · {ago(chat.updatedAt, now)}
              {chat.model ? ` · ${chat.model}` : ''}
            </Soft>
            {chat.where || chat.running || chat.limited ? (
              <Row wrap>
                {chat.where ? <Pill tone="accent" text={`open in ${chat.where}`} /> : null}
                {chat.running ? <Pill tone="ok" text="running in the queue" /> : null}
                {chat.limited ? <Pill tone="danger" text="at a usage limit" /> : null}
              </Row>
            ) : null}
            {chat.lastPrompt ? <Soft numberOfLines={2}>You: {oneLine(chat.lastPrompt, 160)}</Soft> : null}
          </Card>
        ))
      )}
      {more ? <Button kind="secondary" title="More" onPress={() => load(page + 1)} /> : null}
    </Screen>
  )
}
