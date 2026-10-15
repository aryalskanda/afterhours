// The four tabs. "Needs you" carries a badge with how many requests wait on you.

import Ionicons from '@expo/vector-icons/Ionicons'
import { router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { useMemo } from 'react'
import { Pressable, type ColorValue } from 'react-native'
import { useHub } from '../../src/app-state'
import { needsYou } from '../../src/lib/state'
import { space, useColors } from '../../src/theme'

type IconName = keyof typeof Ionicons.glyphMap

const icon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />

export default function TabsLayout() {
  const c = useColors()
  const { machines } = useHub()
  const waiting = useMemo(() => needsYou(machines).length, [machines])
  const canQueue = machines.some(m => m.role !== 'viewer' && m.status !== 'refused')
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.faint,
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.line },
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.ink },
        headerTintColor: c.accent,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Machines',
          tabBarIcon: icon('desktop-outline'),
          tabBarButtonTestID: 'tab-machines',
          headerRight: canQueue
            ? () => (
                <Pressable role="button" aria-label="New task" testID="header-new" onPress={() => router.push('/new')} style={{ paddingHorizontal: space.l }}>
                  <Ionicons name="add-circle-outline" size={26} color={c.accent} />
                </Pressable>
              )
            : undefined,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Needs you',
          tabBarIcon: icon('notifications-outline'),
          tabBarButtonTestID: 'tab-inbox',
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: c.accent, color: c.accentInk },
        }}
      />
      <Tabs.Screen name="chats" options={{ title: 'Chats', tabBarIcon: icon('chatbubbles-outline'), tabBarButtonTestID: 'tab-chats' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline'), tabBarButtonTestID: 'tab-settings' }} />
    </Tabs>
  )
}
