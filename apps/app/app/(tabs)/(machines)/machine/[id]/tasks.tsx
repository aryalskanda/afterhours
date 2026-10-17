// Every task a machine finished, newest first: a page at a time, by how it ended, or by words in
// the prompt or in Claude's answer.

import type { JobInfo } from '@afterhours/protocol'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { hub, useMachine } from '../../../../../src/app-state'
import { TaskRow } from '../../../../../src/components/bits'
import { Block, EmptyState, NotPaired, FieldRow, Group, LoadingRows, Note, Page, Row, Segmented } from '../../../../../src/components/ui'
import { Jobs, UNREADABLE } from '../../../../../src/lib/results'
import { supports } from '../../../../../src/lib/state'

type Status = 'all' | 'done' | 'failed' | 'cancelled'

const STATUSES: { value: Status; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Stopped' },
]

const PAGE = 30

export default function AllTasks() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const [status, setStatus] = useState<Status>('all')
  const [query, setQuery] = useState('')
  // What's asked for: the words a moment after you stop typing.
  const [words, setWords] = useState('')
  const [jobs, setJobs] = useState<JobInfo[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)
  const online = m?.status === 'connected'

  useEffect(() => {
    const timer = setTimeout(() => setWords(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(
    async (before?: number) => {
      if (!id) return
      const n = ++asked.current
      setLoading(true)
      const r = await hub.request(
        id,
        { type: 'jobs', recent: PAGE, ...(before !== undefined ? { before } : {}), ...(status !== 'all' ? { status } : {}), ...(words ? { query: words } : {}) },
        { timeoutMs: 15_000 },
      )
      if (n !== asked.current) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? 'It didn’t load.')
        return
      }
      const parsed = Jobs.safeParse(r.data)
      if (!parsed.success) {
        setError(UNREADABLE)
        return
      }
      setError(null)
      setJobs(prev => (before !== undefined && prev ? [...prev, ...parsed.data.recent] : parsed.data.recent))
      setMore(parsed.data.more ?? false)
    },
    [id, status, words],
  )

  useEffect(() => {
    setJobs(null)
    if (online) void load()
  }, [load, online])

  if (!m) {
    return (
      <Page>
        <NotPaired />
      </Page>
    )
  }

  if (!supports(m, 'history')) {
    return (
      <Page testID="all-tasks">
        <Stack.Screen options={{ title: 'All tasks' }} />
        <Note text={`Update Afterhours on ${m.name} to see all its tasks and search them.`} />
        <Group>
          {m.recent.map(j => (
            <TaskRow key={j.id} machine={m.id} job={j} />
          ))}
        </Group>
      </Page>
    )
  }

  return (
    <Page testID="all-tasks" refreshing={false} onRefresh={() => void load()}>
      <Stack.Screen options={{ title: 'All tasks' }} />
      <Group>
        <FieldRow placeholder="Search prompts and answers" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" testID="tasks-search" />
      </Group>
      <Group>
        <Block>
          <Segmented options={STATUSES} value={status} onChange={setStatus} label="How it ended" testID="tasks-status" />
        </Block>
      </Group>
      {!online ? <Note text={`${m.name} is offline. Its tasks show when it’s back.`} /> : null}
      {error ? <Note ok={false} text={error} /> : null}
      {jobs === null ? (
        online && !error ? <LoadingRows count={5} /> : null
      ) : jobs.length === 0 ? (
        <EmptyState title={words ? 'Nothing matches' : 'No finished tasks'} text={words ? 'Try other words, or another filter.' : undefined} testID="tasks-none" />
      ) : (
        <Group testID="tasks-list">
          {jobs.map(j => (
            <TaskRow key={j.id} machine={m.id} job={j} />
          ))}
          {more ? <Row title={loading ? 'Loading…' : 'Older tasks'} tone="accent" disabled={loading} onPress={() => void load(jobs.at(-1)!.id)} testID="tasks-more" /> : null}
        </Group>
      )}
    </Page>
  )
}
