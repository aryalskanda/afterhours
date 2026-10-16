// Sending a problem to a machine's owner: what you write, the app's version and its recent lines
// (shown before they go). It goes to one machine, into its app-reports log.

import { useState } from 'react'
import { Platform } from 'react-native'
import { APP_VERSION, hub, useHub } from '../app-state'
import { plainReply } from '../lib/format'
import { recentProblems, reportText } from '../lib/problems'
import { supports } from '../lib/state'
import { Block, Button, Group, Note, Row, TextArea, Txt } from './ui'

export function ReportForm(props: { error?: Error | null; testID?: string }) {
  const { machines } = useHub()
  const usable = machines.filter(m => m.status === 'connected' && supports(m, 'report'))
  // An owner's machine first: its owner reads the log.
  const sorted = [...usable].sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
  const [picked, setPicked] = useState<string | null>(null)
  const target = sorted.find(m => m.id === picked) ?? sorted[0]
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [showing, setShowing] = useState(false)
  const report = reportText({ text, app: `afterhours-app/${APP_VERSION}`, platform: `${Platform.OS} ${Platform.Version ?? ''}`.trim(), error: props.error, recent: recentProblems() })

  if (!target) {
    return <Note text="No machine to send it to: one needs to be online, with an Afterhours that takes reports." />
  }
  if (outcome?.ok) return <Note ok text={outcome.text} testID="report-sent" />
  return (
    <>
      <Group header="What happened" testID={props.testID}>
        <TextArea placeholder="What did you do, and what went wrong?" value={text} onChangeText={setText} minHeight={120} testID="report-text" />
      </Group>
      {sorted.length > 1 ? (
        <Group header="Send to">
          {sorted.map(m => (
            <Row key={m.id} title={m.name} value={m.id === target.id ? 'Chosen' : undefined} onPress={() => setPicked(m.id)} />
          ))}
        </Group>
      ) : null}
      <Group footer={`It goes to ${target.name}’s app-reports log, with what’s shown below. Nothing else.`}>
        <Row title={showing ? 'Hide what’s sent' : 'Show what’s sent'} onPress={() => setShowing(!showing)} testID="report-show" />
        {showing ? (
          <Block>
            <Txt v="footnote" mono selectable tone="soft">
              {report}
            </Txt>
          </Block>
        ) : null}
      </Group>
      <Button
        title={sending ? 'Sending…' : `Send to ${target.name}`}
        disabled={sending || (!text.trim() && !props.error)}
        onPress={async () => {
          setSending(true)
          const r = await hub.request(target.id, { type: 'report', text: report, app: `afterhours-app/${APP_VERSION}`, platform: Platform.OS })
          setSending(false)
          setOutcome({ ok: r.ok, text: plainReply(r.ok ? (r.text ?? 'Sent.') : (r.error ?? 'It didn’t go through.')) })
        }}
        testID="report-send"
      />
      {outcome && !outcome.ok ? <Note ok={false} text={outcome.text} /> : null}
    </>
  )
}
