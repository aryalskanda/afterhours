import { describe, expect, test } from 'bun:test'
import { inline, parse, plainText } from './markdown'

describe('inline Markdown', () => {
  test('bold, italic, code, links and strikethrough', () => {
    expect(inline('**bold** and *it* and `x < y` and [docs](https://ex.com/a_b) and ~~old~~')).toEqual([
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'it', italic: true },
      { text: ' and ' },
      { text: 'x < y', code: true },
      { text: ' and ' },
      { text: 'docs', href: 'https://ex.com/a_b' },
      { text: ' and ' },
      { text: 'old', strike: true },
    ])
  })

  test('emphasis nests, and code and identifiers are left alone', () => {
    expect(inline('**bold with *italic* inside**')).toEqual([
      { text: 'bold with ', bold: true },
      { text: 'italic', bold: true, italic: true },
      { text: ' inside', bold: true },
    ])
    expect(inline('`**raw**` and snake_case_name and 2*3*4')).toEqual([{ text: '**raw**', code: true }, { text: ' and snake_case_name and 2*3*4' }])
    expect(inline('[x](javascript:alert(1))')).toEqual([{ text: '[x](javascript:alert(1))' }])
  })
})

describe('blocks', () => {
  test('headings, paragraphs, lists, tasks, quotes, rules and code', () => {
    const blocks = parse(['## Plan', 'First line', 'second line', '', '- one', '  - nested', '1. first', '- [x] done', '> quoted', '---', '```ts', 'const a = 1', '```'].join('\n'))
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'item', 'item', 'item', 'item', 'quote', 'rule', 'code'])
    expect(blocks[1]).toEqual({ kind: 'paragraph', spans: [{ text: 'First line\nsecond line' }] })
    expect(blocks.slice(2, 6).map(b => (b.kind === 'item' ? [b.depth, b.marker] : null))).toEqual([[0, '•'], [1, '◦'], [0, '1.'], [0, '☑']])
    expect(blocks[8]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1' })
  })

  test('tables, and an unclosed code fence', () => {
    const [table] = parse('| Step | Gate |\n| --- | --- |\n| **0** | 300 sign-ups |')
    expect(table).toEqual({ kind: 'table', header: [[{ text: 'Step' }], [{ text: 'Gate' }]], rows: [[[{ text: '0', bold: true }], [{ text: '300 sign-ups' }]]] })
    expect(parse('```\nunfinished')).toEqual([{ kind: 'code', lang: '', text: 'unfinished' }])
  })

  test('plain text for previews', () => {
    expect(plainText('## Steps\n1. Add a **theme** store\n2. Wire the `ThemeToggle`')).toBe('Steps\nAdd a theme store\nWire the ThemeToggle')
  })
})
