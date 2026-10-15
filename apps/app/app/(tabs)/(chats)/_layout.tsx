// The Chats tab's stack: its screen (with a large title of its own), and what opens from it.

import { Stack } from 'expo-router'
import { useStackOptions } from '../../../src/navigation'

export const unstable_settings = { initialRouteName: 'chats/index' }

export default function ChatsStack() {
  return (
    <Stack screenOptions={useStackOptions()}>
      <Stack.Screen name="chats/index" options={{ headerShown: false, title: 'Chats' }} />
    </Stack>
  )
}
