import { expect, test } from 'bun:test'
import { artifactLinks } from '../src/daemon/links'

test('artifact links in what Claude said: once each, with a markdown label as the title', () => {
  const a = 'https://claude.ai/artifact/abc-123'
  const b = 'https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789'
  expect(artifactLinks(`See [the new settings page](${a}). Also ${b}, and again ${a}.`)).toEqual([
    { url: a, title: 'the new settings page' },
    { url: b, title: null },
  ])
  expect(artifactLinks('https://claude.ai/chat/xyz and https://example.com/artifact/1')).toEqual([])
})
