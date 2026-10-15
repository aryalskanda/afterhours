// The Settings tab's stack: its screen (with a large title of its own), and what opens from it.

import { Stack } from 'expo-router'
import { useStackOptions } from '../../../src/navigation'

export const unstable_settings = { initialRouteName: 'settings' }

export default function SettingsStack() {
  return (
    <Stack screenOptions={useStackOptions()}>
      <Stack.Screen name="settings" options={{ headerShown: false, title: 'Settings' }} />
    </Stack>
  )
}
