import { describe, expect, test } from 'bun:test'
import { parseAnsi, stripAnsi } from './ansi'
import { parsePatch } from './diff'
import { money, tokens } from './format'

describe('terminal colours', () => {
  test('colours, bold and resets become styled runs; other escapes go', () => {
    const lines = parseAnsi('\x1b[1;32m✓\x1b[0m 12 passed \x1b[2m(3s)\x1b[22m\n\x1b[31mFAIL\x1b[39m orders\x1b[K\r')
    expect(lines).toEqual([
      [{ text: '✓', bold: true, fg: 2 }, { text: ' 12 passed ' }, { text: '(3s)', dim: true }],
      [{ text: 'FAIL', fg: 1 }, { text: ' orders' }],
    ])
  })

  test('256 and true colours; a style carries over to the next line', () => {
    expect(parseAnsi('\x1b[38;5;196mred\x1b[48;2;10;20;30m on\nnext')).toEqual([
      [{ text: 'red', fg: 'rgb(255,0,0)' }, { text: ' on', fg: 'rgb(255,0,0)', bg: 'rgb(10,20,30)' }],
      [{ text: 'next', fg: 'rgb(255,0,0)', bg: 'rgb(10,20,30)' }],
    ])
    expect(parseAnsi('\x1b[38;5;244mgrey')[0]![0]!.fg).toBe('rgb(128,128,128)')
    expect(stripAnsi('\x1b]0;title\x07\x1b[1mbold\x1b[m')).toBe('bold')
  })
})

describe('diffs', () => {
  test('lines numbered in the old and the new file', () => {
    const patch = [
      'diff --git a/orders.ts b/orders.ts',
      'index 1a2b..3c4d 100644',
      '--- a/orders.ts',
      '+++ b/orders.ts',
      '@@ -1,3 +1,4 @@ export const orders',
      ' a',
      '-b',
      '+B',
      '+c',
      ' d',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: 'export const orders', old: null, new: null },
      { kind: 'ctx', text: 'a', old: 1, new: 1 },
      { kind: 'del', text: 'b', old: 2, new: null },
      { kind: 'add', text: 'B', old: null, new: 2 },
      { kind: 'add', text: 'c', old: null, new: 3 },
      { kind: 'ctx', text: 'd', old: 3, new: 4 },
      { kind: 'note', text: 'No newline at end of file', old: null, new: null },
    ])
  })

  test('what git says about the file itself', () => {
    expect(parsePatch('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n')).toEqual([
      { kind: 'note', text: 'new file mode 100644', old: null, new: null },
      { kind: 'hunk', text: '', old: null, new: null },
      { kind: 'add', text: 'hi', old: null, new: 1 },
    ])
    expect(parsePatch('diff --git a/l.png b/l.png\nBinary files a/l.png and b/l.png differ\n')).toEqual([{ kind: 'note', text: 'Binary files a/l.png and b/l.png differ', old: null, new: null }])
  })
})

test('tokens and money, short', () => {
  expect([tokens(950), tokens(1234), tokens(45_600), tokens(3_400_000), tokens(2_000_000)]).toEqual(['950', '1.2k', '46k', '3.4M', '2M'])
  expect([money(0.4213), money(0.004), money(0), money(312.4)]).toEqual(['$0.42', '<$0.01', '$0.00', '$312'])
})
