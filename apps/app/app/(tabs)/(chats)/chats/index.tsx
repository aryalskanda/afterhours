// Chats: your Claude Code conversations on a machine (the ones in folders it shares with apps),
// newest first. Open one to read where it left off and write into it.

import type { ChatInfo } from '@afterhours/protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { chatCache, hub, useHub, useNow } from '../../../../src/app-state'
import { EmptyState, Group, LoadingRows, Note, Page, Row, Segmented, Txt } from '../../../../src/components/ui'
import { ago, basename } from '../../../../src/lib/format'
import { ChatList, UNREADABLE } from '../../../../src/lib/results'

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

  if (!m) {
    return (
      <Page title="Chats">
        <EmptyState title="No machines yet" text="Pair a machine to see its Claude Code chats." />
      </Page>
    )
  }

  return (
    <Page title="Chats" testID="chats" refreshing={loading && chats !== null && page === 0} onRefresh={() => void load(0)}>
      {machines.length > 1 ? (
        <Segmented
          options={machines.map(x => ({ value: x.id, label: x.name }))}
          value={m.id}
          onChange={v => {
            setPicked(v)
            setChats(null)
            setError(null)
          }}
          label="Machine"
        />
      ) : null}
      {!online ? <Note text={`${m.name} is offline. Its chats show when it’s back.`} /> : null}
      {error ? <Note ok={false} text={error} /> : null}
      {chats === null ? (
        online && !error ? <LoadingRows count={4} /> : null
      ) : chats.length === 0 ? (
        <EmptyState title="No chats" text={`None in the folders ${m.name} shares with apps.`} />
      ) : (
        <Group>
          {chats.map(chat => (
            <Row
              key={chat.session}
              testID={`chat-${chat.session.slice(0, 8)}`}
              onPress={() => router.push({ pathname: '/chats/[machine]/[session]', params: { machine: m.id, session: chat.session } })}
              title={chat.title}
              titleLines={2}
              subtitle={
                <Txt v="footnote" tone="soft" lines={1} num>
                  {chat.folder ? basename(chat.folder) : 'No folder'} · {ago(chat.updatedAt, now)}
                  {chat.where ? ` · open in ${chat.where}` : ''}
                  {chat.running ? ' · running' : ''}
                  {chat.limited ? ' · at a limit' : ''}
                </Txt>
              }
              chevron
            />
          ))}
          {more ? <Row title="More" tone="accent" onPress={() => void load(page + 1)} /> : null}
        </Group>
      )}
    </Page>
  )
}
