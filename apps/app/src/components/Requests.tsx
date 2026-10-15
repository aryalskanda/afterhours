// What a task asks of you: a permission, questions, a plan to review, a folder to trust. Each one
// answers the machine directly, and goes once the machine says it's settled. If an answer doesn't
// get through, it says why and keeps its buttons, to try again.

import { describeAnswers, type QuestionAnswer } from '@afterhours/protocol'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as LocalAuthentication from 'expo-local-authentication'
import { useState, type ReactNode } from 'react'
import { Platform, Text, View } from 'react-native'
import { hub, useHub, useNow } from '../app-state'
import { basename } from '../lib/format'
import type { Need } from '../lib/state'
import { mono, useTheme } from '../theme'
import { countdown } from './bits'
import { Markdown } from './Markdown'
import { Block, Button, Group, HStack, Note, Row, TextArea, Txt } from './ui'

type Answer = { decision: 'allow' | 'deny' | 'answer'; text?: string | null }

type Props = { need: Need; onAnswered?: (text: string) => void }

function useAnswer({ need, onAnswered }: Props) {
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async (a: Answer): Promise<boolean> => {
    setError(null)
    const r = await hub.request(need.machine.id, { type: 'answer', code: need.approval.code, decision: a.decision, text: a.text ?? null })
    if (!r.ok) {
      setError(r.error ?? 'It didn’t go through.')
      return false
    }
    const text = r.text ?? 'Sent.'
    setDone(text)
    onAnswered?.(text)
    return true
  }
  return { done, error, send }
}

/** What a permission is for, in plain words. */
export function permissionTitle(tool: string | undefined): string {
  switch (tool) {
    case 'Bash':
      return 'Run a command'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'Change a file'
    case 'Read':
      return 'Read a file'
    case 'WebFetch':
      return 'Open a web page'
    case 'WebSearch':
      return 'Search the web'
    default:
      return tool ? `Use ${tool}` : 'Use a tool'
  }
}

/** Where a request comes from: "build-box · #14 · web". */
function From(props: { need: Need; extra?: string | null }) {
  const { machine, approval, job } = props.need
  return (
    <View style={{ gap: 2 }}>
      <Txt v="footnote" tone="soft" lines={1} num>
        {machine.name} ·{' '}
        <Txt v="footnote" tone="soft" mono>
          #{approval.job}
        </Txt>
        {job ? ` · ${basename(job.folder)}` : ''}
        {props.extra ? ` · ${props.extra}` : ''}
      </Txt>
      {machine.status !== 'connected' ? (
        <Txt v="footnote" tone="danger">
          Offline: an answer may not get through.
        </Txt>
      ) : null}
    </View>
  )
}

function Code(props: { text: string }) {
  const { c, t, wide } = useTheme()
  return (
    <View style={{ backgroundColor: c.fill, borderRadius: wide ? 6 : 8, paddingHorizontal: 10, paddingVertical: 8 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: t.subhead.fontSize, lineHeight: t.subhead.lineHeight, color: c.ink }}>
        {props.text}
      </Text>
    </View>
  )
}

/** The buttons until the machine takes the answer, and why the last try didn't work; then how it went. */
function Answering(props: { done: string | null; error: string | null; children: ReactNode }) {
  if (props.done) {
    return (
      <Block>
        <Txt v="subhead" tone="ok">
          {props.done}
        </Txt>
      </Block>
    )
  }
  return (
    <Block gap={10}>
      {props.children}
      {props.error ? (
        <Txt v="footnote" tone="danger">
          {props.error}
        </Txt>
      ) : null}
    </Block>
  )
}

/** One request, whichever kind. `onAnswered`: the machine took the answer. */
export function RequestCard(props: Props) {
  switch (props.need.approval.kind) {
    case 'permission':
      return <PermissionCard {...props} />
    case 'question':
      return (props.need.approval.questions ?? []).length > 0 ? <QuestionCard {...props} /> : <TypedAnswerCard {...props} />
    case 'review':
      return <ReviewCard {...props} />
    case 'trust':
      return <TrustCard {...props} />
  }
}

function PermissionCard(props: Props) {
  const { need } = props
  const { prefs } = useHub()
  const now = useNow(15_000)
  const { done, error, send } = useAnswer(props)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const a = need.approval
  const allow = async () => {
    if (prefs.confirmAllow && Platform.OS !== 'web' && (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync())) {
      const auth = await LocalAuthentication.authenticateAsync({ promptMessage: `Allow ${a.tool ?? 'this'}?` })
      if (!auth.success) return
    }
    await send({ decision: 'allow' })
  }
  return (
    <Group testID={`request-${a.code}`} footer={done ? undefined : countdown(a.expiresAt, now, 'Denied')}>
      <Block>
        <From need={need} />
        <Txt v="headline">{permissionTitle(a.tool)}</Txt>
        {a.detail ? <Code text={a.detail} /> : null}
      </Block>
      {noting && !done ? <TextArea placeholder="What should Claude do instead? (optional)" value={note} onChangeText={setNote} autoFocus minHeight={80} /> : null}
      <Answering done={done} error={error}>
        {noting ? (
          <HStack>
            <Button flex kind="dangerFilled" title="Deny" onPress={() => send({ decision: 'deny', text: note.trim() || null })} testID={`deny-note-${a.code}`} />
            <Button kind="plain" title="Back" onPress={() => setNoting(false)} />
          </HStack>
        ) : (
          <>
            <HStack>
              <Button flex title="Allow" onPress={allow} testID={`allow-${a.code}`} />
              <Button flex kind="danger" title="Deny" onPress={() => send({ decision: 'deny' })} testID={`deny-${a.code}`} />
            </HStack>
            <Button small kind="plain" title="Deny and tell Claude why" onPress={() => setNoting(true)} />
          </>
        )}
      </Answering>
    </Group>
  )
}

/** Claude's questions, one at a time: every option in full; tick several where it allows; or type an answer. */
function QuestionCard(props: Props) {
  const { need } = props
  const { c, wide } = useTheme()
  const now = useNow(15_000)
  const questions = need.approval.questions ?? []
  const { done, error, send } = useAnswer(props)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<(QuestionAnswer | undefined)[]>([])
  const [ticked, setTicked] = useState<number[]>([])
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const q = questions[Math.min(step, questions.length - 1)]!
  const code = need.approval.code

  const answer = async (a: QuestionAnswer) => {
    const all = [...answers]
    all[step] = a
    setAnswers(all)
    if (step + 1 < questions.length) {
      setTyping(false)
      setTyped('')
      const next = all[step + 1]
      setTicked(next && 'picks' in next ? next.picks : [])
      setStep(step + 1)
      return
    }
    // The last one: send them all. If that fails, this question stays up to try again.
    if (await send({ decision: 'answer', text: describeAnswers(questions, all) })) {
      setTyping(false)
      setTyped('')
    }
  }

  if (done) {
    return (
      <Group testID={`request-${code}`}>
        <Block>
          <From need={need} />
          {questions.map((x, i) => {
            const a = answers[i]
            const said = !a ? 'No answer' : 'text' in a ? `“${a.text}”` : a.picks.map(p => x.options?.[p]?.label ?? '?').join(', ')
            return (
              <View key={i} style={{ gap: 1 }}>
                <Txt v="subhead">{x.question}</Txt>
                <Txt v="subhead" tone="soft">
                  {said}
                </Txt>
              </View>
            )
          })}
          <Txt v="subhead" tone="ok">
            {done}
          </Txt>
        </Block>
      </Group>
    )
  }

  const multi = q.multiSelect === true
  const picked = answers[step]
  const check = <Ionicons name="checkmark" size={wide ? 15 : 19} color={c.accent} />
  return (
    <Group testID={`request-${code}`} footer={countdown(need.approval.expiresAt, now, 'Claude decides')}>
      <Block>
        <From need={need} extra={questions.length > 1 ? `${step + 1} of ${questions.length}` : null} />
        <Txt v="headline">{q.question}</Txt>
        {multi ? (
          <Txt v="footnote" tone="soft">
            Choose any.
          </Txt>
        ) : null}
      </Block>
      {(q.options ?? []).map((o, i) => {
        const on = multi ? ticked.includes(i) : picked !== undefined && 'picks' in picked && picked.picks.includes(i)
        return (
          <Row
            key={i}
            testID={`option-${code}-${step}-${i}`}
            title={o.label}
            subtitle={o.description}
            subtitleLines={4}
            trailing={on ? check : <View style={{ width: wide ? 15 : 19 }} />}
            onPress={() => (multi ? setTicked(on ? ticked.filter(x => x !== i) : [...ticked, i]) : void answer({ picks: [i] }))}
          />
        )
      })}
      {typing ? (
        <TextArea placeholder="Your answer" value={typed} onChangeText={setTyped} autoFocus minHeight={80} testID={`typed-${code}`} />
      ) : (
        <Row testID={`type-${code}`} title="Type an answer" tone="accent" onPress={() => setTyping(true)} />
      )}
      {multi || typing || step > 0 || error ? (
        <Answering done={null} error={error}>
          <HStack>
            {typing ? <Button flex title="Send" disabled={!typed.trim()} onPress={() => answer({ text: typed.trim() })} testID={`send-typed-${code}`} /> : null}
            {multi && !typing ? <Button flex title={ticked.length ? `Done (${ticked.length})` : 'Done'} disabled={ticked.length === 0} onPress={() => answer({ picks: [...ticked].sort((a, b) => a - b) })} testID={`done-${code}`} /> : null}
            {typing ? (
              <Button kind="plain" title="Back" onPress={() => setTyping(false)} />
            ) : step > 0 ? (
              <Button
                kind="plain"
                title="Previous question"
                onPress={() => {
                  const prev = answers[step - 1]
                  setTicked(prev && 'picks' in prev ? prev.picks : [])
                  setStep(step - 1)
                }}
              />
            ) : null}
          </HStack>
        </Answering>
      ) : null}
    </Group>
  )
}

/** A question that came without its wording (an older machine): answer in your own words. */
function TypedAnswerCard(props: Props) {
  const { need } = props
  const { done, error, send } = useAnswer(props)
  const [typed, setTyped] = useState('')
  return (
    <Group testID={`request-${need.approval.code}`}>
      <Block>
        <From need={need} />
        <Txt v="headline">A question</Txt>
        <Txt v="subhead" tone="soft">
          It’s on the machine’s screen.
        </Txt>
      </Block>
      {done ? null : <TextArea placeholder="Your answer" value={typed} onChangeText={setTyped} minHeight={80} />}
      <Answering done={done} error={error}>
        <Button title="Send" disabled={!typed.trim()} onPress={() => send({ decision: 'answer', text: typed.trim() })} />
      </Answering>
    </Group>
  )
}

function ReviewCard(props: Props) {
  const { need } = props
  const { done, error, send } = useAnswer(props)
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const [changes, setChanges] = useState('')
  const plan = need.approval.plan ?? ''
  const long = plan.length > 900
  return (
    <Group testID={`request-${need.approval.code}`}>
      <Block>
        <From need={need} />
        <Txt v="headline">Review the plan</Txt>
        <View style={{ maxHeight: long && !open ? 280 : undefined, overflow: 'hidden' }}>{plan ? <Markdown text={plan} /> : <Txt tone="soft">The plan is on the machine.</Txt>}</View>
        {long ? <Button small kind="plain" title={open ? 'Show less' : 'Show the whole plan'} onPress={() => setOpen(!open)} /> : null}
      </Block>
      {changing && !done ? <TextArea placeholder="What should change?" value={changes} onChangeText={setChanges} autoFocus minHeight={80} /> : null}
      <Answering done={done} error={error}>
        {changing ? (
          <HStack>
            <Button flex title="Send" disabled={!changes.trim()} onPress={() => send({ decision: 'deny', text: changes.trim() })} />
            <Button kind="plain" title="Back" onPress={() => setChanging(false)} />
          </HStack>
        ) : (
          <HStack>
            <Button flex title="Approve" onPress={() => send({ decision: 'allow' })} testID={`approve-${need.approval.code}`} />
            <Button flex kind="tinted" title="Ask for changes" onPress={() => setChanging(true)} />
          </HStack>
        )}
      </Answering>
    </Group>
  )
}

function TrustCard(props: Props) {
  const { need } = props
  const now = useNow(15_000)
  const { done, error, send } = useAnswer(props)
  const folder = need.approval.folder ?? need.job?.folder ?? ''
  return (
    <Group testID={`request-${need.approval.code}`} footer={done ? undefined : countdown(need.approval.expiresAt, now, 'Cancelled')}>
      <Block>
        <From need={need} />
        <Txt v="headline">Trust this folder?</Txt>
        <Txt v="subhead" tone="soft">
          It’s the first Claude Code task in {basename(folder)}.
        </Txt>
        <Code text={folder} />
      </Block>
      <Answering done={done} error={error}>
        <HStack>
          <Button flex title="Trust" onPress={() => send({ decision: 'allow' })} />
          <Button flex kind="danger" title="Cancel the task" onPress={() => send({ decision: 'deny' })} />
        </HStack>
      </Answering>
    </Group>
  )
}
