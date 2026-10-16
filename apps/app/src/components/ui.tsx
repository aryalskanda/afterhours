// The app's pieces: a page (with a large title on the tab screens), grouped lists of rows, buttons,
// a segmented control, switches, fields, status dots, badges and empty states.

import Ionicons from '@expo/vector-icons/Ionicons'
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { mono, tabular, useTheme, type TypeScale } from '../theme'

/** Pressable's state; the web adds `hovered`. */
type PressState = PressableStateCallbackType & { hovered?: boolean }

// --- text ------------------------------------------------------------------------------------------

type Tone = 'ink' | 'soft' | 'faint' | 'accent' | 'danger' | 'ok'

/** Text in one of the type scale's styles (`v`) and tones. */
export function Txt(props: { v?: keyof TypeScale; tone?: Tone; children: ReactNode; style?: StyleProp<TextStyle>; lines?: number; selectable?: boolean; testID?: string; mono?: boolean; num?: boolean }) {
  const { c, t } = useTheme()
  return (
    <Text
      testID={props.testID}
      selectable={props.selectable}
      numberOfLines={props.lines}
      style={[t[props.v ?? 'body'], { color: c[props.tone ?? 'ink'] }, props.mono && { fontFamily: mono, letterSpacing: 0 }, props.num && tabular, props.style]}
    >
      {props.children}
    </Text>
  )
}

export function HStack(props: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: props.gap ?? 8, flexWrap: props.wrap ? 'wrap' : 'nowrap' }, props.style]}>{props.children}</View>
}

// --- page and lists -----------------------------------------------------------------------------

/**
 * A screen's scrolling page. `title`: a large title (the tab screens, whose header is hidden),
 * with `action` at its right. `sheet`: a page over the tabs (New task, Pair), centred in a wide
 * window as a dialog is.
 */
export function Page(props: { title?: string; action?: ReactNode; sheet?: boolean; children: ReactNode; refreshing?: boolean; onRefresh?: () => void; testID?: string }) {
  const { c, t, m, wide } = useTheme()
  const insets = useSafeAreaInsets()
  const top = props.title ? (wide ? 28 : insets.top + 10) : wide ? 20 : 18
  return (
    <ScrollView
      testID={props.testID}
      style={{ flex: 1, backgroundColor: c.page }}
      contentContainerStyle={{ paddingTop: top, paddingBottom: 56, paddingHorizontal: m.pageX, alignItems: !wide ? 'stretch' : props.sheet ? 'center' : 'flex-start' }}
      keyboardShouldPersistTaps="handled"
      // On the web a scroll (a browser keeping the caret in view) would blur the field you type in.
      keyboardDismissMode={Platform.OS === 'web' ? 'none' : 'on-drag'}
      refreshControl={props.onRefresh ? <RefreshControl refreshing={props.refreshing ?? false} onRefresh={props.onRefresh} tintColor={c.soft} /> : undefined}
    >
      <View style={{ width: '100%', maxWidth: props.sheet ? Math.min(m.maxWidth, 640) : m.maxWidth, gap: m.gap }}>
        {props.title ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: wide ? -8 : -12 }}>
            <Text role="heading" style={[t.largeTitle, { color: c.ink }]}>
              {props.title}
            </Text>
            {props.action}
          </View>
        ) : null}
        {props.children}
      </View>
    </ScrollView>
  )
}

/** A rounded group of rows on the page, with hairlines between them, and an optional header and footer. */
export function Group(props: { header?: ReactNode; right?: ReactNode; footer?: ReactNode; children?: ReactNode; testID?: string }) {
  const { c, t, m } = useTheme()
  const items = Children.toArray(props.children).filter(Boolean)
  return (
    <View testID={props.testID} style={{ gap: 7 }}>
      {props.header || props.right ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: m.rowX, minHeight: 18 }}>
          {typeof props.header === 'string' ? <Text style={[t.footnote, { color: c.soft }]}>{props.header}</Text> : (props.header ?? <View />)}
          {props.right}
        </View>
      ) : null}
      {items.length > 0 ? (
        <View style={{ backgroundColor: c.group, borderRadius: m.radius, overflow: 'hidden' }}>
          {items.map((child, i) => (
            <View key={isValidElement(child) && child.key != null ? child.key : i}>
              {i > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginLeft: m.rowX }} /> : null}
              {child}
            </View>
          ))}
        </View>
      ) : null}
      {props.footer ? (
        typeof props.footer === 'string' ? (
          <Text style={[t.footnote, { color: c.soft, paddingHorizontal: m.rowX }]}>{props.footer}</Text>
        ) : (
          <View style={{ paddingHorizontal: m.rowX }}>{props.footer}</View>
        )
      ) : null}
    </View>
  )
}

/** A text button beside a group's header ("Pause"): it sits on the header's line without growing it. */
export function GroupAction(props: { title: string; onPress: () => unknown; testID?: string }) {
  const { c, t } = useTheme()
  const [busy, setBusy] = useState(false)
  return (
    <Pressable
      testID={props.testID}
      role="button"
      disabled={busy}
      hitSlop={{ top: 12, bottom: 8, left: 12, right: 12 }}
      onPress={async () => {
        setBusy(true)
        try {
          await props.onPress()
        } finally {
          setBusy(false)
        }
      }}
      style={(state: PressState) => ({ opacity: busy ? 0.4 : state.pressed ? 0.5 : state.hovered ? 0.75 : 1 })}
    >
      <Text style={[t.subhead, { color: c.accent }]}>{props.title}</Text>
    </Pressable>
  )
}

/** Content inside a group that isn't a row: padded like one. */
export function Block(props: { children: ReactNode; gap?: number; testID?: string; style?: StyleProp<ViewStyle> }) {
  const { m } = useTheme()
  return (
    <View testID={props.testID} style={[{ paddingHorizontal: m.rowX, paddingVertical: m.rowY + 2, gap: props.gap ?? 8 }, props.style]}>
      {props.children}
    </View>
  )
}

/**
 * A row in a group: an optional leading mark, a title and subtitle, a value on the right, and a
 * chevron when it opens something. `tone`: an action (accent) or a destructive one (danger).
 */
export function Row(props: {
  title: ReactNode
  subtitle?: ReactNode
  value?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  chevron?: boolean
  onPress?: () => void
  tone?: 'accent' | 'danger'
  bold?: boolean
  titleLines?: number
  subtitleLines?: number
  disabled?: boolean
  testID?: string
  children?: ReactNode
}) {
  const { c, t, m, wide } = useTheme()
  const color = props.tone === 'accent' ? c.accent : props.tone === 'danger' ? c.danger : c.ink
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: wide ? 10 : 12, minHeight: m.row, paddingHorizontal: m.rowX, paddingVertical: m.rowY }}>
      {props.leading}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof props.title === 'string' ? (
          <Text numberOfLines={props.titleLines} style={[props.bold ? t.headline : t.body, { color }]}>
            {props.title}
          </Text>
        ) : (
          props.title
        )}
        {typeof props.subtitle === 'string' ? (
          <Text numberOfLines={props.subtitleLines ?? 2} style={[t.subhead, { color: c.soft }]}>
            {props.subtitle}
          </Text>
        ) : (
          props.subtitle
        )}
        {props.children}
      </View>
      {typeof props.value === 'string' || typeof props.value === 'number' ? (
        <Text numberOfLines={1} style={[t.body, tabular, { color: c.soft, maxWidth: '55%' }]}>
          {props.value}
        </Text>
      ) : (
        props.value
      )}
      {props.trailing}
      {props.chevron ? <Ionicons name="chevron-forward" size={wide ? 13 : 16} color={c.faint} /> : null}
    </View>
  )
  if (!props.onPress) return <View testID={props.testID}>{body}</View>
  return (
    <Pressable
      testID={props.testID}
      role="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state: PressState) => ({ backgroundColor: state.pressed ? c.pressed : state.hovered ? c.hover : 'transparent', opacity: props.disabled ? 0.4 : 1 })}
    >
      {body}
    </Pressable>
  )
}

/** A row with a switch. */
export function SwitchRow(props: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; testID?: string }) {
  const { c, dark } = useTheme()
  return (
    <Row
      title={props.title}
      subtitle={props.subtitle}
      disabled={props.disabled}
      trailing={
        <Switch
          value={props.value}
          onValueChange={props.onChange}
          disabled={props.disabled}
          trackColor={{ true: c.okDot, false: dark ? c.thumb : c.fill }}
          thumbColor="#ffffff"
          // The web's switch has its own thumb colour when on (Material teal otherwise).
          {...(Platform.OS === 'web' ? ({ activeThumbColor: '#ffffff' } as object) : {})}
          testID={props.testID}
        />
      }
    />
  )
}

// --- buttons -------------------------------------------------------------------------------------

type Kind = 'filled' | 'tinted' | 'gray' | 'plain' | 'danger' | 'dangerFilled'

/** A button. Filled for a screen's main action; tinted or plain for the rest. Waits for async work. */
export function Button(props: { title: string; onPress: () => unknown; kind?: Kind; small?: boolean; disabled?: boolean; flex?: boolean; lines?: number; testID?: string }) {
  const { c, t, m, wide } = useTheme()
  const [busy, setBusy] = useState(false)
  const kind = props.kind ?? 'filled'
  const off = props.disabled || busy
  // Disabled filled buttons go grey, as the system's do; the others just fade.
  const greyed = props.disabled && !busy && (kind === 'filled' || kind === 'dangerFilled')
  const bg = greyed ? c.fill : { filled: c.accent, tinted: c.accentSoft, gray: c.fill, plain: 'transparent', danger: c.dangerSoft, dangerFilled: c.danger }[kind]
  const fg = greyed ? c.faint : { filled: c.accentInk, tinted: c.accent, gray: c.ink, plain: c.accent, danger: c.danger, dangerFilled: '#ffffff' }[kind]
  return (
    <Pressable
      testID={props.testID}
      role="button"
      aria-disabled={off}
      disabled={off}
      onPress={async () => {
        setBusy(true)
        try {
          await props.onPress()
        } finally {
          setBusy(false)
        }
      }}
      style={(state: PressState) => ({
        flex: props.flex ? 1 : undefined,
        minHeight: props.small ? m.buttonSmall : m.button,
        paddingHorizontal: kind === 'plain' ? 4 : props.small ? 12 : 18,
        borderRadius: props.small ? (wide ? 6 : 8) : wide ? 7 : 12,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: greyed ? 1 : off ? 0.4 : state.pressed ? 0.65 : state.hovered ? 0.85 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text numberOfLines={props.lines ?? 1} style={[props.small ? t.subhead : t.headline, { color: fg, fontWeight: '600', textAlign: 'center' }]}>
          {props.title}
        </Text>
      )}
    </Pressable>
  )
}

/**
 * A button for something you can't take back: it asks once more on itself, and the second tap
 * within a few seconds does it. Grey until then (`danger`: red from the start).
 */
export function ConfirmButton(props: { title: string; confirm: string; onConfirm: () => unknown; small?: boolean; flex?: boolean; danger?: boolean; testID?: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <Button
      testID={props.testID}
      small={props.small}
      flex={props.flex}
      kind={armed ? 'dangerFilled' : props.danger ? 'danger' : 'gray'}
      title={armed ? props.confirm : props.title}
      onPress={async () => {
        if (!armed) return setArmed(true)
        setArmed(false)
        await props.onConfirm()
      }}
    />
  )
}

/** A destructive row (red, on its own) that asks once more on itself. */
/** A row that asks once more before acting: red for what can't be undone, `accent` for the rest. */
export function ConfirmRow(props: { title: string; confirm: string; onConfirm: () => unknown; tone?: 'danger' | 'accent'; testID?: string }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <Row
      testID={props.testID}
      tone={props.tone ?? 'danger'}
      bold={armed}
      title={armed ? props.confirm : props.title}
      disabled={busy}
      trailing={busy ? <ActivityIndicator size="small" /> : undefined}
      onPress={async () => {
        if (!armed) return setArmed(true)
        setBusy(true)
        try {
          await props.onConfirm()
        } finally {
          setBusy(false)
          setArmed(false)
        }
      }}
    />
  )
}

/** One choice among a few, as a segmented control. Each segment's test id is `${testID}-${value}`. */
export function Segmented<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  const { c, t, wide } = useTheme()
  return (
    <View testID={props.testID} role="radiogroup" style={{ flexDirection: 'row', backgroundColor: c.fill, borderRadius: wide ? 7 : 9, padding: 2, gap: 2 }}>
      {props.options.map(o => {
        const on = o.value === props.value
        return (
          <Pressable
            key={o.value}
            testID={props.testID ? `${props.testID}-${o.value}` : undefined}
            role="radio"
            aria-checked={on}
            onPress={() => props.onChange(o.value)}
            style={{
              flex: 1,
              minHeight: wide ? 24 : 30,
              paddingHorizontal: 6,
              borderRadius: wide ? 5 : 7,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? c.thumb : 'transparent',
              shadowColor: c.shadow,
              shadowOpacity: on ? 0.1 : 0,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
              elevation: on ? 1 : 0,
            }}
          >
            <Text numberOfLines={1} style={[wide ? t.footnote : t.subhead, { color: c.ink, fontWeight: on ? '600' : '400' }]}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// --- fields --------------------------------------------------------------------------------------

const noOutline = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null

/** A text field that is a row of its group. `label` on its left, as in Settings. */
export function FieldRow(props: TextInputProps & { label?: string }) {
  const { c, t, m } = useTheme()
  const { label, style, ...rest } = props
  const input = (
    <TextInput
      placeholderTextColor={c.faint}
      {...rest}
      style={[t.body, { flex: 1, color: c.ink, minHeight: m.row, paddingVertical: m.rowY, textAlign: label ? 'right' : 'left' }, noOutline, style]}
    />
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: m.rowX }}>
      {label ? <Text style={[t.body, { color: c.ink }]}>{label}</Text> : null}
      {input}
    </View>
  )
}

/** Several lines of text, as a row of its group. */
export function TextArea(props: TextInputProps & { minHeight?: number }) {
  const { c, t, m } = useTheme()
  const { style, minHeight, ...rest } = props
  return (
    <TextInput
      multiline
      placeholderTextColor={c.faint}
      textAlignVertical="top"
      {...rest}
      style={[t.body, { color: c.ink, minHeight: minHeight ?? 120, paddingHorizontal: m.rowX, paddingVertical: m.rowY + 2 }, noOutline, style]}
    />
  )
}

// --- marks ---------------------------------------------------------------------------------------

/** A machine's or task's state: a small dot, slowly pulsing while something runs. */
export function StatusDot(props: { color: string; pulse?: boolean; size?: number }) {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!props.pulse) {
      opacity.setValue(1)
      return
    }
    const native = Platform.OS !== 'web'
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 1100, useNativeDriver: native }),
        Animated.timing(opacity, { toValue: 1, duration: 1100, useNativeDriver: native }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [props.pulse, opacity])
  const size = props.size ?? 8
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: props.color, opacity }} />
}

/** A count, in the accent: things that need you. */
export function Badge(props: { count: number; testID?: string }) {
  const { c, t } = useTheme()
  return (
    <View testID={props.testID} style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[t.caption, tabular, { color: c.accentInk, fontWeight: '700' }]}>{props.count}</Text>
    </View>
  )
}

/** A short line saying how something went: green when it worked, red when it didn't. */
export function Note(props: { ok?: boolean; text: string; testID?: string }) {
  const { c, t, m } = useTheme()
  return (
    <Text testID={props.testID} style={[t.footnote, { color: props.ok === false ? c.danger : props.ok ? c.ok : c.soft, paddingHorizontal: m.rowX }]}>
      {props.text}
    </Text>
  )
}

/** Nothing here (yet): a title, a line, and maybe the one thing to do about it. */
export function EmptyState(props: { title: string; text?: string; action?: ReactNode; testID?: string }) {
  const { c, t } = useTheme()
  return (
    <View testID={props.testID} style={{ alignItems: 'center', paddingVertical: 56, paddingHorizontal: 24, gap: 6 }}>
      <Text style={[t.headline, { color: c.ink, textAlign: 'center' }]}>{props.title}</Text>
      {props.text ? <Text style={[t.subhead, { color: c.soft, textAlign: 'center', maxWidth: 320 }]}>{props.text}</Text> : null}
      {props.action ? <View style={{ marginTop: 14 }}>{props.action}</View> : null}
    </View>
  )
}

/** Rows that are still loading: grey bars where the text will be. */
export function LoadingRows(props: { count?: number }) {
  const { c, m } = useTheme()
  const opacity = useRef(new Animated.Value(0.6)).current
  useEffect(() => {
    const native = Platform.OS !== 'web'
    const loop = Animated.loop(Animated.sequence([Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: native }), Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: native })]))
    loop.start()
    return () => loop.stop()
  }, [opacity])
  return (
    <Group>
      {Array.from({ length: props.count ?? 3 }, (_, i) => (
        <Animated.View key={i} style={{ paddingHorizontal: m.rowX, paddingVertical: m.rowY + 3, gap: 6, opacity }}>
          <View style={{ height: 10, width: `${60 - i * 12}%`, borderRadius: 5, backgroundColor: c.fill }} />
          <View style={{ height: 8, width: '35%', borderRadius: 4, backgroundColor: c.fill }} />
        </Animated.View>
      ))}
    </Group>
  )
}

export function Spinner() {
  const { c } = useTheme()
  return <ActivityIndicator color={c.soft} />
}
