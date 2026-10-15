// The app's building blocks: screens, cards, buttons, pills, fields and switches, in the theme.

import { useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { MAX_WIDTH, radius, space, type as T, useColors } from '../theme'

export function Screen(props: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; padded?: boolean; testID?: string }) {
  const c = useColors()
  return (
    <ScrollView
      testID={props.testID}
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ alignItems: 'center', paddingBottom: space.xxl }}
      keyboardShouldPersistTaps="handled"
      refreshControl={props.onRefresh ? <RefreshControl refreshing={props.refreshing ?? false} onRefresh={props.onRefresh} tintColor={c.accent} /> : undefined}
    >
      <View style={{ width: '100%', maxWidth: MAX_WIDTH, padding: props.padded === false ? 0 : space.l, gap: space.l }}>{props.children}</View>
    </ScrollView>
  )
}

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accent?: boolean; testID?: string }) {
  const c = useColors()
  const style = [
    { backgroundColor: c.card, borderRadius: radius.l, borderWidth: props.accent ? 2 : StyleSheet.hairlineWidth, borderColor: props.accent ? c.accent : c.line, padding: space.l, gap: space.m },
    props.style,
  ]
  if (!props.onPress) return <View style={style} testID={props.testID}>{props.children}</View>
  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => [...style, pressed && { opacity: 0.7 }]} role="button" testID={props.testID}>
      {props.children}
    </Pressable>
  )
}

export function Section(props: { title: string; right?: ReactNode; children: ReactNode }) {
  const c = useColors()
  return (
    <View style={{ gap: space.s }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xs }}>
        <Text style={[T.tiny, { color: c.faint, fontWeight: '600', textTransform: 'uppercase' }]}>{props.title}</Text>
        {props.right}
      </View>
      {props.children}
    </View>
  )
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button(props: {
  title: string
  onPress: () => unknown
  kind?: ButtonKind
  disabled?: boolean
  small?: boolean
  flex?: boolean
  testID?: string
}) {
  const c = useColors()
  const [busy, setBusy] = useState(false)
  const kind = props.kind ?? 'primary'
  const bg = { primary: c.accent, secondary: 'transparent', danger: c.dangerSoft, ghost: 'transparent' }[kind]
  const fg = { primary: c.accentInk, secondary: c.ink, danger: c.danger, ghost: c.accent }[kind]
  const border = kind === 'secondary' ? c.line : 'transparent'
  const off = props.disabled || busy
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
      style={({ pressed }) => ({
        flex: props.flex ? 1 : undefined,
        minHeight: props.small ? 34 : 46,
        paddingHorizontal: props.small ? space.m : space.l,
        borderRadius: radius.pill,
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: off ? 0.5 : pressed ? 0.75 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: props.small ? 14 : 16, textAlign: 'center' }}>{props.title}</Text>}
    </Pressable>
  )
}

/** A destructive action that asks once more on the button itself (no pop-ups, which the web lacks). */
export function ConfirmButton(props: { title: string; confirm: string; onConfirm: () => unknown; small?: boolean; testID?: string }) {
  const [armed, setArmed] = useState(false)
  return (
    <Button
      testID={props.testID}
      small={props.small}
      kind={armed ? 'danger' : 'secondary'}
      title={armed ? props.confirm : props.title}
      onPress={async () => {
        if (!armed) {
          setArmed(true)
          setTimeout(() => setArmed(false), 4000)
          return
        }
        await props.onConfirm()
      }}
    />
  )
}

export function Row(props: { children: ReactNode; gap?: number; wrap?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: props.gap ?? space.s, flexWrap: props.wrap ? 'wrap' : 'nowrap' }, props.style]}>{props.children}</View>
}

export function Label(props: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number; selectable?: boolean; testID?: string }) {
  const c = useColors()
  return (
    <Text selectable={props.selectable} numberOfLines={props.numberOfLines} style={[T.body, { color: c.ink }, props.style]} testID={props.testID}>
      {props.children}
    </Text>
  )
}

export function Soft(props: { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number; testID?: string }) {
  const c = useColors()
  return (
    <Text numberOfLines={props.numberOfLines} style={[T.small, { color: c.soft }, props.style]} testID={props.testID}>
      {props.children}
    </Text>
  )
}

export function Title(props: { children: ReactNode; numberOfLines?: number }) {
  const c = useColors()
  return (
    <Text numberOfLines={props.numberOfLines} style={[T.heading, { color: c.ink }]}>
      {props.children}
    </Text>
  )
}

export function Pill(props: { text: string; tone?: 'accent' | 'ok' | 'danger' | 'plain' }) {
  const c = useColors()
  const tone = props.tone ?? 'plain'
  const bg = { accent: c.accentSoft, ok: c.okSoft, danger: c.dangerSoft, plain: c.raised }[tone]
  const fg = { accent: c.accent, ok: c.ok, danger: c.danger, plain: c.soft }[tone]
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={[T.tiny, { color: fg, fontWeight: '600' }]}>{props.text}</Text>
    </View>
  )
}

export function Dot(props: { color: string; size?: number }) {
  const size = props.size ?? 9
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: props.color }} />
}

export function Field(props: TextInputProps & { label?: string }) {
  const c = useColors()
  const { label, style, ...rest } = props
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Soft>{label}</Soft> : null}
      <TextInput
        placeholderTextColor={c.faint}
        {...rest}
        style={[
          T.body,
          {
            color: c.ink,
            backgroundColor: c.card,
            borderColor: c.line,
            borderWidth: 1,
            borderRadius: radius.m,
            paddingHorizontal: space.m,
            paddingVertical: space.m,
            minHeight: props.multiline ? 110 : 46,
            textAlignVertical: props.multiline ? 'top' : 'center',
          },
          style,
        ]}
      />
    </View>
  )
}

/** One choice among a few, as a row of pills. */
export function Choice<T extends string>(props: { options: { value: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }} testID={props.testID}>
      {props.options.map(o => {
        const on = o.value === props.value
        return (
          <Pressable
            key={o.value}
            testID={props.testID ? `${props.testID}-${o.value}` : undefined}
            role="radio"
            aria-checked={on}
            onPress={() => props.onChange(o.value)}
            style={{ borderRadius: radius.pill, borderWidth: 1, borderColor: on ? c.accent : c.line, backgroundColor: on ? c.accentSoft : c.card, paddingHorizontal: space.m, paddingVertical: 7 }}
          >
            <Text style={{ color: on ? c.accent : c.ink, fontWeight: on ? '600' : '400', fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Toggle(props: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean; testID?: string }) {
  const c = useColors()
  return (
    <Row style={{ justifyContent: 'space-between', opacity: props.disabled ? 0.5 : 1 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Label>{props.label}</Label>
        {props.hint ? <Soft>{props.hint}</Soft> : null}
      </View>
      <Switch value={props.value} onValueChange={props.onChange} disabled={props.disabled} trackColor={{ true: c.accent, false: c.line }} testID={props.testID} />
    </Row>
  )
}

export function Empty(props: { title: string; text?: string; children?: ReactNode }) {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: space.xxl }}>
      <Title>{props.title}</Title>
      {props.text ? <Soft style={{ textAlign: 'center' }}>{props.text}</Soft> : null}
      {props.children}
    </Card>
  )
}

/** A short line saying how a request went: green when it worked, red when it didn't. */
export function Outcome(props: { ok: boolean; text: string }) {
  const c = useColors()
  return <Text style={[T.small, { color: props.ok ? c.ok : c.danger }]}>{props.text}</Text>
}

export function Spinner() {
  const c = useColors()
  return <ActivityIndicator color={c.accent} />
}
