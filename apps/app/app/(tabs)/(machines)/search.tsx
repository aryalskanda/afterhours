// Search every machine at once: tasks by their prompt or Claude's answer, chats by their title or
// last messages. Machines that are offline, or too old to search, say so instead.

import type { ChatInfo, JobInfo } from '@afterhours/protocol'
import { router, Stack } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { chatCache, hub, useHub, useNow } from '../../../src/app-state'
import { TaskRow } from '../../../src/components/bits'
import { EmptyState, FieldRow, Group, LoadingRows, Page, Row, Txt } from '../../../src/components/ui'
import { ago, basename } from '../../../src/lib/format'
import { ChatList, Jobs } from '../../../src/lib/results'
import { supports } from '../../../src/lib/state'

interface Found {
  tasks: JobInfo[]
  chats: ChatInfo[]
  error: string | null
}

export default function Search() {
  const { machines } = useHub()
  const now = useNow(60_000)
  const [query, setQuery] = useState('')
  const [words, setWords] = useState('')
  const [found, setFound] = useState<Record<string, Found> | null>(null)
  const asked = useRef(0)
  const searchable = machines.filter(m => m.status === 'connected' && supports(m, 'history'))
  const left = machines.filter(m => !searchable.includes(m))
  const ids = searchable.map(m => m.id).join(',')

  useEffect(() => {
    const timer = setTimeout(() => setWords(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (words.length < 2) {
      setFound(null)
      return
    }
    const n = ++asked.current
    setFound(null)
    void (async () => {
      const results = await Promise.all(
        ids
          .split(',')
          .filter(Boolean)
          .map(async (id): Promise<[string, Found]> => {
            const [tasks, chats] = await Promise.all([
              hub.request(id, { type: 'jobs', recent: 10, query: words }, { timeoutMs: 15_000 }),
              hub.request(id, { type: 'chats', query: words, limit: 10 }, { timeoutMs: 15_000 }),
            ])
            const t = tasks.ok ? Jobs.safeParse(tasks.data) : null
            const c = chats.ok ? ChatList.safeParse(chats.data) : null
            for (const chat of c?.success ? c.data.chats : []) chatCache.set(chat.session, chat)
            return [id, { tasks: t?.success ? t.data.recent : [], chats: c?.success ? c.data.chats : [], error: tasks.ok ? null : (tasks.error ?? 'It didn’t answer.') }]
          }),
      )
      if (n === asked.current) setFound(Object.fromEntries(results))
    })()
  }, [words, ids])

  const total = found ? Object.values(found).reduce((sum, f) => sum + f.tasks.length + f.chats.length, 0) : 0
  return (
    <Page testID="search">
      <Stack.Screen options={{ title: 'Search' }} />
      <Group footer={left.length > 0 ? `Not searched: ${left.map(m => `${m.name} (${m.status === 'connected' ? 'needs an update' : 'offline'})`).join(', ')}.` : undefined}>
        <FieldRow placeholder="Tasks and chats on every machine" value={query} onChangeText={setQuery} autoFocus autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" testID="search-field" />
      </Group>
      {words.length >= 2 && found === null && searchable.length > 0 ? <LoadingRows count={3} /> : null}
      {found && total === 0 ? <EmptyState title="Nothing matches" text="Try other words." testID="search-none" /> : null}
      {found
        ? searchable.map(m => {
            const f = found[m.id]
            if (!f || (f.tasks.length === 0 && f.chats.length === 0 && !f.error)) return null
            return (
              <Group key={m.id} header={machines.length > 1 ? m.name : undefined} footer={f.error ?? undefined} testID={`search-${m.name}`}>
                {f.tasks.map(j => (
                  <TaskRow key={`t${j.id}`} machine={m.id} job={j} />
                ))}
                {f.chats.map(chat => (
                  <Row
                    key={`c${chat.session}`}
                    testID={`search-chat-${chat.session.slice(0, 8)}`}
                    onPress={() => router.push({ pathname: '/chats/[machine]/[session]', params: { machine: m.id, session: chat.session } })}
                    title={chat.title}
                    titleLines={2}
                    subtitle={
                      <Txt v="footnote" tone="soft" lines={1} num>
                        Chat · {chat.folder ? basename(chat.folder) : 'No folder'} · {ago(chat.updatedAt, now)}
                      </Txt>
                    }
                    chevron
                  />
                ))}
              </Group>
            )
          })
        : null}
    </Page>
  )
}
