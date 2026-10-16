// A project's CLAUDE.md: what Claude reads first in that folder. Pick one of the folders tasks ran
// in (or type one); operators can change it. Only in the folders the machine shares with apps.

import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '../../../../../src/app-state'
import { Block, Button, EmptyState, FieldRow, Group, HStack, LoadingRows, Note, Page, Row, TextArea, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { useLoad } from '../../../../../src/components/useLoad'
import { basename, shortPath } from '../../../../../src/lib/format'
import { ClaudeInfo } from '../../../../../src/lib/results'
import { mono } from '../../../../../src/theme'

/** The engine sends at most this much of a CLAUDE.md: a longer one can't be edited here whole. */
const MAX_TEXT = 200_000

export default function Instructions() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const folders = useMemo(() => {
    if (!m) return []
    const jobs = [...(m.active ? [m.active] : []), ...m.queued, ...m.recent]
    return [...new Set(jobs.map(j => j.folder))].slice(0, 6)
  }, [m])
  const [folder, setFolder] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const picked = folder ?? folders[0] ?? null
  const info = useLoad(id, picked ? { type: 'claude', folder: picked } : null, ClaudeInfo, `claude:${picked}`)
  const memory = info.data?.memory ?? null
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const save = useAction()

  // Another folder: what you were writing for the last one goes.
  const { clear } = save
  useEffect(() => {
    setEditing(false)
    clear()
  }, [picked, clear])

  if (!m) {
    return (
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }
  const canEdit = m.role === 'owner' || m.role === 'operator'
  const tooLong = (memory?.text?.length ?? 0) >= MAX_TEXT

  return (
    <Page testID="instructions">
      <Stack.Screen options={{ title: 'CLAUDE.md' }} />
      <Group header="Folder" footer={folders.length === 0 ? 'Type a folder’s path, or run a task in one first.' : undefined}>
        {folders.map(f => (
          <Row key={f} title={basename(f)} subtitle={shortPath(f, 60)} value={f === picked ? 'Shown' : undefined} onPress={() => setFolder(f)} testID={`instructions-folder-${basename(f)}`} />
        ))}
        <FieldRow placeholder="Another folder: ~/code/app" value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} returnKeyType="go" onSubmitEditing={() => typed.trim() && setFolder(typed.trim())} testID="instructions-path" />
        {typed.trim() ? <Row title={`Show ${shortPath(typed.trim(), 40)}`} tone="accent" onPress={() => setFolder(typed.trim())} /> : null}
      </Group>

      {info.error ? <Note ok={false} text={info.error} /> : null}
      {picked && !info.data && !info.error ? <LoadingRows count={3} /> : null}
      {memory && !editing ? (
        <Group header={shortPath(memory.path, 60)} testID="instructions-text">
          {memory.exists ? (
            <Block>
              <Txt selectable mono v="subhead">
                {memory.text ?? ''}
              </Txt>
            </Block>
          ) : (
            <Row title={<Txt tone="soft">No CLAUDE.md in this folder yet.</Txt>} />
          )}
          {canEdit && !tooLong ? (
            <Row
              title={memory.exists ? 'Edit' : 'Write one'}
              tone="accent"
              onPress={() => {
                setText(memory.text ?? '')
                setEditing(true)
                save.clear()
              }}
              testID="instructions-edit"
            />
          ) : null}
        </Group>
      ) : null}
      {tooLong ? <Note text="Too long to edit here: edit it on the machine." /> : null}
      {memory && editing ? (
        <Group header={shortPath(memory.path, 60)} footer="Tasks that start after you save read it.">
          <TextArea value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} minHeight={260} style={{ fontFamily: mono }} testID="instructions-field" />
          <Block>
            <HStack>
              <Button
                flex
                title="Save"
                onPress={async () => {
                  if (!picked) return
                  const r = await save.run(m.id, { type: 'claude.md', folder: picked, text })
                  if (r.ok) {
                    setEditing(false)
                    info.reload()
                  }
                }}
                testID="instructions-save"
              />
              <Button kind="plain" title="Cancel" onPress={() => setEditing(false)} />
            </HStack>
          </Block>
        </Group>
      ) : null}
      {save.outcome ? <Note ok={save.outcome.ok} text={save.outcome.text} /> : null}
    </Page>
  )
}
