// What's new in this version.

import { Stack } from 'expo-router'
import { APP_VERSION } from '../../../src/app-state'
import { Group, Page, Row } from '../../../src/components/ui'

const NEW: { version: string; items: [string, string][] }[] = [
  {
    version: '0.3.0',
    items: [['Inside Telegram', 'Your bot opens the whole app right in Telegram: set up in one tap, with Telegram’s Back button and its light or dark. The bot’s messages turn short, with Open ↗ for the rest.']],
  },
  {
    version: '0.2.0',
    items: [
      ['See the work', 'What Claude did and is doing, the files it changed with their diffs, and the conversation in full.'],
      ['Steer', 'Always-allow rules, plan modes, messages to a running task, editing and moving queued tasks, schedules and time limits, branches merged or opened as pull requests.'],
      ['Better prompts', 'Photos and files, / commands and @ files, saved prompts and drafts, three ways to compare, comments on a diff.'],
      ['Machines', 'All tasks and search, health and Claude Code, CLAUDE.md, usage over time with a forecast, invites by QR code, a lost device removed everywhere.'],
      ['Safety', 'Permission requests say what a command does and what to look at twice.'],
      ['Notifications', 'Pushes on phones (once the app is built under an Expo account), with or without details, and quiet hours.'],
      ['Backups', 'This device sealed with a passphrase, to move to a new phone.'],
    ],
  },
]

export default function WhatsNew() {
  return (
    <Page testID="whats-new">
      <Stack.Screen options={{ title: 'What’s new' }} />
      {NEW.map(v => (
        <Group key={v.version} header={v.version === APP_VERSION ? `Version ${v.version}` : `In ${v.version}`}>
          {v.items.map(([title, text]) => (
            <Row key={title} title={title} subtitle={text} subtitleLines={4} />
          ))}
        </Group>
      ))}
    </Page>
  )
}
