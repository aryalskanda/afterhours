// The four tabs: a tab bar on a phone, a sidebar on a wide window. Needs you carries a count.

import Ionicons from '@expo/vector-icons/Ionicons'
import { Tabs } from 'expo-router/js-tabs'
import { useEffect, useMemo } from 'react'
import { Platform, type ColorValue } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useHub } from '../../src/app-state'
import { desktop } from '../../src/desktop'
import { needsYou } from '../../src/lib/state'
import { useTheme } from '../../src/theme'

type IconName = keyof typeof Ionicons.glyphMap

/** The filled icon for the tab you're on, the outline for the others; smaller in the sidebar. */
const icon =
  (name: string, wide: boolean) =>
  ({ focused, color, size }: { focused: boolean; color: ColorValue; size: number }) => <Ionicons name={(focused ? name : `${name}-outline`) as IconName} color={color} size={wide ? 18 : size} />

export default function TabsLayout() {
  const { c, wide } = useTheme()
  const insets = useSafeAreaInsets()
  const { machines } = useHub()
  const waiting = useMemo(() => needsYou(machines).length, [machines])
  // The desktop app shows the count in the tray and on the dock.
  useEffect(() => desktop?.setNeedsYou(waiting), [waiting])
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarPosition: wide ? 'left' : 'bottom',
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.soft,
        // In a phone's browser the bar is a little taller than the system's 49: its labels sat on the edge.
        tabBarStyle: wide ? { backgroundColor: c.fill, borderRightColor: c.line, minWidth: 200, paddingTop: 14, paddingHorizontal: 0 } : { backgroundColor: c.group, borderTopColor: c.line, ...(Platform.OS === 'web' ? { height: 54 + insets.bottom } : {}) },
        tabBarLabelStyle: wide ? { fontSize: 13, fontWeight: '500', color: c.ink } : { fontSize: 10, fontWeight: '500' },
        // The sidebar: a quiet highlight for where you are, the icon in the accent.
        ...(wide ? { tabBarActiveBackgroundColor: c.selected, tabBarItemStyle: { borderRadius: 7, marginHorizontal: 10, marginVertical: 1, minHeight: 32, paddingVertical: 4 } } : {}),
        tabBarBadgeStyle: { backgroundColor: c.accent, color: c.accentInk, fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen name="(machines)" options={{ title: 'Machines', tabBarIcon: icon('desktop', wide), tabBarButtonTestID: 'tab-machines' }} />
      <Tabs.Screen name="(inbox)" options={{ title: 'Needs you', tabBarIcon: icon('notifications', wide), tabBarButtonTestID: 'tab-inbox', tabBarBadge: waiting > 0 ? waiting : undefined }} />
      <Tabs.Screen name="(chats)" options={{ title: 'Chats', tabBarIcon: icon('chatbubbles', wide), tabBarButtonTestID: 'tab-chats' }} />
      <Tabs.Screen name="(settings)" options={{ title: 'Settings', tabBarIcon: icon('settings', wide), tabBarButtonTestID: 'tab-settings' }} />
    </Tabs>
  )
}
