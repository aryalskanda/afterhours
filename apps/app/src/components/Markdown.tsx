// Claude's Markdown, drawn with the app's own components (headings, emphasis, code, lists,
// quotes, rules; tables as one entry per row, which reads better on a phone).

import { useMemo } from 'react'
import { Linking, ScrollView, Text, View } from 'react-native'
import { parse, type Span } from '../lib/markdown'
import { mono, radius, space, useColors } from '../theme'

function Spans(props: { spans: Span[]; size?: number; bold?: boolean }) {
  const c = useColors()
  return (
    <Text selectable style={{ color: c.ink, fontSize: props.size ?? 15, lineHeight: (props.size ?? 15) * 1.45, fontWeight: props.bold ? '700' : '400' }}>
      {props.spans.map((s, i) => (
        <Text
          key={i}
          onPress={s.href ? () => void Linking.openURL(s.href!) : undefined}
          style={{
            fontWeight: s.bold || props.bold ? '700' : undefined,
            fontStyle: s.italic ? 'italic' : undefined,
            textDecorationLine: s.strike ? 'line-through' : s.href ? 'underline' : undefined,
            color: s.href ? c.accent : undefined,
            fontFamily: s.code ? mono : undefined,
            backgroundColor: s.code ? c.code : undefined,
            fontSize: s.code ? (props.size ?? 15) - 1 : undefined,
          }}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

export function Markdown(props: { text: string }) {
  const c = useColors()
  const blocks = useMemo(() => parse(props.text), [props.text])
  return (
    <View style={{ gap: space.s }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <View key={i} style={{ marginTop: i === 0 ? 0 : space.xs }}>
                <Spans spans={b.spans} size={b.level <= 1 ? 20 : b.level === 2 ? 18 : 16} bold />
              </View>
            )
          case 'paragraph':
            return <Spans key={i} spans={b.spans} />
          case 'item':
            return (
              <View key={i} style={{ flexDirection: 'row', paddingLeft: b.depth * 16, gap: space.s }}>
                <Text style={{ color: c.soft, fontSize: 15, lineHeight: 21, minWidth: 16 }}>{b.marker}</Text>
                <View style={{ flex: 1 }}>
                  <Spans spans={b.spans} />
                </View>
              </View>
            )
          case 'code':
            return (
              <ScrollView key={i} horizontal style={{ backgroundColor: c.code, borderRadius: radius.s }} contentContainerStyle={{ padding: space.m }}>
                <Text selectable style={{ fontFamily: mono, fontSize: 13, lineHeight: 18, color: c.ink }}>
                  {b.text}
                </Text>
              </ScrollView>
            )
          case 'quote':
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: c.line, paddingLeft: space.m }}>
                <Spans spans={b.spans} />
              </View>
            )
          case 'rule':
            return <View key={i} style={{ height: 1, backgroundColor: c.line, marginVertical: space.xs }} />
          case 'table':
            return (
              <View key={i} style={{ gap: space.s }}>
                {b.rows.map((row, r) => (
                  <View key={r} style={{ borderWidth: 1, borderColor: c.line, borderRadius: radius.s, padding: space.m, gap: 4 }}>
                    <Spans spans={row[0] ?? []} bold />
                    {row.slice(1).map((cell, k) =>
                      cell.length > 0 ? (
                        <Text key={k} style={{ color: c.soft, fontSize: 14 }}>
                          {(b.header[k + 1] ?? []).map(s => s.text).join('')}: <Spans spans={cell} size={14} />
                        </Text>
                      ) : null,
                    )}
                  </View>
                ))}
              </View>
            )
        }
      })}
    </View>
  )
}
