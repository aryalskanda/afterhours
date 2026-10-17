// One file's changes in a task: removed lines red, added green, numbered in the old and new file.
// Tap a line to leave a comment; the comments go back to Claude as a follow-up in the same
// conversation (on the task's branch, if it had one).

import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { hub, useMachine } from '../../../../../../../src/app-state'
import { LineCounts } from '../../../../../../../src/components/Changes'
import { Button, EmptyState, NotPaired, LoadingRows, Note, Txt } from '../../../../../../../src/components/ui'
import { useLoad } from '../../../../../../../src/components/useLoad'
import { parsePatch, type DiffLine } from '../../../../../../../src/lib/diff'
import { basename } from '../../../../../../../src/lib/format'
import { FilePatch, Queued, TaskDetail } from '../../../../../../../src/lib/results'
import { supports } from '../../../../../../../src/lib/state'
import { mono, useTheme } from '../../../../../../../src/theme'

export default function DiffScreen() {
  const { id, job, file, status } = useLocalSearchParams<{ id: string; job: string; file: string; status?: string }>()
  const m = useMachine(id)
  const { c, t, m: metrics, wide } = useTheme()
  const { data, error } = useLoad(id, file ? { type: 'diff', job: Number(job), file } : null, FilePatch, `${job}:${file}`, { timeoutMs: 60_000 })
  const task = useLoad(id, { type: 'task', job: Number(job) }, TaskDetail, `task:${job}`)
  const [comments, setComments] = useState<Record<number, string>>({})
  const [editing, setEditing] = useState<number | null>(null)
  const [sent, setSent] = useState<{ ok: boolean; text: string; job?: number } | null>(null)
  const [sending, setSending] = useState(false)
  const lines = useMemo(() => (data ? parsePatch(data.patch) : []), [data])
  const added = lines.filter(l => l.kind === 'add').length
  const removed = lines.filter(l => l.kind === 'del').length
  const size = wide ? 12 : 12.5
  const lineHeight = wide ? 17 : 18

  if (!m) {
    return <NotPaired />
  }
  const canRead = (m.role === 'owner' || m.role === 'operator') && supports(m, 'files') && status !== 'deleted'
  const t0 = task.data?.job
  // Comments need someone who may queue tasks, and a conversation to follow up.
  const canComment = (m.role === 'owner' || m.role === 'operator') && Boolean(t0?.session)
  const noted = Object.entries(comments).filter(([, text]) => text.trim())
  const send = async () => {
    if (!t0?.session || noted.length === 0) return
    setSending(true)
    const lines = noted.map(([index, text]) => {
      const l = lines0[Number(index)]!
      const where = l.kind === 'del' ? `removed line ${l.old}` : `line ${l.new}`
      return `- ${where} (\`${l.text.trim().slice(0, 120)}\`): ${text.trim()}`
    })
    const prompt = `About your changes in ${file}:\n${lines.join('\n')}`
    const r = await hub.request(m.id, { type: 'queue', folder: t0.folder, prompt, options: { session: t0.session, plan: false, mode: t0.mode === 'plan' ? 'auto' : t0.mode, model: t0.model, effort: t0.effort } })
    setSending(false)
    const q = r.ok ? Queued.safeParse(r.data) : null
    setSent(r.ok ? { ok: true, text: `Sent as #${q?.success ? q.data.job.id : '…'}, in the same conversation.`, job: q?.success ? q.data.job.id : undefined } : { ok: false, text: r.error ?? 'It didn’t go through.' })
    if (r.ok) setComments({})
  }
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

  const lines0 = lines
  const commentBox = (index: number) =>
    editing === index || comments[index] ? (
      <View style={{ marginLeft: 94, marginRight: 10, marginVertical: 4 }}>
        <TextInput
          value={comments[index] ?? ''}
          onChangeText={text => setComments(cs => ({ ...cs, [index]: text }))}
          onBlur={() => setEditing(null)}
          autoFocus={editing === index}
          placeholder="What should change here?"
          placeholderTextColor={c.faint}
          multiline
          testID={`comment-${index}`}
          style={[t.subhead, { color: c.ink, backgroundColor: c.fill, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, minHeight: 40 }]}
        />
      </View>
    ) : null

  const renderLine = ({ item, index }: { item: DiffLine; index: number }) => {
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
      <View>
        <Pressable
          disabled={!canComment}
          onPress={() => setEditing(index)}
          accessibilityHint={canComment ? 'Comments on this line' : undefined}
          testID={`line-${index}`}
          style={({ pressed }) => ({ flexDirection: 'row', backgroundColor: pressed ? c.pressed : bg })}
        >
          <Text style={{ width: 38, textAlign: 'right', fontFamily: mono, fontSize: size - 2, lineHeight, color: c.faint }}>{item.old ?? ''}</Text>
          <Text style={{ width: 38, textAlign: 'right', fontFamily: mono, fontSize: size - 2, lineHeight, color: c.faint }}>{item.new ?? ''}</Text>
          <Text style={{ width: 18, textAlign: 'center', fontFamily: mono, fontSize: size, lineHeight, color: signColor }}>{sign}</Text>
          <Text style={{ flex: 1, fontFamily: mono, fontSize: size, lineHeight, color: c.ink, paddingRight: 10 }}>{item.text || ' '}</Text>
        </Pressable>
        {commentBox(index)}
      </View>
    )
  }

  const footer = (
    <View style={{ paddingHorizontal: metrics.pageX, paddingTop: 16, paddingBottom: 48, gap: 10 }}>
      {canComment && noted.length === 0 && !sent ? <Txt v="footnote" tone="soft">Tap a line to comment on it; the comments go to Claude as a follow-up.</Txt> : null}
      {noted.length > 0 ? (
        <Button title={sending ? 'Sending…' : `Send ${noted.length} ${noted.length === 1 ? 'comment' : 'comments'} to Claude`} disabled={sending} onPress={send} testID="send-comments" />
      ) : null}
      {sent ? <Note ok={sent.ok} text={sent.text} /> : null}
      {sent?.job ? <Button kind="tinted" title={`Open #${sent.job}`} onPress={() => router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(sent.job) } })} /> : null}
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.page }} testID="diff">
      <Stack.Screen options={{ title: file ? basename(file) : 'Diff' }} />
      <FlatList
        data={lines}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderLine}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        extraData={[comments, editing, canComment]}
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.group }}
        initialNumToRender={60}
        windowSize={11}
      />
    </View>
  )
}
