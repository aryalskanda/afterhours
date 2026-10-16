// New task: pick the machine and the folder, write the prompt, choose how it runs. It starts from
// what you chose last time on that machine, and offers only what the machine allows. Also how a
// queued task moves to another machine (`move`: queued there, then taken off the first).

import type { Effort, ExecMode, FileEntry, SlashCommand } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Platform, View } from 'react-native'
import { chatCache, hub, useHub, useNow } from '../src/app-state'
import { Block, Button, EmptyState, FieldRow, Group, GroupAction, HStack, LoadingRows, Note, Page, Row, Segmented, SwitchRow, TextArea, Txt } from '../src/components/ui'
import { basename, clock, effortLabel, minutes, modelLabel, nextAt, oneLine, parseTimeOfDay, shortPath, timeOfDay } from '../src/lib/format'
import type { Choices } from '../src/lib/hub'
import { fileSize, MAX_ATTACHMENT_BYTES, pickFiles, pickPhotos, type Picked } from '../src/lib/attach'
import { FilesResult, FolderList, Queued, SlashCommandList, UNREADABLE, Uploaded, type FolderHit } from '../src/lib/results'
import { findJob, freeMachine, supports } from '../src/lib/state'
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
  const params = useLocalSearchParams<{ machine?: string; folder?: string; session?: string; title?: string; move?: string }>()
  const { machines, ready } = useHub()
  const { c, wide } = useTheme()
  // Moving a queued task: where it is now, and the task.
  const move = params.move ? /^(.+):(\d+)$/.exec(params.move) : null
  const moveFrom = move ? machines.find(x => x.id === move[1]) : undefined
  const [moving] = useState(() => (moveFrom && move ? findJob(moveFrom, Number(move[2])) : null))
  const usable = machines.filter(m => m.role !== 'viewer' && m.status !== 'refused' && m.id !== moveFrom?.id)
  // The machine you picked, else the one in the link, else one that's online. Worked out on every
  // render: the machines may load after this screen opens (from a link, or a reload).
  const [picked, setPicked] = useState<string | null>(params.machine || null)
  const machineId = picked && usable.some(m => m.id === picked) ? picked : (usable.find(m => m.status === 'connected') ?? usable[0])?.id
  const m = machines.find(x => x.id === machineId)
  const session = params.session || null
  const chat = session ? chatCache.get(session) : undefined
  const [changed, setChanged] = useState<Choices | null>(
    moving ? { folder: moving.folder, plan: moving.plan, review: moving.review, mode: moving.mode, model: moving.model, effort: moving.effort, isolate: moving.isolate } : null,
  )
  const [touched, setTouched] = useState(Boolean(moving))
  // What you chose here, else what you used last time on this machine (or its defaults).
  const choices = touched && changed ? changed : machineId ? hub.choicesFor(machineId) : null
  const [pickedFolder, setPickedFolder] = useState<string | null | undefined>(params.folder || moving?.folder || undefined)
  const folder = pickedFolder !== undefined ? pickedFolder : machineId ? hub.choicesFor(machineId).folder : null
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FolderHit[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState(moving?.prompt ?? '')
  const [front, setFront] = useState(false)
  // When it starts, and how long it may work.
  const [when, setWhen] = useState<'now' | 'time' | 'reset' | 'after'>('now')
  const [at, setAt] = useState('')
  const [daily, setDaily] = useState(false)
  const [after, setAfter] = useState<number | null>(null)
  const [limit, setLimit] = useState<number | null>(moving?.maxMinutes ?? null)
  const now = useNow(30_000)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; job?: number; group?: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  // Attachments, and what you type as `/` or `@` turned into suggestions.
  const [files, setFiles] = useState<Picked[]>([])
  const [pickError, setPickError] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [commands, setCommands] = useState<{ folder: string; list: SlashCommand[] } | null>(null)
  const [mentions, setMentions] = useState<FileEntry[]>([])
  // The same prompt three ways, each on its own branch, to compare.
  const [threeWays, setThreeWays] = useState(false)
  const [ways, setWays] = useState<'models' | 'same'>('models')
  const [restored, setRestored] = useState(false)
  const { saved } = useHub()

  // What you were writing here last time, until it's queued.
  useEffect(() => {
    if (!machineId || restored || session || moving) return
    setRestored(true)
    const draft = hub.draftFor(machineId)
    if (draft && !prompt) {
      setPrompt(draft.prompt)
      if (pickedFolder === undefined && draft.folder) setPickedFolder(draft.folder)
    }
  }, [machineId, restored, session, prompt, pickedFolder])
  useEffect(() => {
    if (!machineId || !restored || session || moving) return
    const timer = setTimeout(() => void hub.saveDraft(machineId, { prompt, folder, at: Date.now() }), 600)
    return () => clearTimeout(timer)
  }, [machineId, restored, session, prompt, folder])

  // The word you're typing: `/name` at the very start, or `@path` anywhere.
  const before = prompt.slice(0, cursor)
  const token = /(?:^|\s)([@/][^\s]*)$/.exec(before)?.[1] ?? null
  const slash = token?.startsWith('/') && before === token ? token.slice(1).toLowerCase() : null
  const mention = token?.startsWith('@') ? token.slice(1) : null
  const mFeatures = machines.find(x => x.id === machineId)?.features ?? []
  const canMention = mFeatures.includes('files') && machines.find(x => x.id === machineId)?.role !== 'viewer'

  useEffect(() => {
    if (slash === null || !machineId || !folder || !mFeatures.includes('commands') || commands?.folder === folder) return
    void hub.request(machineId, { type: 'commands', folder }, { timeoutMs: 10_000 }).then(r => {
      const parsed = r.ok ? SlashCommandList.safeParse(r.data) : null
      setCommands({ folder, list: parsed?.success ? parsed.data.commands : [] })
    })
  }, [slash, machineId, folder, commands?.folder, mFeatures])

  useEffect(() => {
    if (mention === null || !machineId || !folder || !canMention) {
      setMentions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const r = await hub.request(machineId, { type: 'files', folder, query: mention || '.' }, { timeoutMs: 10_000 })
      const parsed = r.ok ? FilesResult.safeParse(r.data) : null
      if (!cancelled) setMentions(parsed?.success ? (parsed.data.entries ?? []).slice(0, 6) : [])
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mention, machineId, folder, canMention])

  /** Puts `text` where the word being typed is, and a space after it. */
  const complete = (text: string) => {
    if (!token) return
    const start = cursor - token.length
    const next = `${prompt.slice(0, start)}${text} ${prompt.slice(cursor)}`
    setPrompt(next)
    setCursor(start + text.length + 1)
  }

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
        {moveFrom ? (
          <EmptyState title="No other machine" text="This device can only queue tasks on the machine the task is on." />
        ) : (
          <EmptyState
            title={machines.length === 0 ? 'No machines yet' : 'No machine takes tasks from this device'}
            text={machines.length === 0 ? 'Pair a machine first.' : 'It’s a viewer on every machine it’s paired with. An owner can pair it again as an operator.'}
          />
        )}
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
  const online = m.status === 'connected'
  // A moved task goes straight to a machine that's online: it leaves the first one at once.
  const canQueue = Boolean(folder && prompt.trim()) && !sending && whenReady && (!moving || online)
  const variants = threeWays && !session && !moving ? (ways === 'models' && models.length >= 3 ? models.slice(0, 3) : [choices.model, choices.model, choices.model]) : [choices.model]
  const suggestions =
    slash !== null
      ? (commands?.list ?? []).filter(x => x.name.toLowerCase().includes(slash)).slice(0, 6)
      : []
  const recent = [...new Set(m.recent.map(j => j.prompt.trim()))].filter(p => p && !saved.includes(p)).slice(0, 5)

  const submit = async () => {
    if (!folder || sending) return
    if (moving && moveFrom && findJob(moveFrom, moving.id)?.status !== 'queued') {
      setOutcome({ ok: false, text: `#${moving.id} isn’t waiting on ${moveFrom.name} any more.` })
      return
    }
    setSending(true)
    try {
      const group = variants.length > 1 ? `try-${Date.now().toString(36)}` : undefined
      const options = (model: string) => ({
        plan: choices.plan,
        review: choices.review,
        mode,
        model,
        effort: choices.effort,
        ...(session ? { session } : { isolate: group ? true : choices.isolate }),
        front,
        ...(whenNow === 'time' && atMinutes !== null ? (daily ? { repeatDaily: atMinutes } : { notBefore: nextAt(atMinutes, Date.now()) }) : {}),
        ...(whenNow === 'reset' ? { atReset: true } : {}),
        ...(whenNow === 'after' && after !== null ? { afterJob: after } : {}),
        ...(limit ? { maxMinutes: limit } : {}),
        ...(group ? { group } : {}),
      })
      // Offline: it waits on this device and goes out when the machine is back.
      if (!online) {
        if (files.length > 0) {
          setOutcome({ ok: false, text: `Attachments need ${m.name} online.` })
          return
        }
        for (const model of variants) await hub.queueLater(m.id, { type: 'queue', folder, prompt: prompt.trim(), options: options(model) })
        await hub.saveDraft(m.id, null)
        setOutcome({ ok: true, text: `It goes to ${m.name} when it’s back.` })
        return
      }
      const attachments: string[] = []
      for (const [i, f] of files.entries()) {
        setProgress(`Uploading ${files.length > 1 ? `${i + 1} of ${files.length}` : f.name}…`)
        const up = await hub.request(m.id, { type: 'upload', name: f.name, data: f.base64 }, { timeoutMs: 120_000 })
        const parsed = up.ok ? Uploaded.safeParse(up.data) : null
        if (!parsed?.success) {
          setOutcome({ ok: false, text: up.error ?? `${f.name} didn’t upload.` })
          return
        }
        attachments.push(parsed.data.path)
      }
      setProgress(null)
      const ids: number[] = []
      for (const model of variants) {
        const r = await hub.request(m.id, { type: 'queue', folder, prompt: prompt.trim(), options: { ...options(model), ...(attachments.length ? { attachments } : {}) } })
        if (!r.ok) {
          setOutcome({ ok: false, text: r.error ?? 'It didn’t go through.' })
          return
        }
        const queued = Queued.safeParse(r.data)
        if (queued.success) ids.push(queued.data.job.id)
      }
      if (moving && moveFrom) {
        const gone = await hub.request(moveFrom.id, { type: 'job', action: 'remove', job: moving.id })
        setOutcome({
          ok: true,
          text: gone.ok ? `Moved to ${m.name} as #${ids[0]}.` : `Queued #${ids[0]} on ${m.name}, but #${moving.id} is still on ${moveFrom.name}: ${gone.error ?? 'it didn’t answer'}.`,
          job: ids[0],
        })
        return
      }
      await hub.rememberChoices(m.id, { ...choices, mode, folder: session ? choices.folder : folder })
      await hub.saveDraft(m.id, null)
      const text = ids.length > 1 ? `Queued ${ids.slice(0, -1).map(id => `#${id}`).join(', ')} and #${ids.at(-1)} to compare.` : `Queued #${ids[0]}.`
      setOutcome({ ok: true, text, job: ids.length === 1 ? ids[0] : undefined, group })
    } finally {
      setSending(false)
      setProgress(null)
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
          {outcome.group ? (
            <Button
              flex
              title="Compare"
              testID="new-compare"
              onPress={() => {
                if (router.canGoBack()) router.back()
                router.push({ pathname: '/machine/[id]/compare', params: { id: m.id, group: outcome.group! } })
              }}
            />
          ) : null}
          <Button flex kind="tinted" title="Done" onPress={() => router.back()} testID="new-close" />
        </HStack>
      </Page>
    )
  }

  const typedPath = /^[~/]/.test(query.trim()) ? query.trim() : null
  const free = freeMachine(usable, now)
  const pickMachine = (id: string) => {
    setPicked(id)
    setHits(null)
    setQuery('')
    // A task being moved keeps its own folder and choices.
    if (moving) return
    setTouched(false)
    setChanged(null)
    if (!session) setPickedFolder(undefined)
  }
  const check = <Ionicons name="checkmark" size={wide ? 15 : 19} color={c.accent} />
  return (
    <Page sheet testID="new">
      {/* Phones: Queue in the header. A wide window: at the end of the form, like a dialog's button. */}
      <Stack.Screen
        options={{
          title: moving ? 'Move task' : 'New task',
          headerLeft: cancel,
          headerRight: wide ? undefined : () => <HeaderButton title={moving ? 'Move' : 'Queue'} bold disabled={!canQueue} onPress={() => void submit()} testID="new-submit" />,
        }}
      />
      {usable.length > 1 || moving ? (
        <Group header={moving ? `Move #${moving.id} from ${moveFrom?.name} to` : 'Machine'} footer={free === null && usable.length > 1 ? 'None is free right now: all are busy, offline or waiting for a limit.' : undefined}>
          {usable.map(x => (
            <Row
              key={x.id}
              testID={`new-machine-${x.name}`}
              title={x.name}
              value={x.status === 'connected' ? undefined : 'offline'}
              trailing={x.id === m.id ? check : <View style={{ width: wide ? 15 : 19 }} />}
              onPress={() => pickMachine(x.id)}
            />
          ))}
          {usable.length > 1 && free ? (
            <Row title="Any free machine" subtitle="The one with the least to do and the most limit left" tone="accent" onPress={() => pickMachine(free.id)} testID="new-machine-free" />
          ) : null}
        </Group>
      ) : null}
      {m.status !== 'connected' ? <Note text={moving ? `${m.name} is offline. Pick a machine that’s online to move it to.` : `${m.name} is offline. The task waits on this device and goes out when it’s back.`} /> : null}

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

      <Group
        header="Prompt"
        right={prompt.trim() && !saved.includes(prompt.trim()) ? <GroupAction title="Save" onPress={() => hub.savePrompt(prompt)} testID="new-save-prompt" /> : undefined}
        footer={supports(m, 'commands') || canMention ? 'Type / for the project’s commands and skills, @ for a file.' : undefined}
      >
        <TextArea
          placeholder="What should Claude do?"
          value={prompt}
          onChangeText={setPrompt}
          onSelectionChange={e => setCursor(e.nativeEvent.selection.start)}
          minHeight={140}
          testID="new-prompt"
        />
        {suggestions.map(s => (
          <Row key={s.name} title={`/${s.name}`} subtitle={s.description || (s.kind === 'skill' ? 'A skill' : 'A command')} value={s.scope === 'user' ? 'Yours' : undefined} onPress={() => complete(`/${s.name}`)} testID={`suggest-/${s.name}`} />
        ))}
        {mention !== null
          ? mentions.map(f => <Row key={f.path} title={<Txt mono v="subhead">{f.path}</Txt>} onPress={() => complete(`@${f.path}`)} testID={`suggest-@${f.path}`} />)
          : null}
      </Group>

      {!prompt.trim() && (saved.length > 0 || recent.length > 0) ? (
        <Group header="Saved and recent" testID="new-prompts">
          {saved.slice(0, 5).map(p => (
            <Row
              key={`s:${p}`}
              title={p}
              titleLines={2}
              onPress={() => setPrompt(p)}
              trailing={<Button small kind="plain" title="Remove" onPress={() => hub.removeSaved(p)} />}
              testID={`saved-${saved.indexOf(p)}`}
            />
          ))}
          {recent.map((p, i) => (
            <Row key={`r:${p}`} title={<Txt tone="soft">{p}</Txt>} titleLines={2} onPress={() => setPrompt(p)} testID={`recent-${i}`} />
          ))}
        </Group>
      ) : null}

      {supports(m, 'attachments') ? (
        <Group header="Attachments" footer={files.length > 0 ? 'Claude is told to read them. They stay on the machine for two weeks.' : undefined} testID="new-attachments">
          {files.map((f, i) => (
            <Row
              key={`${f.name}-${i}`}
              title={f.name}
              value={fileSize(f.size)}
              trailing={<Button small kind="plain" title="Remove" onPress={() => setFiles(list => list.filter((_, k) => k !== i))} testID={`attachment-remove-${i}`} />}
            />
          ))}
          <Block>
            <HStack>
              <Button
                small
                kind="gray"
                title="Photo"
                testID="attach-photo"
                onPress={async () => {
                  setPickError(null)
                  const picked = await pickPhotos().catch(err => (setPickError(String(err?.message ?? err)), []))
                  const ok = picked.filter(f => f.size <= MAX_ATTACHMENT_BYTES)
                  if (ok.length < picked.length) setPickError('Over 5 MB: left out.')
                  setFiles(list => [...list, ...ok].slice(0, 10))
                }}
              />
              <Button
                small
                kind="gray"
                title="File"
                testID="attach-file"
                onPress={async () => {
                  setPickError(null)
                  const picked = await pickFiles().catch(err => (setPickError(String(err?.message ?? err)), []))
                  const ok = picked.filter(f => f.size <= MAX_ATTACHMENT_BYTES)
                  if (ok.length < picked.length) setPickError('Over 5 MB: left out.')
                  setFiles(list => [...list, ...ok].slice(0, 10))
                }}
              />
            </HStack>
          </Block>
        </Group>
      ) : null}
      {pickError ? <Note ok={false} text={pickError} /> : null}

      <Group header="Plan" footer={HOW.find(h => h.value === how)?.hint}>
        <Block>
          <Segmented options={HOW} value={how} onChange={v => change(withHow({ ...choices, mode }, v))} label="Plan" testID="new-how" />
        </Block>
      </Group>

      {how !== 'ask' ? (
        <Group header="Permissions" footer={`${MODES.find(x => x.value === mode)?.hint ?? ''}${allowBypass ? '' : ` ${m.name} doesn’t allow No prompts from apps.`}`}>
          <Block>
            <Segmented options={allowBypass ? MODES : MODES.filter(x => x.value !== 'bypassPermissions')} value={mode} onChange={v => change({ ...choices, mode: v })} label="Permissions" testID="new-mode" />
          </Block>
        </Group>
      ) : null}

      <Group header="Model and effort">
        <Block>
          <Segmented options={models.map(x => ({ value: x, label: modelLabel(x) }))} value={choices.model} onChange={v => change({ ...choices, model: v })} label="Model" testID="new-model" />
          <Segmented options={EFFORTS.map(x => ({ value: x, label: effortLabel(x) }))} value={choices.effort} onChange={v => change({ ...choices, effort: v })} label="Effort" testID="new-effort" />
        </Block>
      </Group>

      <Group>
        {!session ? <SwitchRow title="Own git branch" subtitle="For a new conversation, in a git folder" value={choices.isolate} onChange={v => change({ ...choices, isolate: v })} /> : null}
        <SwitchRow title="Run next" value={front} onChange={setFront} />
        {!session && !moving && supports(m, 'group') ? (
          <SwitchRow title="Try it three ways" subtitle="Three tasks, each on its own branch, to compare" value={threeWays} onChange={setThreeWays} testID="new-three" />
        ) : null}
        {threeWays && !session ? (
          <Block>
            <Segmented
              options={[
                { value: 'models' as const, label: models.length >= 3 ? models.slice(0, 3).map(modelLabel).join(', ') : 'Three models' },
                { value: 'same' as const, label: `${modelLabel(choices.model)} three times` },
              ]}
              value={ways}
              onChange={setWays}
              label="Three ways"
              testID="new-ways"
            />
          </Block>
        ) : null}
      </Group>

      {supports(m, 'schedule') ? (
        <Group header="Start" footer={whenFooter} testID="new-start">
          <Block>
            <Segmented options={whenOptions} value={whenNow} onChange={setWhen} label="When it starts" testID="new-when" />
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
              label="Time limit"
              testID="new-limit"
            />
          </Block>
        </Group>
      ) : null}

      {progress ? <Note text={progress} /> : null}
      {outcome && !outcome.ok ? <Note ok={false} text={outcome.text} /> : null}
      {wide ? (
        <HStack style={{ justifyContent: 'flex-end' }}>
          <Button title={moving ? 'Move' : 'Queue'} disabled={!canQueue} onPress={submit} testID="new-submit" />
        </HStack>
      ) : null}
    </Page>
  )
}
