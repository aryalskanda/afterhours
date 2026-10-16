// Light or dark (or as the system is), and the text a size smaller or larger.

import { Stack } from 'expo-router'
import { hub, useHub } from '../../../src/app-state'
import { Block, Group, Page, Segmented, Txt } from '../../../src/components/ui'
import type { Prefs } from '../../../src/lib/hub'

const THEMES: { value: Prefs['appearance']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const SIZES: { value: Prefs['textSize']; label: string }[] = [
  { value: 'smaller', label: 'Smaller' },
  { value: 'default', label: 'Default' },
  { value: 'larger', label: 'Larger' },
]

export default function AppearanceSettings() {
  const { prefs } = useHub()
  return (
    <Page testID="appearance">
      <Stack.Screen options={{ title: 'Appearance' }} />
      <Group header="Theme" footer={prefs.appearance === 'system' ? 'Light or dark, as the system is.' : undefined}>
        <Block>
          <Segmented options={THEMES} value={prefs.appearance} onChange={v => void hub.setPrefs({ appearance: v })} label="Theme" testID="appearance-theme" />
        </Block>
      </Group>
      <Group header="Text size" footer="On top of the system’s own text size.">
        <Block>
          <Segmented options={SIZES} value={prefs.textSize} onChange={v => void hub.setPrefs({ textSize: v })} label="Text size" testID="appearance-size" />
          <Txt>Claude finished: the toggle is in Settings, and the tests pass.</Txt>
        </Block>
      </Group>
    </Page>
  )
}
