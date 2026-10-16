// Claude's Markdown, drawn with the app's own type: headings, emphasis, lists, quotes and rules;
// code a little coloured, with Copy; images from the web when you ask (never fetched by
// themselves). Tables are a grid in a wide window, and one entry per row on a phone, which reads
// better than a squeezed grid.

import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { useMemo, useState } from 'react'
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { desktop } from '../desktop'
import { highlight, type TokenKind } from '../lib/highlight'
import { parse, type Span } from '../lib/markdown'
import { mono, useTheme, type Colors } from '../theme'

const plainOf = (spans: Span[]) => spans.map(s => s.text).join('')

function tokenColor(c: Colors, kind: TokenKind): string {
  return { plain: c.ink, keyword: c.codeKeyword, string: c.codeString, comment: c.codeComment, number: c.codeNumber, added: c.added, removed: c.removed }[kind]
}

function CodeBlock(props: { lang: string; text: string }) {
  const { c, t, wide } = useTheme()
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(() => highlight(props.text, props.lang), [props.text, props.lang])
  return (
    <View style={{ backgroundColor: c.fill, borderRadius: wide ? 6 : 8, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingTop: 6 }}>
        <Text style={[t.caption, { color: c.faint }]}>{props.lang}</Text>
        <Pressable
          role="button"
          aria-label={copied ? 'Copied' : 'Copy the code'}
          hitSlop={10}
          onPress={async () => {
            await Clipboard.setStringAsync(props.text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          testID="code-copy"
        >
          <Text style={[t.caption, { color: c.soft, fontWeight: '600' }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 10, paddingTop: 2, paddingBottom: 8 }}>
        <Text selectable style={{ fontFamily: mono, fontSize: t.subhead.fontSize, lineHeight: t.subhead.lineHeight, color: c.ink }}>
          {tokens.map((tk, i) =>
            tk.kind === 'plain' ? (
              tk.text
            ) : (
              <Text key={i} style={{ color: tokenColor(c, tk.kind) }}>
                {tk.text}
              </Text>
            ),
          )}
        </Text>
      </ScrollView>
    </View>
  )
}

/** A wide window's table: columns as wide as their text needs, within reason. */
function Grid(props: { header: Span[][]; rows: Span[][][] }) {
  const { c, t } = useTheme()
  const columns = Math.max(props.header.length, ...props.rows.map(r => r.length))
  const widths = Array.from({ length: columns }, (_, k) => {
    const longest = Math.max(plainOf(props.header[k] ?? []).length, ...props.rows.map(r => plainOf(r[k] ?? []).length))
    return Math.min(320, Math.max(80, longest * 7.5 + 24))
  })
  const row = (cells: Span[][], r: number, head: boolean) => (
    <View key={r} style={{ flexDirection: 'row', borderTopWidth: r === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.line, backgroundColor: head ? c.fill : undefined }}>
      {widths.map((w, k) => (
        <Text key={k} selectable style={[t.subhead, { width: w, paddingHorizontal: 8, paddingVertical: 5, color: c.ink, fontWeight: head ? '600' : '400' }]}>
          {plainOf(cells[k] ?? [])}
        </Text>
      ))}
    </View>
  )
  return (
    <ScrollView horizontal style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: 6 }} testID="md-grid">
      <View>
        {row(props.header, 0, true)}
        {props.rows.map((r, i) => row(r, i + 1, false))}
      </View>
    </ScrollView>
  )
}

/**
 * An image from the web: shown when you ask (fetching it tells its site you're reading). The
 * desktop app doesn't load web images at all: it opens them in the browser.
 */
function WebImage(props: { alt: string; src: string }) {
  const { c, t, wide } = useTheme()
  const [shown, setShown] = useState(false)
  const [failed, setFailed] = useState(false)
  const [ratio, setRatio] = useState(16 / 9)
  let host = props.src
  try {
    host = new URL(props.src).host
  } catch {}
  if (shown && !failed && !desktop) {
    return (
      <Image
        source={{ uri: props.src }}
        accessibilityLabel={props.alt || 'An image'}
        resizeMode="contain"
        onLoad={e => {
          const s = (e.nativeEvent as { source?: { width?: number; height?: number } }).source
          if (s?.width && s.height) setRatio(s.width / s.height)
        }}
        onError={() => setFailed(true)}
        style={{ width: '100%', aspectRatio: ratio, borderRadius: wide ? 6 : 8, backgroundColor: c.fill }}
      />
    )
  }
  const open = Boolean(desktop) || failed
  return (
    <Pressable
      role="button"
      aria-label={`${open ? 'Open' : 'Show'} the image ${props.alt}`}
      onPress={() => (open ? void Linking.openURL(props.src) : setShown(true))}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: wide ? 6 : 8, backgroundColor: c.fill, opacity: pressed ? 0.6 : 1 })}
      testID="md-image"
    >
      <Ionicons name="image-outline" size={18} color={c.soft} />
      <Text numberOfLines={1} style={[t.subhead, { flex: 1, color: c.ink }]}>
        {props.alt || 'Image'} <Text style={{ color: c.soft }}>· {host}</Text>
      </Text>
      <Text style={[t.subhead, { color: c.accent, fontWeight: '600' }]}>{failed ? 'Couldn’t load: Open' : open ? 'Open' : 'Show'}</Text>
    </Pressable>
  )
}

function Spans(props: { spans: Span[]; heading?: 1 | 2 | 3; soft?: boolean }) {
  const { c, t } = useTheme()
  const base = props.heading === 1 ? t.title : props.heading ? t.headline : t.body
  return (
    <Text selectable style={[base, { color: props.soft ? c.soft : c.ink }]}>
      {props.spans.map((s, i) => (
        <Text
          key={i}
          onPress={s.href ? () => void Linking.openURL(s.href!) : undefined}
          style={{
            fontWeight: s.bold ? '600' : undefined,
            fontStyle: s.italic ? 'italic' : undefined,
            textDecorationLine: s.strike ? 'line-through' : s.href ? 'underline' : undefined,
            color: s.href ? c.accent : undefined,
            fontFamily: s.code ? mono : undefined,
            fontSize: s.code ? (base.fontSize ?? 15) - 2 : undefined,
            backgroundColor: s.code ? c.fill : undefined,
          }}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * `onBlockPress`: a tap on a heading, paragraph or list item hands over its text (a plan's step,
 * to quote when asking for changes).
 */
export function Markdown(props: { text: string; onBlockPress?: (text: string) => void }) {
  const { c, t, wide } = useTheme()
  const blocks = useMemo(() => parse(props.text), [props.text])
  const press = props.onBlockPress
  return (
    <View style={{ gap: wide ? 8 : 10 }}>
      {blocks.map((b, i) => {
        const node = block(b, i)
        if (!press || !(b.kind === 'heading' || b.kind === 'paragraph' || b.kind === 'item')) return node
        const text = b.spans.map(s => s.text).join('')
        return (
          <Pressable key={i} onPress={() => press(text)} role="button" aria-label={`Quote: ${text}`} testID={`quote-${i}`} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
            {node}
          </Pressable>
        )
      })}
    </View>
  )

  function block(b: ReturnType<typeof parse>[number], i: number) {
    switch (b.kind) {
      case 'heading':
        return (
          <View key={i} style={{ marginTop: i === 0 ? 0 : 6 }}>
            <Spans spans={b.spans} heading={b.level <= 1 ? 1 : b.level === 2 ? 2 : 3} />
          </View>
        )
      case 'paragraph':
        return <Spans key={i} spans={b.spans} />
      case 'item':
        return (
          <View key={i} style={{ flexDirection: 'row', paddingLeft: b.depth * 18, gap: 8 }}>
            <Text style={[t.body, { color: c.soft, minWidth: 14 }]}>{b.marker === '•' || b.marker === '-' || b.marker === '*' ? '•' : b.marker}</Text>
            <View style={{ flex: 1 }}>
              <Spans spans={b.spans} />
            </View>
          </View>
        )
      case 'code':
        return <CodeBlock key={i} lang={b.lang} text={b.text} />
      case 'image':
        return <WebImage key={i} alt={b.alt} src={b.src} />
      case 'quote':
        return (
          <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: 10 }}>
            <Spans spans={b.spans} soft />
          </View>
        )
      case 'rule':
        return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 }} />
      case 'table':
        if (wide) return <Grid key={i} header={b.header} rows={b.rows} />
        return (
          <View key={i}>
            {b.rows.map((row, r) => (
              <View key={r} style={{ paddingVertical: 6, gap: 1, borderTopWidth: r === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.line }}>
                <Text selectable style={[t.body, { color: c.ink, fontWeight: '600' }]}>
                  {(row[0] ?? []).map(s => s.text).join('')}
                </Text>
                {row.slice(1).map((cell, k) =>
                  cell.length > 0 ? (
                    <Text key={k} selectable style={[t.subhead, { color: c.soft }]}>
                      {(b.header[k + 1] ?? []).map(s => s.text).join('')}: <Text style={{ color: c.ink }}>{cell.map(s => s.text).join('')}</Text>
                    </Text>
                  ) : null,
                )}
              </View>
            ))}
          </View>
        )
    }
  }
}
