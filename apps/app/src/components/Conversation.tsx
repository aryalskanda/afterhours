// A conversation as it happened: what you said, what Claude said, and each tool call in a line you
// can open for what came back. The newest part loads first; earlier parts on request. While the
// task runs it refreshes every few seconds, and the tool running right now shows at the end.

import type { TranscriptItem, TranscriptPage as Page, Usage } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { hub } from '../app-state'
import { TranscriptPage, UNREADABLE } from '../lib/results'
import { nowDoing, type MachineState } from '../lib/state'
import { mono, useTheme } from '../theme'
import { Markdown } from './Markdown'
import { Block, Button, Group, LoadingRows, Note, StatusDot, Txt } from './ui'

const FIRST_PAGE = 60
const EARLIER_PAGE = 100
const EVERY_MS = 3000

export interface ConversationMeta {
  total: number
  usage: Usage
  cost: Page['cost']
}

function merge(items: Map<number, TranscriptItem>, more: TranscriptItem[]): Map<number, TranscriptItem> {
  const next = new Map(items)
  for (const item of more) next.set(item.i, item)
  return next
}

export function Conversation(props: { machine: MachineState; job?: number; session?: string; live: boolean; onMeta?: (m: ConversationMeta) => void; testID?: string }) {
  const { machine: m, job, session } = props
  const { c } = useTheme()
  const [items, setItems] = useState<Map<number, TranscriptItem>>(new Map())
  const [before, setBefore] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [earlier, setEarlier] = useState(false)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const onMeta = useRef(props.onMeta)
  onMeta.current = props.onMeta

  const ask = useCallback(
    async (more: { before?: number; after?: number; limit: number }): Promise<Page | null> => {
      const which = job !== undefined ? { job } : { session }
      const r = await hub.request(m.id, { type: 'transcript', ...which, ...more }, { timeoutMs: 20_000 })
      if (!r.ok) {
        setError(r.error ?? 'The conversation didn’t load.')
        return null
      }
      const parsed = TranscriptPage.safeParse(r.data)
      if (!parsed.success) {
        setError(UNREADABLE)
        return null
      }
      setError(null)
      onMeta.current?.({ total: parsed.data.total, usage: parsed.data.usage, cost: parsed.data.cost ?? null })
      return parsed.data
    },
    [m.id, job, session],
  )

  useEffect(() => {
    let cancelled = false
    setItems(new Map())
    setLoaded(false)
    void ask({ limit: FIRST_PAGE }).then(page => {
      if (cancelled || !page) return
      setItems(merge(new Map(), page.items))
      setBefore(page.before)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [ask])

  // While it runs: what's new, and the last few again (a tool call's result arrives after it).
  useFocusEffect(
    useCallback(() => {
      if (!props.live) return
      const timer = setInterval(() => {
        const last = Math.max(-1, ...itemsRef.current.keys())
        void ask({ after: Math.max(-1, last - 30), limit: 200 }).then(page => {
          if (page) setItems(current => merge(current, page.items))
        })
      }, EVERY_MS)
      return () => clearInterval(timer)
    }, [props.live, ask]),
  )

  const loadEarlier = async () => {
    if (before === null) return
    setEarlier(true)
    const page = await ask({ before, limit: EARLIER_PAGE })
    setEarlier(false)
    if (!page) return
    setItems(current => merge(current, page.items))
    setBefore(page.before)
  }

  const list = [...items.values()].sort((a, b) => a.i - b.i)
  const doing = job !== undefined && props.live ? nowDoing(m, job) : null

  if (!loaded) {
    return error ? <Note ok={false} text={error} /> : <LoadingRows count={3} />
  }
  return (
    <Group testID={props.testID}>
      <Block gap={0}>
        {before !== null ? (
          <View style={{ alignItems: 'center', marginBottom: 6 }}>
            <Button small kind="plain" title={earlier ? 'Loading…' : 'Earlier messages'} disabled={earlier} onPress={loadEarlier} testID="conversation-earlier" />
          </View>
        ) : null}
        {list.length === 0 ? <Txt tone="soft">{props.live ? 'Starting…' : 'Nothing said yet.'}</Txt> : null}
        {list.map((item, k) => (
          <Item key={item.i} item={item} previous={list[k - 1]} live={props.live} />
        ))}
        {doing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }} testID="conversation-now">
            <StatusDot color={c.okDot} pulse />
            <Txt v="footnote" tone="soft" lines={1}>
              {doing.tool}
              {doing.detail ? ` · ${doing.detail}` : ''}
            </Txt>
          </View>
        ) : null}
      </Block>
      {error ? <Note ok={false} text={error} /> : null}
    </Group>
  )
}

/** More room between turns than between the tool calls inside one. */
function gapBefore(item: TranscriptItem, previous: TranscriptItem | undefined): number {
  if (!previous) return 0
  if (item.kind === 'tool' && previous.kind === 'tool') return 2
  return 12
}

function Item(props: { item: TranscriptItem; previous: TranscriptItem | undefined; live: boolean }) {
  const { item } = props
  const { c, t, wide } = useTheme()
  const [open, setOpen] = useState(false)
  const marginTop = gapBefore(item, props.previous)
  switch (item.kind) {
    case 'you':
      return (
        <View style={{ marginTop, alignItems: 'flex-end' }} testID={`turn-${item.i}`}>
          <View style={{ backgroundColor: c.fill, borderRadius: wide ? 12 : 16, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '88%' }}>
            <Text selectable numberOfLines={open ? undefined : 12} onPress={() => setOpen(o => !o)} style={[t.body, { color: c.ink }]}>
              {item.text}
            </Text>
          </View>
        </View>
      )
    case 'claude':
      return (
        <View style={{ marginTop }} testID={`turn-${item.i}`}>
          <Markdown text={item.text} />
        </View>
      )
    case 'note':
      return (
        <Txt v="footnote" tone="faint" style={{ marginTop, textAlign: 'center' }}>
          {item.text}
        </Txt>
      )
    case 'tool': {
      const running = item.result === null && !item.error && props.live
      const mark = item.error ? (
        <Ionicons name="close" size={13} color={c.danger} />
      ) : running ? (
        <StatusDot color={c.okDot} pulse />
      ) : (
        <Ionicons name="checkmark" size={13} color={c.faint} />
      )
      return (
        <Pressable
          onPress={() => setOpen(o => !o)}
          disabled={item.result === null}
          role="button"
          aria-expanded={open}
          testID={`tool-${item.i}`}
          style={({ pressed }) => ({ marginTop, opacity: pressed ? 0.6 : 1 })}
        >
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ width: 14, alignItems: 'center', paddingTop: 2 }}>{mark}</View>
            <Text style={[t.footnote, { color: c.soft, flex: 1 }]} numberOfLines={open ? undefined : 2}>
              <Text style={{ color: c.ink, fontWeight: '600' }}>{item.name}</Text>
              {item.detail ? <Text style={{ fontFamily: mono }}>{`  ${item.detail}`}</Text> : null}
            </Text>
          </View>
          {open && item.result ? (
            <View style={{ marginLeft: 22, marginTop: 4, backgroundColor: c.fill, borderRadius: 6, padding: 8 }}>
              <Text selectable style={{ fontFamily: mono, fontSize: t.footnote.fontSize, lineHeight: t.footnote.lineHeight, color: item.error ? c.danger : c.ink }}>
                {item.result}
              </Text>
            </View>
          ) : null}
        </Pressable>
      )
    }
  }
}
