// Over every screen: a banner when something new needs you, system notifications when the app
// isn't in front, and the lock (when it's on).

import * as Haptics from 'expo-haptics'
import * as LocalAuthentication from 'expo-local-authentication'
import { router, type Href } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { AppState, Image, Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { hub, useHub } from '../app-state'
import { desktop } from '../desktop'
import { withoutEmoji } from '../lib/format'
import { useTheme } from '../theme'
import { Button, StatusDot, Txt } from './ui'

/** Notices that need an answer: a click goes to Needs you. Others go to their machine. */
const NEEDS_ANSWER = ['permission', 'question', 'plan_review', 'trust']

function routeFor(a: { type: string; machine: string }): string {
  return NEEDS_ANSWER.includes(a.type) ? '/inbox' : `/machine/${a.machine}`
}

/**
 * Outside the app's window: a system notification. On the desktop, the app decides (it knows
 * whether its window is in front); in a browser, when the tab is in the background and you turned
 * them on.
 */
export function SystemAlerts() {
  const { attention, prefs } = useHub()
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!attention || attention.id === last.current) return
    last.current = attention.id
    const route = routeFor(attention)
    const body = withoutEmoji(attention.text.split('\n')[0] ?? '')
    if (desktop) {
      desktop.notify({ title: attention.machineName, body, route })
      return
    }
    if (Platform.OS !== 'web' || !prefs.browserNotifications || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted' || !document.hidden) return
    const note = new Notification(attention.machineName, { body, tag: `afterhours-${attention.id}` })
    note.onclick = () => {
      window.focus()
      router.push(route as Href)
      note.close()
    }
  }, [attention, prefs.browserNotifications])
  return null
}

/** Something new while the app is open: a banner at the top, like the system's own. */
export function AttentionBanner() {
  const { attention } = useHub()
  const { c, t, wide } = useTheme()
  const insets = useSafeAreaInsets()
  useEffect(() => {
    if (!attention) return
    if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})
    const timer = setTimeout(() => hub.dismissAttention(attention.id), 7000)
    return () => clearTimeout(timer)
  }, [attention])
  if (!attention) return null
  const needs = NEEDS_ANSWER.includes(attention.type)
  return (
    <Pressable
      testID="attention"
      onPress={() => {
        hub.dismissAttention(attention.id)
        router.push(routeFor(attention) as Href)
      }}
      style={{ position: 'absolute', top: insets.top + 8, left: 10, right: 10, alignItems: wide ? 'flex-end' : 'center' }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: wide ? 360 : 520,
          backgroundColor: c.group,
          borderRadius: wide ? 10 : 16,
          paddingHorizontal: 14,
          paddingVertical: 11,
          flexDirection: 'row',
          gap: 10,
          alignItems: 'center',
          shadowColor: c.shadow,
          shadowOpacity: 0.16,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 6 },
          elevation: 8,
        }}
      >
        {needs ? <StatusDot color={c.accent} /> : null}
        <View style={{ flex: 1, gap: 1 }}>
          <Txt v="footnote" tone="soft" lines={1}>
            {attention.machineName}
          </Txt>
          <Text numberOfLines={2} style={[t.subhead, { color: c.ink, fontWeight: '600' }]}>
            {withoutEmoji(attention.text.split('\n')[0] ?? '')}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

/** With "Lock the app" on: Face ID or a fingerprint when it opens, and after a minute away. */
export function LockGate() {
  const { prefs, ready } = useHub()
  const { c } = useTheme()
  const [locked, setLocked] = useState(false)
  const awayAt = useRef<number | null>(null)
  const enabled = ready && prefs.lockApp && Platform.OS !== 'web'

  useEffect(() => {
    if (enabled) setLocked(true)
  }, [enabled])

  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s !== 'active') awayAt.current = Date.now()
      else if (enabled && awayAt.current && Date.now() - awayAt.current > 60_000) setLocked(true)
    })
    return () => sub.remove()
  }, [enabled])

  const unlock = async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Afterhours' })
    if (r.success) setLocked(false)
  }

  useEffect(() => {
    if (locked) void unlock()
  }, [locked])

  if (!enabled || !locked) return null
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.page, alignItems: 'center', justifyContent: 'center', gap: 18, padding: 32 }}>
      <Image source={require('../../assets/icon.png')} style={{ width: 64, height: 64, borderRadius: 15 }} />
      <Txt v="headline">Locked</Txt>
      <Button title="Unlock" onPress={unlock} />
    </View>
  )
}
