// What a task asks of you: a permission, questions, a plan to review, a folder to trust. Each card
// answers the machine directly; it disappears when the machine says the request is settled. If an
// answer doesn't get through, the card says why and keeps its buttons, to try again.

import { describeAnswers, type QuestionAnswer } from '@afterhours/protocol'
import * as LocalAuthentication from 'expo-local-authentication'
import { useState, type ReactNode } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { hub, useHub } from '../app-state'
import { basename } from '../lib/format'
import type { Need } from '../lib/state'
import { mono, radius, space, type as T, useColors } from '../theme'
import { Countdown } from './bits'
import { Icon, KIND_ICON } from './icons'
import { Markdown } from './Markdown'
import { Button, Card, Field, Label, Outcome, Row, Soft, Title } from './ui'

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

function Head(props: { need: Need; title: string; verb: string }) {
  const { machine, approval, job } = props.need
  const c = useColors()
  return (
    <View style={{ gap: 2 }}>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 2 }}>
          <Icon name={KIND_ICON[approval.kind]} color={c.accent} size={20} />
        </View>
        <View style={{ flex: 1 }}>
          <Title>{props.title}</Title>
        </View>
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Soft numberOfLines={1} style={{ flex: 1 }}>
          {machine.name} · #{approval.job}
          {job ? ` · ${basename(job.folder)}` : ''}
        </Soft>
        <Countdown at={approval.expiresAt} verb={props.verb} />
      </Row>
      {machine.status !== 'connected' ? <Soft>{machine.name} is offline right now, so an answer may not get through.</Soft> : null}
    </View>
  )
}

/** The buttons until the machine takes the answer, with why the last try didn't work; then how it went. */
function Answering(props: { done: string | null; error: string | null; children: ReactNode }) {
  if (props.done) return <Outcome ok text={props.done} />
  return (
    <View style={{ gap: space.s }}>
      {props.error ? <Outcome ok={false} text={props.error} /> : null}
      {props.children}
    </View>
  )
}

/** One request, whichever kind. `onAnswered`: the machine took the answer (the card goes once it says it's settled). */
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
  const c = useColors()
  const { prefs } = useHub()
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
    <Card testID={`request-${a.code}`}>
      <Head need={need} title={`#${a.job} wants to use ${a.tool ?? 'a tool'}`} verb="Denied automatically" />
      {a.detail ? (
        <View style={{ backgroundColor: c.code, borderRadius: radius.s, padding: space.m }}>
          <Text selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: c.ink }}>
            {a.detail}
          </Text>
        </View>
      ) : null}
      <Answering done={done} error={error}>
        {noting ? (
          <>
            <Field placeholder="What Claude should do instead (optional)" value={note} onChangeText={setNote} multiline autoFocus />
            <Row>
              <Button flex kind="danger" title="Deny" onPress={() => send({ decision: 'deny', text: note.trim() || null })} testID={`deny-note-${a.code}`} />
              <Button flex kind="secondary" title="Back" onPress={() => setNoting(false)} />
            </Row>
          </>
        ) : (
          <>
            <Row>
              <Button flex title="Allow" onPress={allow} testID={`allow-${a.code}`} />
              <Button flex kind="danger" title="Deny" onPress={() => send({ decision: 'deny' })} testID={`deny-${a.code}`} />
            </Row>
            <Pressable onPress={() => setNoting(true)} role="button">
              <Soft style={{ textAlign: 'center' }}>Deny with a note for Claude…</Soft>
            </Pressable>
          </>
        )}
      </Answering>
    </Card>
  )
}

const letter = (i: number) => String.fromCharCode(65 + i)

/** Claude's questions, one at a time: every option in full; tick several where it allows; or type an answer. */
function QuestionCard(props: Props) {
  const { need } = props
  const c = useColors()
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
      <Card testID={`request-${code}`}>
        <Head need={need} title={`#${need.approval.job} asked`} verb="Claude decides itself" />
        {questions.map((x, i) => (
          <View key={i} style={{ gap: 2 }}>
            <Label style={{ fontWeight: '600' }}>{x.question}</Label>
            <Soft>
              →{' '}
              {(() => {
                const a = answers[i]
                return !a ? 'no answer' : 'text' in a ? `“${a.text}”` : a.picks.map(p => x.options?.[p]?.label ?? '?').join(', ')
              })()}
            </Soft>
          </View>
        ))}
        <Outcome ok text={done} />
      </Card>
    )
  }

  const multi = q.multiSelect === true
  const picked = answers[step]
  return (
    <Card testID={`request-${code}`}>
      <Head need={need} title={`#${need.approval.job} asks${questions.length > 1 ? ` · ${step + 1} of ${questions.length}` : ''}`} verb="Claude decides itself" />
      {q.header ? <Soft style={[T.tiny, { textTransform: 'uppercase', fontWeight: '600' }]}>{q.header}</Soft> : null}
      <Label style={{ fontWeight: '600', fontSize: 16 }}>{q.question}</Label>
      <View style={{ gap: space.s }}>
        {(q.options ?? []).map((o, i) => {
          const on = multi ? ticked.includes(i) : picked !== undefined && 'picks' in picked && picked.picks.includes(i)
          return (
            <Pressable
              key={i}
              testID={`option-${code}-${step}-${i}`}
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              onPress={() => (multi ? setTicked(on ? ticked.filter(x => x !== i) : [...ticked, i]) : void answer({ picks: [i] }))}
              style={({ pressed }) => ({
                borderWidth: 1,
                borderColor: on ? c.accent : c.line,
                backgroundColor: on ? c.accentSoft : c.card,
                borderRadius: radius.m,
                padding: space.m,
                gap: 2,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: c.ink, fontWeight: '600', fontSize: 15 }}>
                {multi ? (on ? '☑︎ ' : '☐ ') : ''}
                {letter(i)} · {o.label}
              </Text>
              {o.description ? <Soft>{o.description}</Soft> : null}
            </Pressable>
          )
        })}
      </View>
      {error ? <Outcome ok={false} text={error} /> : null}
      {typing ? (
        <View style={{ gap: space.s }}>
          <Field placeholder="Your answer" value={typed} onChangeText={setTyped} multiline autoFocus testID={`typed-${code}`} />
          <Row>
            <Button flex title="Send this answer" disabled={!typed.trim()} onPress={() => answer({ text: typed.trim() })} testID={`send-typed-${code}`} />
            <Button flex kind="secondary" title="Back" onPress={() => setTyping(false)} />
          </Row>
        </View>
      ) : (
        <Row wrap>
          {multi ? <Button flex title={ticked.length ? `Done (${ticked.length})` : 'Done'} disabled={ticked.length === 0} onPress={() => answer({ picks: [...ticked].sort((a, b) => a - b) })} testID={`done-${code}`} /> : null}
          <Button flex kind="secondary" title="Type an answer" onPress={() => setTyping(true)} testID={`type-${code}`} />
          {step > 0 ? (
            <Button
              kind="ghost"
              title="Back"
              onPress={() => {
                const prev = answers[step - 1]
                setTicked(prev && 'picks' in prev ? prev.picks : [])
                setStep(step - 1)
              }}
            />
          ) : null}
        </Row>
      )}
    </Card>
  )
}

/** A question that came without its wording (an older machine): answer in your own words. */
function TypedAnswerCard(props: Props) {
  const { need } = props
  const { done, error, send } = useAnswer(props)
  const [typed, setTyped] = useState('')
  return (
    <Card testID={`request-${need.approval.code}`}>
      <Head need={need} title={`#${need.approval.job} has a question`} verb="Claude decides itself" />
      <Soft>The question is on the machine’s screen.</Soft>
      <Answering done={done} error={error}>
        <Field placeholder="Your answer" value={typed} onChangeText={setTyped} multiline />
        <Button title="Send" disabled={!typed.trim()} onPress={() => send({ decision: 'answer', text: typed.trim() })} />
      </Answering>
    </Card>
  )
}

function ReviewCard(props: Props) {
  const { need } = props
  const c = useColors()
  const { done, error, send } = useAnswer(props)
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const [changes, setChanges] = useState('')
  const plan = need.approval.plan ?? ''
  const long = plan.length > 900
  return (
    <Card testID={`request-${need.approval.code}`}>
      <Head need={need} title={`#${need.approval.job}'s plan, for your review`} verb="Waits" />
      <View style={{ maxHeight: long && !open ? 260 : undefined, overflow: 'hidden' }}>
        {plan ? <Markdown text={plan} /> : <Soft>(The plan is on the machine.)</Soft>}
      </View>
      {long ? (
        <Pressable onPress={() => setOpen(!open)} role="button">
          <Text style={{ color: c.accent, fontWeight: '600' }}>{open ? 'Show less' : 'Read the whole plan'}</Text>
        </Pressable>
      ) : null}
      <Answering done={done} error={error}>
        {changing ? (
          <>
            <Field placeholder="What should Claude change?" value={changes} onChangeText={setChanges} multiline autoFocus />
            <Row>
              <Button flex title="Send" disabled={!changes.trim()} onPress={() => send({ decision: 'deny', text: changes.trim() })} />
              <Button flex kind="secondary" title="Back" onPress={() => setChanging(false)} />
            </Row>
          </>
        ) : (
          <Row>
            <Button flex title="Approve" onPress={() => send({ decision: 'allow' })} testID={`approve-${need.approval.code}`} />
            <Button flex kind="secondary" title="Ask for changes" onPress={() => setChanging(true)} />
          </Row>
        )}
      </Answering>
    </Card>
  )
}

function TrustCard(props: Props) {
  const { need } = props
  const { done, error, send } = useAnswer(props)
  const folder = need.approval.folder ?? need.job?.folder ?? ''
  return (
    <Card testID={`request-${need.approval.code}`}>
      <Head need={need} title="Trust this folder?" verb="Cancelled" />
      <Label>
        #{need.approval.job} is the first Claude Code task in <Text style={{ fontWeight: '700' }}>{basename(folder)}</Text>. Claude asks whether to trust it.
      </Label>
      <Soft>{folder}</Soft>
      <Answering done={done} error={error}>
        <Row>
          <Button flex title="Trust it" onPress={() => send({ decision: 'allow' })} />
          <Button flex kind="danger" title="Cancel the task" onPress={() => send({ decision: 'deny' })} />
        </Row>
      </Answering>
    </Card>
  )
}
