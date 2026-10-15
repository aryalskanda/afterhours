// One file's changes in a task: removed lines red, added green, numbered in the old and new file.

import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'
import { FlatList, Text, View } from 'react-native'
import { useMachine } from '../../../../../../../src/app-state'
import { LineCounts } from '../../../../../../../src/components/Changes'
import { Button, EmptyState, LoadingRows, Note, Txt } from '../../../../../../../src/components/ui'
import { useLoad } from '../../../../../../../src/components/useLoad'
import { parsePatch, type DiffLine } from '../../../../../../../src/lib/diff'
import { basename } from '../../../../../../../src/lib/format'
import { FilePatch } from '../../../../../../../src/lib/results'
import { supports } from '../../../../../../../src/lib/state'
import { mono, useTheme } from '../../../../../../../src/theme'

export default function DiffScreen() {
  const { id, job, file, status } = useLocalSearchParams<{ id: string; job: string; file: string; status?: string }>()
  const m = useMachine(id)
  const { c, t, m: metrics, wide } = useTheme()
  const { data, error } = useLoad(id, file ? { type: 'diff', job: Number(job), file } : null, FilePatch, `${job}:${file}`, { timeoutMs: 60_000 })
  const lines = useMemo(() => (data ? parsePatch(data.patch) : []), [data])
  const added = lines.filter(l => l.kind === 'add').length
  const removed = lines.filter(l => l.kind === 'del').length
  const size = wide ? 12 : 12.5
  const lineHeight = wide ? 17 : 18

  if (!m) {
    return <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
  }
  const canRead = (m.role === 'owner' || m.role === 'operator') && supports(m, 'files') && status !== 'deleted'
  const header = (
    <View style={{ paddingHorizontal: metrics.pageX, paddingTop: 14, paddingBottom: 12, gap: 8 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: t.footnote.fontSize, color: c.soft }}>
        {file}
      </Text>
      {data && !data.binary ? <LineCounts added={added} removed={removed} /> : null}
      {canRead ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button small kind="gray" title="Whole file" onPress={() => router.push({ pathname: '/machine/[id]/task/[job]/file', params: { id: m.id, job, path: file } })} testID="diff-whole-file" />
        </View>
      ) : null}
      {error ? <Note ok={false} text={error} /> : null}
      {!data && !error ? <LoadingRows count={4} /> : null}
      {data?.binary ? <Txt tone="soft">A binary file: no line-by-line changes to show.</Txt> : null}
      {data?.truncated ? <Txt v="footnote" tone="soft">The diff is long; this is its first part.</Txt> : null}
    </View>
  )

  const renderLine = ({ item }: { item: DiffLine }) => {
    if (item.kind === 'hunk') {
      return (
        <View style={{ backgroundColor: c.fill, paddingHorizontal: 10, paddingVertical: 3 }}>
          <Text style={{ fontFamily: mono, fontSize: size - 1, color: c.soft }} numberOfLines={1}>
            {item.text || '…'}
          </Text>
        </View>
      )
    }
    if (item.kind === 'note') {
      return (
        <Text style={{ fontFamily: mono, fontSize: size - 1, color: c.soft, paddingHorizontal: 10, paddingVertical: 2 }}>{item.text}</Text>
      )
    }
    const bg = item.kind === 'add' ? c.addedBg : item.kind === 'del' ? c.removedBg : 'transparent'
    const sign = item.kind === 'add' ? '+' : item.kind === 'del' ? '−' : ' '
    const signColor = item.kind === 'add' ? c.added : item.kind === 'del' ? c.removed : c.faint
    return (
      <View style={{ flexDirection: 'row', backgroundColor: bg }}>
        <Text style={{ width: 38, textAlign: 'right', fontFamily: mono, fontSize: size - 2, lineHeight, color: c.faint }}>{item.old ?? ''}</Text>
        <Text style={{ width: 38, textAlign: 'right', fontFamily: mono, fontSize: size - 2, lineHeight, color: c.faint }}>{item.new ?? ''}</Text>
        <Text style={{ width: 18, textAlign: 'center', fontFamily: mono, fontSize: size, lineHeight, color: signColor }}>{sign}</Text>
        <Text selectable style={{ flex: 1, fontFamily: mono, fontSize: size, lineHeight, color: c.ink, paddingRight: 10 }}>
          {item.text || ' '}
        </Text>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.page }} testID="diff">
      <Stack.Screen options={{ title: file ? basename(file) : 'Diff' }} />
      <FlatList
        data={lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderLine}
        ListHeaderComponent={header}
        ListFooterComponent={<View style={{ height: 48 }} />}
        style={{ backgroundColor: c.group }}
        initialNumToRender={60}
        windowSize={11}
      />
    </View>
  )
}
