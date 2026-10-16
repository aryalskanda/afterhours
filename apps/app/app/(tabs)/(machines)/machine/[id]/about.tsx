// How a machine is: the versions of Afterhours and Claude Code, how long it has been up, its disk,
// battery and load, and the Claude account and MCP servers its tasks use. Owners also see the
// engine's last log lines, and can restart it.

import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useMachine } from '../../../../../src/app-state'
import { Terminal } from '../../../../../src/components/bits'
import { Block, ConfirmRow, EmptyState, Group, LoadingRows, Note, Page, Row, Txt } from '../../../../../src/components/ui'
import { useAction } from '../../../../../src/components/useAction'
import { useLoad } from '../../../../../src/components/useLoad'
import { bytes, duration } from '../../../../../src/lib/format'
import { ClaudeInfo, HealthInfo } from '../../../../../src/lib/results'
import { supports } from '../../../../../src/lib/state'

/** The 1-minute load per CPU, in words. */
function loadLabel(load: number): string {
  return load < 0.5 ? 'Light' : load < 1 ? 'Busy' : 'Overloaded'
}

const SCOPES = { user: 'Yours', project: 'The project’s', local: 'This folder only' } as const

export default function About() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const m = useMachine(id)
  const online = m?.status === 'connected'
  const health = useLoad(id, m && online && supports(m, 'health') ? { type: 'health' } : null, HealthInfo, `health:${id}:${online}`, { every: 30_000 })
  const claude = useLoad(id, m && online && supports(m, 'claude') ? { type: 'claude' } : null, ClaudeInfo, `claude:${id}:${online}`)
  const restart = useAction()

  if (!m) {
    return (
      <Page>
        <EmptyState title="Not paired" text="This device isn’t paired with that machine any more." />
      </Page>
    )
  }
  if (!supports(m, 'health')) {
    return (
      <Page testID="about">
        <Stack.Screen options={{ title: 'About' }} />
        <Note text={`Update Afterhours on ${m.name} to see how it’s doing from here.`} />
      </Page>
    )
  }

  const h = health.data
  const cl = claude.data
  const owner = m.role === 'owner'
  return (
    <Page
      testID="about"
      refreshing={false}
      onRefresh={() => {
        health.reload()
        claude.reload()
      }}
    >
      <Stack.Screen options={{ title: 'About' }} />
      {!online ? <Note text={`${m.name} is offline.`} /> : null}
      {health.error ? <Note ok={false} text={health.error} /> : null}
      {!h && online && !health.error ? <LoadingRows count={4} /> : null}
      {h ? (
        <Group header={m.name} testID="health">
          <Row title="Afterhours" value={h.version} />
          <Row title="Claude Code" value={h.claudeVersion ?? 'Not found'} />
          <Row title="System" value={h.os} />
          <Row title="Up for" value={duration(h.uptimeSec * 1000)} />
          {h.diskFreeBytes !== null && h.diskTotalBytes !== null ? (
            <Row title="Disk" value={<Txt tone={h.diskFreeBytes < 5 * 1024 ** 3 ? 'danger' : 'soft'} num>{`${bytes(h.diskFreeBytes)} free of ${bytes(h.diskTotalBytes)}`}</Txt>} testID="health-disk" />
          ) : null}
          {h.battery ? (
            <Row
              title="Battery"
              value={<Txt tone={!h.battery.charging && h.battery.pct <= 20 ? 'danger' : 'soft'} num>{`${h.battery.pct}%${h.battery.charging ? ', charging' : ', on battery'}`}</Txt>}
              testID="health-battery"
            />
          ) : null}
          {h.load !== null ? <Row title="Load" value={`${loadLabel(h.load)} · ${h.load.toFixed(2)}`} /> : null}
        </Group>
      ) : null}

      {cl ? (
        <Group header="Claude Code" footer="MCP servers by name only: their commands and keys stay on the machine." testID="claude-info">
          {cl.account !== undefined ? <Row title="Account" value={cl.account ? (cl.account.email ?? cl.account.organization ?? 'Signed in') : 'Not signed in'} /> : null}
          {cl.mcp.length === 0 ? <Row title="MCP servers" value="None" /> : null}
          {cl.mcp.map(s => (
            <Row key={`${s.scope}:${s.name}`} title={s.name} subtitle={`${SCOPES[s.scope]} · ${s.type}`} />
          ))}
          <Row title="Project instructions" subtitle="CLAUDE.md in a folder" chevron onPress={() => router.push({ pathname: '/machine/[id]/instructions', params: { id: m.id } })} testID="open-instructions" />
        </Group>
      ) : null}

      {owner && h?.logs ? (
        <Group header="Engine log" footer="What the engine did: tasks, connections, errors. Your prompts aren’t in it.">
          <Block>
            <Terminal text={h.logs.join('\n')} height={280} testID="engine-log" />
          </Block>
        </Group>
      ) : null}

      {owner ? (
        <Group footer="Its service starts it again at once. A running task carries on.">
          <ConfirmRow
            title="Restart Afterhours"
            confirm="Tap again to restart"
            testID="restart"
            onConfirm={() => restart.run(m.id, { type: 'restart' })}
          />
        </Group>
      ) : null}
      {restart.outcome ? <Note ok={restart.outcome.ok} text={restart.outcome.text} /> : null}
    </Page>
  )
}
