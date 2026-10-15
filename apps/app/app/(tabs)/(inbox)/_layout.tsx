// The Needs you tab's stack: its screen (with a large title of its own), and what opens from it.

import { Stack } from 'expo-router'
import { useStackOptions } from '../../../src/navigation'

export const unstable_settings = { initialRouteName: 'inbox' }

export default function NeedsyouStack() {
  return (
    <Stack screenOptions={useStackOptions()}>
      <Stack.Screen name="inbox" options={{ headerShown: false, title: 'Needs you' }} />
    </Stack>
  )
}
