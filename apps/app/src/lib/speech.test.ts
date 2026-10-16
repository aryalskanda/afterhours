import { expect, test } from 'bun:test'
import { speakable } from './speech'

test('Markdown read aloud: marks, links and code go', () => {
  expect(speakable('## Done\n\nThe toggle is in **Settings → Appearance**.\n\n- Theme store: `src/theme.ts`\n- [Docs](https://x.dev)\n\n```ts\nconst a = 1\n```')).toBe(
    'Done\n\nThe toggle is in Settings to Appearance.\n\nTheme store: src/theme.ts\nDocs\n\n (a code block)',
  )
})
