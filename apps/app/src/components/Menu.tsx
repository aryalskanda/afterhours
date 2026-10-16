// A row's other actions, on a long press: the system's action sheet on an iPhone, a sheet of our
// own elsewhere. Swiping a row shows its main ones (SwipeActions).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import Swipeable from 'react-native-gesture-handler/Swipeable'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme'

export interface MenuItem {
  label: string
  destructive?: boolean
  onPress: () => unknown
}

interface Menu {
  title?: string
  items: MenuItem[]
}

let show: ((menu: Menu) => void) | null = null

export function openMenu(menu: Menu): void {
  if (menu.items.length === 0) return
  if (Platform.OS === 'ios') {
    const destructive = menu.items.map((x, i) => (x.destructive ? i : -1)).filter(i => i >= 0)
    ActionSheetIOS.showActionSheetWithOptions(
      { title: menu.title, options: [...menu.items.map(x => x.label), 'Cancel'], cancelButtonIndex: menu.items.length, destructiveButtonIndex: destructive },
      i => void menu.items[i]?.onPress(),
    )
    return
  }
  show?.(menu)
}

/** Where the sheet shows (Android, the web, the desktop app): once, at the root. */
export function MenuHost() {
  const { c, t, wide } = useTheme()
  const insets = useSafeAreaInsets()
  const [menu, setMenu] = useState<Menu | null>(null)
  useEffect(() => {
    show = setMenu
    return () => {
      show = null
    }
  }, [])
  if (!menu) return null
  const close = () => setMenu(null)
  return (
    <Modal transparent visible animationType="fade" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.3)', justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center' }} onPress={close} aria-label="Close" testID="menu-backdrop">
        <View role="menu" style={{ width: '100%', maxWidth: 420, padding: 10, paddingBottom: wide ? 10 : insets.bottom + 10, gap: 8 }}>
          <View style={{ backgroundColor: c.group, borderRadius: 14, overflow: 'hidden' }}>
            {menu.title ? (
              <Text numberOfLines={2} style={[t.footnote, { color: c.soft, textAlign: 'center', paddingHorizontal: 16, paddingVertical: 10 }]}>
                {menu.title}
              </Text>
            ) : null}
            {menu.items.map((x, i) => (
              <Pressable
                key={x.label}
                role="menuitem"
                testID={`menu-${x.label}`}
                onPress={() => {
                  close()
                  void x.onPress()
                }}
                style={({ pressed }) => ({ paddingVertical: 14, alignItems: 'center', backgroundColor: pressed ? c.pressed : undefined, borderTopWidth: i === 0 && !menu.title ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.line })}
              >
                <Text style={[t.body, { color: x.destructive ? c.danger : c.accent }]}>{x.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable role="button" onPress={close} style={({ pressed }) => ({ backgroundColor: pressed ? c.pressed : c.group, borderRadius: 14, paddingVertical: 14, alignItems: 'center' })} testID="menu-cancel">
            <Text style={[t.body, { color: c.accent, fontWeight: '600' }]}>Cancel</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  )
}

export interface SwipeAction {
  label: string
  tone: 'accent' | 'danger'
  onPress: () => unknown
}

/** A row that slides left to show its main actions, on a touch screen (a long press has them too). */
export function SwipeActions(props: { actions: SwipeAction[]; children: ReactNode; testID?: string }) {
  const { c, t } = useTheme()
  const ref = useRef<Swipeable>(null)
  if (props.actions.length === 0 || Platform.OS === 'web') return <>{props.children}</>
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={36}
      overshootRight={false}
      renderRightActions={() => (
        <View style={{ flexDirection: 'row' }}>
          {props.actions.map(a => (
            <Pressable
              key={a.label}
              role="button"
              testID={props.testID ? `${props.testID}-${a.label}` : undefined}
              onPress={() => {
                ref.current?.close()
                void a.onPress()
              }}
              style={{ width: 88, justifyContent: 'center', alignItems: 'center', backgroundColor: a.tone === 'danger' ? c.danger : c.accent }}
            >
              <Text style={[t.subhead, { color: a.tone === 'danger' ? '#ffffff' : c.accentInk, fontWeight: '600' }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    >
      <View style={{ backgroundColor: c.group }}>{props.children}</View>
    </Swipeable>
  )
}
