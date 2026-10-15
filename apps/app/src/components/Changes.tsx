// The files a task changed, with lines added and removed; each opens its diff. While the task runs
// the list refreshes now and then.

import type { DiffFile, JobInfo } from '@afterhours/protocol'
import { router } from 'expo-router'
import { Text } from 'react-native'
import { basename } from '../lib/format'
import { DiffSummary } from '../lib/results'
import type { MachineState } from '../lib/state'
import { mono, useTheme } from '../theme'
import { Group, LoadingRows, Note, Row, Txt } from './ui'
import { useLoad } from './useLoad'

/** "+12 −3", in the diff's colours. */
export function LineCounts(props: { added: number | null; removed: number | null }) {
  const { c, t } = useTheme()
  if (props.added === null && props.removed === null) return <Txt v="footnote" tone="soft">Binary</Txt>
  return (
    <Text style={[t.footnote, { fontVariant: ['tabular-nums'] }]}>
      <Text style={{ color: c.added }}>+{props.added ?? 0}</Text>
      <Text style={{ color: c.soft }}> </Text>
      <Text style={{ color: c.removed }}>−{props.removed ?? 0}</Text>
    </Text>
  )
}

function what(f: DiffFile): string | null {
  if (f.status === 'added') return 'New'
  if (f.status === 'deleted') return 'Deleted'
  if (f.status === 'renamed') return `Renamed from ${f.from}`
  return null
}

export function Changes(props: { machine: MachineState; job: JobInfo; live: boolean }) {
  const { machine: m, job } = props
  const { c, t } = useTheme()
  const { data, error } = useLoad(m.id, { type: 'diff', job: job.id }, DiffSummary, `diff:${job.id}`, { every: props.live ? 8000 : undefined, timeoutMs: 60_000 })
  if (!data) return error ? <Note ok={false} text={error} /> : <LoadingRows count={2} />
  const added = data.files.reduce((n, f) => n + (f.added ?? 0), 0)
  const removed = data.files.reduce((n, f) => n + (f.removed ?? 0), 0)
  const footer =
    data.basis === 'since-start'
      ? 'This task is from before Afterhours kept exact changes: this is everything since it started, your own edits too.'
      : data.basis === 'none'
        ? 'No changes to show: the folder isn’t a git repo, or it’s gone.'
        : data.truncated
          ? 'Only the first 500 files.'
          : undefined
  return (
    <Group
      testID="changes"
      header={data.files.length > 0 ? `${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}` : undefined}
      right={data.files.length > 0 ? <LineCounts added={added} removed={removed} /> : undefined}
      footer={footer}
    >
      {data.files.length === 0 && data.basis !== 'none' ? <Row title={<Txt tone="soft">{props.live ? 'Nothing changed yet' : 'Nothing changed'}</Txt>} /> : null}
      {data.files.map(f => {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
        const note = what(f)
        return (
          <Row
            key={f.path}
            testID={`change-${f.path}`}
            title={basename(f.path)}
            subtitle={
              dir || note ? (
                <Text style={[t.footnote, { color: c.soft }]} numberOfLines={2}>
                  {dir ? <Text style={{ fontFamily: mono }}>{dir}</Text> : null}
                  {dir && note ? '  ·  ' : ''}
                  {note ?? ''}
                </Text>
              ) : undefined
            }
            value={<LineCounts added={f.added} removed={f.removed} />}
            chevron
            onPress={() =>
              router.push({ pathname: '/machine/[id]/task/[job]/diff', params: { id: m.id, job: String(job.id), file: f.path, status: f.status } })
            }
          />
        )
      })}
    </Group>
  )
}
