// How Afterhours works, in a few lines each.

import { Stack } from 'expo-router'
import { Block, Group, Page, Txt } from '../../../src/components/ui'

const TOPICS: [string, string][] = [
  ['Machines', 'A machine is a computer running Afterhours. It runs Claude Code tasks one after another from its queue, in your folders, on your account. Pair one with cq pair on it.'],
  ['Needs you', 'When a task asks for a permission, has questions or a plan to review, it waits here. Unanswered, it’s settled for you after its time (permissions are denied).'],
  ['Roles', 'Owners do everything, including devices and commands. Operators queue tasks and answer requests. Viewers only look.'],
  ['The machine’s rules', 'Each machine decides which folders apps may use, whether tasks may skip permission prompts, and whether apps see screens or type. Set them on the machine with cq remote; the app only shows them.'],
  ['Own branches', 'A task on its own branch works in a copy of your checkout. Merge it, open a pull request, or throw it away when it’s done. Tasks in your checkout are never undone from the app.'],
  ['Privacy', 'The app talks to each machine end-to-end encrypted through a relay that can’t read anything. Push notifications are the exception: with details on, they carry what the task asks.'],
  ['A lost phone', 'From another device: Settings, Remove a device, cuts it off from every machine you own. On the machine: cq devices remove.'],
]

export default function Help() {
  return (
    <Page testID="help">
      <Stack.Screen options={{ title: 'Help' }} />
      {TOPICS.map(([title, text]) => (
        <Group key={title} header={title}>
          <Block>
            <Txt>{text}</Txt>
          </Block>
        </Group>
      ))}
    </Page>
  )
}
