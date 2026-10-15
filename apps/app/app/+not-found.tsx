// A link to a screen this version of the app doesn't have.

import { router, Stack } from 'expo-router'
import { Button, Empty, Screen } from '../src/components/ui'

export default function NotFound() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Empty title="Nothing here" text="That link points to a screen this version of the app doesn’t have.">
        <Button title="Back to machines" onPress={() => router.replace('/')} />
      </Empty>
    </Screen>
  )
}
