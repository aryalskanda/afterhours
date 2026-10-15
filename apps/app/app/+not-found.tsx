// A link to a screen this version of the app doesn't have.

import { router, Stack } from 'expo-router'
import { Button, EmptyState, Page } from '../src/components/ui'

export default function NotFound() {
  return (
    <Page sheet>
      <Stack.Screen options={{ title: 'Not found' }} />
      <EmptyState title="Nothing here" text="That link leads to a screen this version of the app doesn’t have." action={<Button kind="tinted" title="Machines" onPress={() => router.replace('/')} />} />
    </Page>
  )
}
