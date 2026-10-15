import { describe, expect, test } from 'bun:test'
import { htmlToText, inlineMarkdown, markdownParts, markdownToHtml, splitMarkdown, telegramHtmlProblem } from '../src/telegram/markdown'

describe('Markdown → Telegram HTML', () => {
  test('inline: bold, italic, code, links, strikethrough', () => {
    expect(inlineMarkdown('**bold** and *it* and _it_ and `x < y` and ~~old~~')).toBe(
      '<b>bold</b> and <i>it</i> and <i>it</i> and <code>x &lt; y</code> and <s>old</s>',
    )
    expect(inlineMarkdown('see [the docs](https://example.com/a?b=1&c=2)')).toBe('see <a href="https://example.com/a?b=1&amp;c=2">the docs</a>')
  })

  test('code and identifiers are left alone', () => {
    expect(inlineMarkdown('`**not bold**`')).toBe('<code>**not bold**</code>')
    expect(inlineMarkdown('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
    expect(inlineMarkdown('a [link](javascript:alert(1))')).toBe('a [link](javascript:alert(1))')
  })

  test('crossed emphasis falls back to plain text instead of bad nesting', () => {
    const html = inlineMarkdown('**bold *both** italic*')
    expect(telegramHtmlProblem(html)).toBeNull()
    expect(htmlToText(html)).toContain('bold')
  })

  test('escapes everything that is not formatting', () => {
    expect(markdownToHtml('a < b & c > d <script>')).toBe('a &lt; b &amp; c &gt; d &lt;script&gt;')
  })

  test('blocks: headings, lists, tasks, quotes, rules, code', () => {
    const md = [
      '## Plan',
      '',
      '- first **step**',
      '  - nested',
      '1. one',
      '- [ ] todo',
      '- [x] done',
      '',
      '> quoted *text*',
      '',
      '---',
      '```ts',
      'const a = 1 < 2',
      '```',
    ].join('\n')
    expect(markdownToHtml(md)).toBe(
      [
        '<b>Plan</b>',
        '',
        '• first <b>step</b>',
        '   ◦ nested',
        '1. one',
        '☐ todo',
        '☑ done',
        '',
        '<blockquote>quoted <i>text</i></blockquote>',
        '',
        '──────────',
        '<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>',
      ].join('\n'),
    )
  })

  test('a narrow table stays a table; a wide one becomes one entry per row', () => {
    const narrow = markdownToHtml('| a | b |\n|---|---|\n| 1 | 22 |')
    expect(narrow).toStartWith('<pre>')
    expect(htmlToText(narrow)).toContain('1 │ 22')
    const wide = markdownToHtml(
      '| Step | What | Gate |\n| --- | --- | --- |\n| 0. Validate | Landing page, demo video, waitlist, launch posts | About 300 sign-ups |',
    )
    expect(wide).toBe('• <b>0. Validate</b>\n   What: Landing page, demo video, waitlist, launch posts\n   Gate: About 300 sign-ups')
  })

  test('an unclosed code fence still renders as code', () => {
    expect(markdownToHtml('```\nunfinished')).toBe('<pre>unfinished</pre>')
  })
})

describe('splitting', () => {
  test('parts render within the limit and keep code blocks whole', () => {
    const para = (n: number) => `Paragraph ${n}: ${'words '.repeat(60)}`
    const code = ['```', ...Array.from({ length: 120 }, (_, i) => `line ${i} of the code block`), '```'].join('\n')
    const md = [para(1), para(2), code, para(3), '| a | b |\n|---|---|\n| 1 | 2 |'].join('\n\n')
    const parts = markdownParts(md, 1500)
    expect(parts.length).toBeGreaterThan(2)
    for (const html of parts) {
      expect(telegramHtmlProblem(html)).toBeNull()
      expect(htmlToText(html).length).toBeLessThanOrEqual(1500)
    }
    // Every line of the code block arrives, inside <pre>.
    const all = parts.join('\n')
    for (let i = 0; i < 120; i++) expect(all).toContain(`line ${i} of the code block`)
    expect(parts.filter(p => p.includes('<pre>')).length).toBeGreaterThan(1)
  })

  test('short text is one part', () => {
    expect(splitMarkdown('hello', 100)).toEqual(['hello'])
  })
})

describe('Telegram HTML check', () => {
  test('catches what Telegram refuses', () => {
    expect(telegramHtmlProblem('<b>ok</b> <i>fine</i>')).toBeNull()
    expect(telegramHtmlProblem('<b><i>x</b></i>')).toContain('wrong tag')
    expect(telegramHtmlProblem('<div>x</div>')).toContain("isn't allowed")
    expect(telegramHtmlProblem('a & b')).toBe('a bare &')
    expect(telegramHtmlProblem('<code><b>x</b></code>')).toContain('inside <code>')
    expect(telegramHtmlProblem('<b>open')).toContain('never closed')
  })

  test('whatever Claude writes comes out valid', () => {
    const pieces = ['**', '*', '_', '__', '`', '```', '~~', '[', ']', '(', ')', 'https://x.io/a_b', '<', '>', '&', '#', '- ', '1. ', '> ', '|', '---', '\n', '\n\n', ' ', 'word', 'snake_case', 'ünïcödé', '😀']
    let seed = 42
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let n = 0; n < 2000; n++) {
      const md = Array.from({ length: 5 + Math.floor(random() * 40) }, () => pieces[Math.floor(random() * pieces.length)]).join('')
      for (const html of [markdownToHtml(md), ...markdownParts(md, 200)]) {
        const problem = telegramHtmlProblem(html)
        if (problem) throw new Error(`${problem}\nmarkdown: ${JSON.stringify(md)}\nhtml: ${JSON.stringify(html)}`)
      }
    }
  })
})
