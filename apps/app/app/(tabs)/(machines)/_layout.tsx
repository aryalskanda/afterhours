// The Machines tab's stack: its screen (with a large title of its own), and what opens from it.

import { Stack } from 'expo-router'
import { useStackOptions } from '../../../src/navigation'

export const unstable_settings = { initialRouteName: 'index' }

export default function MachinesStack() {
  return (
    <Stack screenOptions={useStackOptions()}>
      <Stack.Screen name="index" options={{ headerShown: false, title: 'Machines' }} />
    </Stack>
  )
}
