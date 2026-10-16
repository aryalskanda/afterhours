// New task: pick the machine and the folder, write the prompt, choose how it runs. It starts from
// what you chose last time on that machine, and offers only what the machine allows.

import type { Effort, ExecMode } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform, View } from 'react-native'
import { chatCache, hub, useHub, useNow } from '../src/app-state'
import { Block, Button, EmptyState, FieldRow, Group, HStack, LoadingRows, Note, Page, Row, Segmented, SwitchRow, TextArea, Txt } from '../src/components/ui'
import { basename, clock, effortLabel, minutes, modelLabel, nextAt, oneLine, parseTimeOfDay, shortPath, timeOfDay } from '../src/lib/format'
import type { Choices } from '../src/lib/hub'
import { FolderList, Queued, UNREADABLE, type FolderHit } from '../src/lib/results'
import { supports } from '../src/lib/state'
import { HeaderButton } from '../src/navigation'
import { useTheme } from '../src/theme'

type How = 'plan' | 'review' | 'none' | 'ask'
const HOW: { value: How; label: string; hint: string }[] = [
  { value: 'plan', label: 'Plan', hint: 'Claude plans first, the plan is approved for you, then it works.' },
  { value: 'review', label: 'Review', hint: 'Claude plans first and waits for you to approve the plan.' },
  { value: 'none', label: 'No plan', hint: 'Claude starts on the work right away.' },
  { value: 'ask', label: 'Ask', hint: 'Claude only reads and answers. It changes nothing.' },
]
const MODES: { value: ExecMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Safe steps go ahead; anything risky asks you first.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go ahead; everything else asks you first.' },
  { value: 'bypassPermissions', label: 'No prompts', hint: 'Nothing asks first.' },
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
  const { c, wide } = useTheme()
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
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FolderHit[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [front, setFront] = useState(false)
  // When it starts, and how long it may work.
  const [when, setWhen] = useState<'now' | 'time' | 'reset' | 'after'>('now')
  const [at, setAt] = useState('')
  const [daily, setDaily] = useState(false)
  const [after, setAfter] = useState<number | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const now = useNow(30_000)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; job?: number } | null>(null)
  const [sending, setSending] = useState(false)

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

  const cancel = Platform.OS === 'web' ? undefined : () => <HeaderButton title="Cancel" onPress={() => router.back()} />

  if (!ready) return <Page sheet>{null}</Page>
  if (usable.length === 0 || !m || !choices) {
    return (
      <Page sheet>
        <Stack.Screen options={{ headerLeft: cancel }} />
        <EmptyState
          title={machines.length === 0 ? 'No machines yet' : 'No machine takes tasks from this device'}
          text={machines.length === 0 ? 'Pair a machine first.' : 'It’s a viewer on every machine it’s paired with. An owner can pair it again as an operator.'}
        />
      </Page>
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
  const atMinutes = parseTimeOfDay(at)
  const resetsAt = m.limits.fiveHour?.resetsAt && m.limits.fiveHour.resetsAt > now ? m.limits.fiveHour.resetsAt : null
  const waitable = [...(m.active ? [m.active] : []), ...m.queued]
  const whenOptions = [
    { value: 'now' as const, label: 'Now' },
    { value: 'time' as const, label: 'Later' },
    ...(resetsAt ? [{ value: 'reset' as const, label: 'At reset' }] : []),
    ...(waitable.length > 0 ? [{ value: 'after' as const, label: 'After' }] : []),
  ]
  const whenNow = whenOptions.some(o => o.value === when) ? when : 'now'
  const whenFooter =
    whenNow === 'time'
      ? atMinutes === null
        ? 'Type a time, like 2:30 am.'
        : daily
          ? `Every day at ${timeOfDay(atMinutes)}, on ${m.name}’s clock.`
          : `At ${clock(nextAt(atMinutes, now), now)}.`
      : whenNow === 'reset' && resetsAt
        ? `At ${clock(resetsAt, now)}, when the 5-hour limit resets.`
        : whenNow === 'after'
          ? 'When that task has finished well. If it fails, this one doesn’t run.'
          : undefined
  const whenReady = whenNow === 'now' || whenNow === 'reset' || (whenNow === 'time' && atMinutes !== null) || (whenNow === 'after' && after !== null)
  const canQueue = Boolean(folder && prompt.trim()) && !sending && whenReady

  const submit = async () => {
    if (!folder || sending) return
    setSending(true)
    try {
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
          ...(whenNow === 'time' && atMinutes !== null ? (daily ? { repeatDaily: atMinutes } : { notBefore: nextAt(atMinutes, Date.now()) }) : {}),
          ...(whenNow === 'reset' ? { atReset: true } : {}),
          ...(whenNow === 'after' && after !== null ? { afterJob: after } : {}),
          ...(limit ? { maxMinutes: limit } : {}),
        },
      })
      if (!r.ok) {
        setOutcome({ ok: false, text: r.error ?? 'It didn’t go through.' })
        return
      }
      const queued = Queued.safeParse(r.data)
      await hub.rememberChoices(m.id, { ...choices, mode, folder: session ? choices.folder : folder })
      setOutcome({ ok: true, text: r.text ?? 'Queued.', job: queued.success ? queued.data.job.id : undefined })
    } finally {
      setSending(false)
    }
  }

  if (outcome?.ok) {
    const job = outcome.job
    return (
      <Page sheet testID="new-done">
        <Stack.Screen options={{ headerLeft: undefined, headerRight: undefined }} />
        <Group footer={`${m.name} starts it when it gets to it${front ? ', next' : ''}. Anything it asks shows up in Needs you.`}>
          <Block>
            <Txt v="headline">{outcome.text}</Txt>
          </Block>
        </Group>
        <HStack>
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
          <Button flex kind="tinted" title="Done" onPress={() => router.back()} testID="new-close" />
        </HStack>
      </Page>
    )
  }

  const typedPath = /^[~/]/.test(query.trim()) ? query.trim() : null
  const check = <Ionicons name="checkmark" size={wide ? 15 : 19} color={c.accent} />
  return (
    <Page sheet testID="new">
      {/* Phones: Queue in the header. A wide window: at the end of the form, like a dialog's button. */}
      <Stack.Screen options={{ headerLeft: cancel, headerRight: wide ? undefined : () => <HeaderButton title="Queue" bold disabled={!canQueue} onPress={() => void submit()} testID="new-submit" /> }} />
      {usable.length > 1 ? (
        <Group header="Machine">
          {usable.map(x => (
            <Row
              key={x.id}
              testID={`new-machine-${x.name}`}
              title={x.name}
              value={x.status === 'connected' ? undefined : 'offline'}
              trailing={x.id === m.id ? check : <View style={{ width: wide ? 15 : 19 }} />}
              onPress={() => {
                setPicked(x.id)
                setTouched(false)
                setChanged(null)
                if (!session) setPickedFolder(undefined)
                setHits(null)
                setQuery('')
              }}
            />
          ))}
        </Group>
      ) : null}
      {m.status !== 'connected' ? <Note text={`${m.name} is offline. The task is sent when it’s back.`} /> : null}

      <Group header="Folder" footer={!session && !folder && policy ? `${m.name} lets apps use ${policy.allowedRoots.map(r => shortPath(r, 40)).join(', ')}.` : undefined}>
        {session ? (
          <Row title={chat || params.title ? `“${chat?.title ?? params.title}”` : 'The same conversation'} subtitle={params.folder ? shortPath(params.folder, 60) : undefined} />
        ) : folder ? (
          <Row
            title={basename(folder)}
            subtitle={shortPath(folder, 60)}
            trailing={<Button small kind="plain" title="Change" onPress={() => setPickedFolder(null)} testID="folder-change" />}
          />
        ) : (
          [
            <FieldRow key="search" placeholder="Search, or type a path" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} testID="folder-search" />,
            typedPath ? <Row key="typed" testID={`folder-Use ${basename(typedPath)}`} title={`Use ${typedPath}`} tone="accent" onPress={() => setPickedFolder(typedPath)} /> : null,
            ...(hits ?? []).map(h => (
              <Row key={h.path} testID={`folder-${h.name}`} title={h.name} subtitle={shortPath(h.path, 60)} value={h.isRepo ? 'git' : undefined} onPress={() => setPickedFolder(h.path)} />
            )),
            hits !== null && hits.length === 0 ? <Row key="none" title={<Txt tone="soft">{searchError ?? (query.trim() ? 'No folder matches.' : 'No recent folders. Type to search.')}</Txt>} /> : null,
          ]
        )}
      </Group>
      {!session && !folder && hits === null ? <LoadingRows count={2} /> : null}

      <Group header="Prompt">
        <TextArea placeholder="What should Claude do?" value={prompt} onChangeText={setPrompt} minHeight={140} testID="new-prompt" />
      </Group>

      <Group header="Plan" footer={HOW.find(h => h.value === how)?.hint}>
        <Block>
          <Segmented options={HOW} value={how} onChange={v => change(withHow({ ...choices, mode }, v))} testID="new-how" />
        </Block>
      </Group>

      {how !== 'ask' ? (
        <Group header="Permissions" footer={`${MODES.find(x => x.value === mode)?.hint ?? ''}${allowBypass ? '' : ` ${m.name} doesn’t allow No prompts from apps.`}`}>
          <Block>
            <Segmented options={allowBypass ? MODES : MODES.filter(x => x.value !== 'bypassPermissions')} value={mode} onChange={v => change({ ...choices, mode: v })} testID="new-mode" />
          </Block>
        </Group>
      ) : null}

      <Group header="Model and effort">
        <Block>
          <Segmented options={models.map(x => ({ value: x, label: modelLabel(x) }))} value={choices.model} onChange={v => change({ ...choices, model: v })} testID="new-model" />
          <Segmented options={EFFORTS.map(x => ({ value: x, label: effortLabel(x) }))} value={choices.effort} onChange={v => change({ ...choices, effort: v })} testID="new-effort" />
        </Block>
      </Group>

      <Group>
        {!session ? <SwitchRow title="Own git branch" subtitle="For a new conversation, in a git folder" value={choices.isolate} onChange={v => change({ ...choices, isolate: v })} /> : null}
        <SwitchRow title="Run next" value={front} onChange={setFront} />
      </Group>

      {supports(m, 'schedule') ? (
        <Group header="Start" footer={whenFooter} testID="new-start">
          <Block>
            <Segmented options={whenOptions} value={whenNow} onChange={setWhen} testID="new-when" />
          </Block>
          {whenNow === 'time' ? <FieldRow label="At" placeholder="2:30 am" value={at} onChangeText={setAt} autoCapitalize="none" autoCorrect={false} testID="new-at" /> : null}
          {whenNow === 'time' ? <SwitchRow title="Every day" value={daily} onChange={setDaily} testID="new-daily" /> : null}
          {whenNow === 'after'
            ? waitable.map(j => (
                <Row
                  key={j.id}
                  title={`#${j.id} ${oneLine(j.prompt, 70)}`}
                  titleLines={2}
                  trailing={after === j.id ? check : <View style={{ width: wide ? 15 : 19 }} />}
                  onPress={() => setAfter(j.id)}
                  testID={`new-after-${j.id}`}
                />
              ))
            : null}
        </Group>
      ) : null}

      {supports(m, 'budget') ? (
        <Group header="Time limit" footer={limit ? `Stopped after ${minutes(limit)} of work; you can let it go on.` : undefined}>
          <Block>
            <Segmented
              options={[
                { value: '0', label: 'None' },
                { value: '15', label: '15 min' },
                { value: '30', label: '30 min' },
                { value: '60', label: '1 h' },
                { value: '120', label: '2 h' },
              ]}
              value={String(limit ?? 0)}
              onChange={v => setLimit(Number(v) || null)}
              testID="new-limit"
            />
          </Block>
        </Group>
      ) : null}

      {outcome && !outcome.ok ? <Note ok={false} text={outcome.text} /> : null}
      {wide ? (
        <HStack style={{ justifyContent: 'flex-end' }}>
          <Button title="Queue" disabled={!canQueue} onPress={submit} testID="new-submit" />
        </HStack>
      ) : null}
    </Page>
  )
}
