// Over every screen: a banner when something new needs you, and the lock (when it's on).

import * as Haptics from 'expo-haptics'
import * as LocalAuthentication from 'expo-local-authentication'
import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { AppState, Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { hub, useHub } from '../app-state'
import { radius, space, useColors } from '../theme'
import { withoutEmoji } from '../lib/format'
import { Icon, NOTICE_ICON } from './icons'
import { Button, Soft, Title } from './ui'

export function AttentionBanner() {
  const { attention } = useHub()
  const c = useColors()
  const insets = useSafeAreaInsets()
  useEffect(() => {
    if (!attention) return
    if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})
    const timer = setTimeout(() => hub.dismissAttention(attention.id), 7000)
    return () => clearTimeout(timer)
  }, [attention])
  if (!attention) return null
  const needs = ['permission', 'question', 'plan_review', 'trust'].includes(attention.type)
  return (
    <Pressable
      testID="attention"
      onPress={() => {
        hub.dismissAttention(attention.id)
        router.push(needs ? '/inbox' : `/machine/${attention.machine}`)
      }}
      style={{ position: 'absolute', top: insets.top + space.s, left: space.m, right: space.m, alignItems: 'center' }}
    >
      <View style={{ width: '100%', maxWidth: 560, backgroundColor: c.card, borderColor: c.accent, borderWidth: 1, borderRadius: radius.l, padding: space.m, gap: 2, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
        <Soft>{attention.machineName}</Soft>
        <View style={{ flexDirection: 'row', gap: space.s, alignItems: 'flex-start' }}>
          <View style={{ paddingTop: 1 }}>
            <Icon name={NOTICE_ICON[attention.type as keyof typeof NOTICE_ICON] ?? 'notifications'} color={c.accent} />
          </View>
          <Text numberOfLines={3} style={{ color: c.ink, fontWeight: '600', fontSize: 15, flex: 1 }}>
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
  const c = useColors()
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
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', gap: space.l, padding: space.xl }}>
      <Title>Afterhours is locked</Title>
      <Soft style={{ textAlign: 'center' }}>Unlock to see your machines and answer them.</Soft>
      <Button title="Unlock" onPress={unlock} />
    </View>
  )
}
