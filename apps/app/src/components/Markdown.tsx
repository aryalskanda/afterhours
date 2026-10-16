// Claude's Markdown, drawn with the app's own type: headings, emphasis, code, lists, quotes and
// rules. Tables become one entry per row, which reads better on a phone than a squeezed grid.

import { useMemo } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { parse, type Span } from '../lib/markdown'
import { mono, useTheme } from '../theme'

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
        return (
          <ScrollView key={i} horizontal style={{ backgroundColor: c.fill, borderRadius: wide ? 6 : 8 }} contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}>
            <Text selectable style={{ fontFamily: mono, fontSize: t.subhead.fontSize, lineHeight: t.subhead.lineHeight, color: c.ink }}>
              {b.text}
            </Text>
          </ScrollView>
        )
      case 'quote':
        return (
          <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: 10 }}>
            <Spans spans={b.spans} soft />
          </View>
        )
      case 'rule':
        return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginVertical: 4 }} />
      case 'table':
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
