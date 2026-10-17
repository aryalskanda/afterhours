// What every stack's header looks like: on the page's own colour, no shadow, the accent for
// buttons; on the iPhone, back buttons say where they go back to; inside Telegram, none (Telegram's
// Back button does it).

import Ionicons from '@expo/vector-icons/Ionicons'
import { Platform, Pressable, Text } from 'react-native'
import { inTelegram } from './telegram'
import { useTheme } from './theme'

export function useStackOptions() {
  const { c, t } = useTheme()
  return {
    headerStyle: { backgroundColor: c.page },
    headerShadowVisible: false,
    headerTintColor: c.accent,
    headerTitleStyle: { color: c.ink, fontSize: t.headline.fontSize, fontWeight: '600' as const },
    contentStyle: { backgroundColor: c.page },
    headerBackButtonDisplayMode: Platform.OS === 'ios' ? ('default' as const) : ('minimal' as const),
    // Inside Telegram, its own Back button (in its header) goes back.
    ...(inTelegram ? { headerBackVisible: false, headerLeft: noBack } : {}),
  }
}

/** A header's left side on the web: the stack's back arrow, except inside Telegram (its Back button does it). */
export const noBack = inTelegram ? () => null : undefined

/** A text button in a header: Cancel, Queue. */
export function HeaderButton(props: { title: string; onPress: () => void; bold?: boolean; disabled?: boolean; testID?: string }) {
  const { c, t } = useTheme()
  return (
    <Pressable testID={props.testID} role="button" aria-disabled={props.disabled} disabled={props.disabled} onPress={props.onPress} hitSlop={10} style={({ pressed }) => ({ opacity: props.disabled ? 0.35 : pressed ? 0.5 : 1, paddingHorizontal: 4, marginHorizontal: Platform.OS === 'web' ? 12 : 0 })}>
      <Text style={[t.body, { color: c.accent, fontWeight: props.bold ? '600' : '400' }]}>{props.title}</Text>
    </Pressable>
  )
}

/** An icon button beside a large title: New task. */
export function TitleButton(props: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; testID?: string }) {
  const { c, wide } = useTheme()
  return (
    <Pressable testID={props.testID} role="button" aria-label={props.label} onPress={props.onPress} hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
      <Ionicons name={props.icon} size={wide ? 22 : 28} color={c.accent} />
    </Pressable>
  )
}
