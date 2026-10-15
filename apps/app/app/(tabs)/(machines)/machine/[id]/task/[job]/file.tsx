// A file as the task left it (or as it is now, while the task runs): numbered lines, or the image.

import { Stack, useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'
import { FlatList, Image, ScrollView, Text, View } from 'react-native'
import { EmptyState, LoadingRows, Note, Txt } from '../../../../../../../src/components/ui'
import { useLoad } from '../../../../../../../src/components/useLoad'
import { basename } from '../../../../../../../src/lib/format'
import { FilesResult } from '../../../../../../../src/lib/results'
import { mono, useTheme } from '../../../../../../../src/theme'

export default function FileScreen() {
  const { id, job, path } = useLocalSearchParams<{ id: string; job: string; path: string }>()
  const { c, t, m, wide } = useTheme()
  const { data, error } = useLoad(id, path ? { type: 'files', job: Number(job), path, read: true } : null, FilesResult, `${job}:${path}`, { timeoutMs: 60_000 })
  const file = data?.file
  const lines = useMemo(() => (file?.kind === 'text' && file.text !== undefined ? file.text.replace(/\n$/, '').split('\n') : []), [file])
  const size = wide ? 12 : 12.5
  const lineHeight = wide ? 17 : 18
  const gutter = String(lines.length).length * 8 + 14

  const header = (
    <View style={{ paddingHorizontal: m.pageX, paddingTop: 14, paddingBottom: 10, gap: 6 }}>
      <Text selectable style={{ fontFamily: mono, fontSize: t.footnote.fontSize, color: c.soft }}>
        {path}
      </Text>
      {error ? <Note ok={false} text={error} /> : null}
      {!data && !error ? <LoadingRows count={4} /> : null}
      {file?.truncated ? <Txt v="footnote" tone="soft">{file.kind === 'image' ? 'Too big to show here.' : 'A long file: this is its first part.'}</Txt> : null}
      {file?.kind === 'binary' ? <Txt tone="soft">A binary file.</Txt> : null}
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.page }} testID="file">
      <Stack.Screen options={{ title: path ? basename(path) : 'File' }} />
      {!id ? <EmptyState title="Not found" text="That file isn’t here." /> : null}
      {file?.kind === 'image' && file.base64 ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
          {header}
          <View style={{ paddingHorizontal: m.pageX }}>
            <Image
              source={{ uri: `data:${file.mime};base64,${file.base64}` }}
              style={{ width: '100%', aspectRatio: 1, borderRadius: m.radius, backgroundColor: c.fill }}
              resizeMode="contain"
              accessibilityLabel={basename(path ?? '')}
            />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={lines}
          keyExtractor={(_, i) => String(i)}
          ListHeaderComponent={header}
          ListFooterComponent={<View style={{ height: 48 }} />}
          style={{ backgroundColor: file?.kind === 'text' ? c.group : c.page }}
          initialNumToRender={80}
          renderItem={({ item, index }) => (
            <View style={{ flexDirection: 'row' }}>
              <Text style={{ width: gutter, textAlign: 'right', paddingRight: 10, fontFamily: mono, fontSize: size - 2, lineHeight, color: c.faint }}>{index + 1}</Text>
              <Text selectable style={{ flex: 1, fontFamily: mono, fontSize: size, lineHeight, color: c.ink, paddingRight: 10 }}>
                {item || ' '}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  )
}
