// New task: pick the machine and the folder, write the prompt, choose how it runs. It starts from
// what you chose last time on that machine, and shows what the machine itself allows.

import type { Effort, ExecMode } from '@afterhours/protocol'
import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { chatCache, hub, useHub } from '../src/app-state'
import { Button, Card, Choice, Empty, Field, Label, Outcome, Pill, Row, Screen, Section, Soft, Spinner, Title, Toggle } from '../src/components/ui'
import { basename, shortPath } from '../src/lib/format'
import type { Choices } from '../src/lib/hub'
import { FolderList, Queued, UNREADABLE, type FolderHit } from '../src/lib/results'
import { radius, space, useColors } from '../src/theme'

type How = 'plan' | 'review' | 'none' | 'ask'
const HOW: { value: How; label: string; hint: string }[] = [
  { value: 'plan', label: 'Plan, then do it', hint: 'Claude plans first; the plan is approved for you, then it works.' },
  { value: 'review', label: 'Plan, I approve', hint: 'Claude plans first and waits for your OK, in Needs you.' },
  { value: 'none', label: 'Just do it', hint: 'Claude starts working right away.' },
  { value: 'ask', label: 'Only answer', hint: 'Claude reads and answers; it changes nothing.' },
]
const MODES: { value: ExecMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Claude Code goes ahead with what’s safe and asks you about the rest.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits go ahead; anything else asks you first.' },
  { value: 'bypassPermissions', label: 'Skip prompts', hint: 'Nothing asks first. Use it in folders you can afford to lose.' },
]
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const howOf = (c: Choices): How => (c.mode === 'plan' ? 'ask' : !c.plan ? 'none' : c.review ? 'review' : 'plan')

function withHow(c: Choices, how: How): Choices {
  const mode = c.mode === 'plan' ? 'auto' : c.mode
  switch (how) {
    case 'plan':
      return { ...c, plan: true, review: false, mode }
    case 'review':
      return { ...c, plan: true, review: true, mode }
    case 'none':
      return { ...c, plan: false, review: false, mode }
    case 'ask':
      return { ...c, plan: false, review: false, mode: 'plan' }
  }
}

export default function NewTask() {
  const params = useLocalSearchParams<{ machine?: string; folder?: string; session?: string; title?: string }>()
  const { machines, ready } = useHub()
  const c = useColors()
  const usable = machines.filter(m => m.role !== 'viewer' && m.status !== 'refused')
  // The machine you picked, else the one in the link, else one that's online. Worked out on every
  // render: the machines may load after this screen opens (from a link, or a reload).
  const [picked, setPicked] = useState<string | null>(params.machine || null)
  const machineId = picked && usable.some(m => m.id === picked) ? picked : (usable.find(m => m.status === 'connected') ?? usable[0])?.id
  const m = machines.find(x => x.id === machineId)
  const session = params.session || null
  const chat = session ? chatCache.get(session) : undefined
  const [changed, setChanged] = useState<Choices | null>(null)
  const [touched, setTouched] = useState(false)
  // What you chose here, else what you used last time on this machine (or its defaults).
  const choices = touched && changed ? changed : machineId ? hub.choicesFor(machineId) : null
  const [pickedFolder, setPickedFolder] = useState<string | null | undefined>(params.folder || undefined)
  const folder = pickedFolder !== undefined ? pickedFolder : machineId ? hub.choicesFor(machineId).folder : null
  const setFolder = (f: string | null) => setPickedFolder(f)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FolderHit[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [front, setFront] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; job?: number } | null>(null)

  // Folders: the recent ones, or what matches what you type.
  useEffect(() => {
    if (!machineId || session || folder) return
    let cancelled = false
    const timer = setTimeout(
      async () => {
        const r = await hub.request(machineId, { type: 'folders', query: query.trim() }, { timeoutMs: 10_000 })
        if (cancelled) return
        if (!r.ok) {
          setSearchError(r.error ?? 'Couldn’t search the folders.')
          setHits([])
          return
        }
        const parsed = FolderList.safeParse(r.data)
        setSearchError(parsed.success ? null : UNREADABLE)
        setHits(parsed.success ? parsed.data : [])
      },
      query ? 300 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [machineId, query, session, folder, m?.status])

  if (!ready) return <Screen>{null}</Screen>
  if (usable.length === 0 || !m || !choices) {
    return (
      <Screen>
        <Empty
          title={machines.length === 0 ? 'No machines yet' : 'No machine takes tasks from this device'}
          text={machines.length === 0 ? 'Pair a machine first.' : 'This device is a viewer on every machine it’s paired with. An owner can pair it again as an operator.'}
        />
      </Screen>
    )
  }

  const policy = m.policy
  const allowBypass = policy?.allowBypass ?? false
  const mode = choices.mode === 'bypassPermissions' && !allowBypass ? 'auto' : choices.mode
  const how = howOf({ ...choices, mode })
  const models = [...new Set([...(m.models.length ? m.models : ['opus', 'sonnet', 'haiku']), choices.model])]
  const change = (next: Choices) => {
    setTouched(true)
    setChanged(next)
  }

  if (outcome?.ok) {
    const job = outcome.job
    return (
      <Screen testID="new-done">
        <Card accent>
          <Title>{outcome.text}</Title>
          <Soft>
            {m.name} starts it when it gets to it{front ? ': it’s next' : ''}. Anything it asks shows up in Needs you.
          </Soft>
          <Row>
            {job ? (
              <Button
                flex
                title={`Open #${job}`}
                testID="new-open"
                onPress={() => {
                  if (router.canGoBack()) router.back()
                  router.push({ pathname: '/machine/[id]/task/[job]', params: { id: m.id, job: String(job) } })
                }}
              />
            ) : null}
            <Button flex kind="secondary" title="Done" onPress={() => router.back()} testID="new-close" />
          </Row>
        </Card>
      </Screen>
    )
  }

  const submit = async () => {
    if (!folder) return
    const r = await hub.request(m.id, {
      type: 'queue',
      folder,
      prompt: prompt.trim(),
      options: {
        plan: choices.plan,
        review: choices.review,
        mode,
        model: choices.model,
        effort: choices.effort,
        ...(session ? { session } : { isolate: choices.isolate }),
        front,
      },
    })
    if (!r.ok) {
      setOutcome({ ok: false, text: r.error ?? 'It didn’t go through.' })
      return
    }
    const queued = Queued.safeParse(r.data)
    await hub.rememberChoices(m.id, { ...choices, mode, folder: session ? choices.folder : folder })
    setOutcome({ ok: true, text: r.text ?? 'Queued.', job: queued.success ? queued.data.job.id : undefined })
  }

  const typedPath = /^[~/]/.test(query.trim()) ? query.trim() : null
  return (
    <Screen testID="new">
      {usable.length > 1 ? (
        <Section title="Machine">
          <Choice
            options={usable.map(x => ({ value: x.id, label: x.status === 'connected' ? x.name : `${x.name} (offline)` }))}
            value={m.id}
            onChange={id => {
              setPicked(id)
              setTouched(false)
              setChanged(null)
              if (!session) setPickedFolder(undefined)
              setHits(null)
              setQuery('')
            }}
            testID="new-machine"
          />
        </Section>
      ) : null}
      {m.status !== 'connected' ? <Soft>{m.name} is offline: the task is sent when it’s back.</Soft> : null}

      <Section title="Folder">
        {session ? (
          <Card>
            <Label>Continues {chat || params.title ? `“${chat?.title ?? params.title}”` : 'a conversation'}</Label>
            <Soft>{params.folder ? shortPath(params.folder, 60) : 'in its own folder'}</Soft>
          </Card>
        ) : folder ? (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Label style={{ fontWeight: '600' }}>{basename(folder)}</Label>
                <Soft numberOfLines={1}>{shortPath(folder, 60)}</Soft>
              </View>
              <Button small kind="secondary" title="Change" onPress={() => setFolder(null)} testID="folder-change" />
            </Row>
          </Card>
        ) : (
          <Card>
            <Field placeholder="Search the machine’s folders, or type a path" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} testID="folder-search" />
            {typedPath ? (
              <FolderRow name={`Use ${basename(typedPath)}`} path={typedPath} onPress={() => setFolder(typedPath)} />
            ) : null}
            {hits === null ? (
              <Spinner />
            ) : hits.length === 0 ? (
              <Soft>{searchError ?? (query.trim() ? 'No folder matches.' : 'No recent folders. Type to search.')}</Soft>
            ) : (
              <>
                <Soft>{query.trim() ? 'Matches' : 'Recent'}</Soft>
                {hits.map(h => (
                  <FolderRow key={h.path} name={h.name} path={h.path} repo={h.isRepo} onPress={() => setFolder(h.path)} />
                ))}
              </>
            )}
            {policy ? <Soft>Apps may use: {policy.allowedRoots.map(r => shortPath(r, 40)).join(', ')}</Soft> : null}
          </Card>
        )}
      </Section>

      <Section title="Prompt">
        <Field placeholder="What should Claude do?" value={prompt} onChangeText={setPrompt} multiline testID="new-prompt" style={{ minHeight: 140 }} />
      </Section>

      <Section title="How">
        <Card>
          <Choice options={HOW} value={how} onChange={v => change(withHow({ ...choices, mode }, v))} testID="new-how" />
          <Soft>{HOW.find(h => h.value === how)?.hint}</Soft>
          {how !== 'ask' ? (
            <>
              <Choice options={allowBypass ? MODES : MODES.filter(x => x.value !== 'bypassPermissions')} value={mode} onChange={v => change({ ...choices, mode: v })} testID="new-mode" />
              <Soft>{MODES.find(x => x.value === mode)?.hint}</Soft>
              {!allowBypass ? <Soft>{m.name} doesn’t let apps start tasks that skip permission prompts.</Soft> : null}
            </>
          ) : null}
        </Card>
      </Section>

      <Section title="Model">
        <Card>
          <Choice options={models.map(x => ({ value: x, label: x }))} value={choices.model} onChange={v => change({ ...choices, model: v })} testID="new-model" />
          <Choice options={EFFORTS.map(x => ({ value: x, label: x }))} value={choices.effort} onChange={v => change({ ...choices, effort: v })} testID="new-effort" />
          <Soft>Effort: how hard Claude thinks. Higher is slower and uses more of your limits.</Soft>
        </Card>
      </Section>

      <Card>
        {!session ? (
          <Toggle label="Its own git branch" hint="A new conversation works on a branch of its own (in git folders)." value={choices.isolate} onChange={v => change({ ...choices, isolate: v })} />
        ) : null}
        <Toggle label="Run next" hint="Put it at the front of the queue." value={front} onChange={setFront} />
      </Card>

      {outcome && !outcome.ok ? <Outcome ok={false} text={outcome.text} /> : null}
      <Button title="Queue it" disabled={!folder || !prompt.trim()} onPress={submit} testID="new-submit" />
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: c.soft, textAlign: 'center', padding: space.s }}>Cancel</Text>
      </Pressable>
    </Screen>
  )
}

function FolderRow(props: { name: string; path: string; repo?: boolean; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      onPress={props.onPress}
      role="button"
      testID={`folder-${props.name}`}
      style={({ pressed }) => ({ borderWidth: 1, borderColor: c.line, borderRadius: radius.m, padding: space.m, gap: 2, opacity: pressed ? 0.7 : 1 })}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <Label style={{ fontWeight: '600', flex: 1 }} numberOfLines={1}>
          {props.name}
        </Label>
        {props.repo ? <Pill text="git" /> : null}
      </Row>
      <Soft numberOfLines={1}>{shortPath(props.path, 60)}</Soft>
    </Pressable>
  )
}
