// Claude writes Markdown; Telegram shows a small HTML subset. This turns one into the other.
// Everything is escaped first and only Telegram's tags come out, properly nested. A line whose
// emphasis can't be nested cleanly falls back to plain text, so Telegram never rejects a message
// for its formatting.

/** Telegram's limit for one message, counted after formatting is applied. */
export const TELEGRAM_MAX = 4096

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const OPEN = ''
const CLOSE = ''
const SAVED = /(\d+)/g

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/g, '<b>$1</b>')
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, '<i>$1</i>')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '<s>$1</s>')
}

/** Whether b/i/s tags open and close in order (the only ones `emphasis` makes). */
function nested(html: string): boolean {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([bis])>/g)) {
    if (!m[1]) stack.push(m[2]!)
    else if (stack.pop() !== m[2]) return false
  }
  return stack.length === 0
}

/** One line of Markdown: code spans, links, bold, italic, strikethrough. */
export function inlineMarkdown(text: string): string {
  const saved: string[] = []
  const keep = (html: string) => `${OPEN}${saved.push(html) - 1}${CLOSE}`
  let s = text.replace(/[]/g, '')
  // Code first: nothing inside a code span is formatted.
  s = s.replace(/``(.+?)``/g, (_m, code: string) => keep(`<code>${esc(code.trim())}</code>`))
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${esc(code)}</code>`))
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => keep(`<a href="${esc(url).replace(/"/g, '%22')}">${esc(label)}</a>`))
  const plain = esc(s)
  const styled = emphasis(plain)
  return (nested(styled) ? styled : plain).replace(SAVED, (_m, i: string) => saved[Number(i)]!)
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

function plainCell(cell: string): string {
  return cell.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

/** A table: aligned in monospace when it fits a phone, else one entry per row. */
function table(lines: string[]): string {
  const header = cells(lines[0]!)
  const rows = lines.slice(2).map(cells)
  const widths = header.map((h, k) => Math.max(plainCell(h).length, ...rows.map(r => plainCell(r[k] ?? '').length)))
  if (widths.reduce((a, b) => a + b, 0) + 3 * (widths.length - 1) <= 40) {
    const line = (r: string[]) => r.map((c, k) => plainCell(c).padEnd(widths[k]!)).join(' │ ').trimEnd()
    return `<pre>${esc([line(header), widths.map(w => '─'.repeat(w)).join('─┼─'), ...rows.map(line)].join('\n'))}</pre>`
  }
  return rows
    .map(r => {
      const rest = r
        .slice(1)
        .map((c, k) => (c ? `\n   ${esc(plainCell(header[k + 1] ?? ''))}: ${inlineMarkdown(c)}` : ''))
        .join('')
      return `• <b>${inlineMarkdown(r[0] ?? '')}</b>${rest}`
    })
    .join('\n')
}

/** Markdown → Telegram HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[1]!
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(close); i++) body.push(lines[i]!)
      i++
      const code = esc(body.join('\n'))
      out.push(fence[2] ? `<pre><code class="language-${esc(fence[2])}">${code}</code></pre>` : `<pre>${code}</pre>`)
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const start = i
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]!); i++);
      out.push(table(lines.slice(start, i)))
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      out.push(`<b>${inlineMarkdown(heading[1]!)}</b>`)
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────')
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = []
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''))
      out.push(`<blockquote>${quoted.map(inlineMarkdown).join('\n')}</blockquote>`)
      continue
    }
    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line)
    if (item) {
      const depth = Math.min(Math.floor(item[1]!.length / 2), 4)
      let rest = item[3]!
      let marker = /\d/.test(item[2]!) ? item[2]!.replace(')', '.') : depth === 0 ? '•' : '◦'
      const task = /^\[([ xX])\]\s+(.*)$/.exec(rest)
      if (task) {
        marker = task[1] === ' ' ? '☐' : '☑'
        rest = task[2]!
      }
      out.push(`${'   '.repeat(depth)}${marker} ${inlineMarkdown(rest)}`)
      i++
      continue
    }
    // One blank line between paragraphs is enough.
    if (line.trim() !== '' || (out.length > 0 && out.at(-1) !== '')) out.push(inlineMarkdown(line))
    i++
  }
  return out.join('\n').trim()
}

/** The text a message shows, without tags: what Telegram's length limit counts. */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** Markdown as clean text, for short excerpts: no #, ** or backticks, lists with • bullets. */
export function markdownToPlain(md: string): string {
  return htmlToText(markdownToHtml(md))
}

/** Splits text at paragraph, then line, then word breaks, into pieces of at most `max` characters. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find(i => i > max / 2) ?? max
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Markdown in blocks: a code fence, a table, or a paragraph (lines up to a blank one). */
function blocks(md: string): string[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let current: string[] = []
  const flush = () => {
    if (current.length) out.push(current.join('\n'))
    current = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const block = [line]
      for (i++; i < lines.length; i++) {
        block.push(lines[i]!)
        if (lines[i]!.trim().startsWith(fence[1]!)) break
      }
      out.push(block.join('\n'))
      continue
    }
    if (line.trim() === '') flush()
    else current.push(line)
  }
  flush()
  return out
}

const rendered = (md: string) => htmlToText(markdownToHtml(md)).length

/** A block too long for one message, cut into pieces that each render within `max`. */
function cutBlock(block: string, max: number): string[] {
  const fence = FENCE.exec(block)
  if (fence) {
    const lines = block.split('\n')
    const open = lines[0]!
    const body = lines.slice(1, lines.length - (lines.at(-1)!.trim().startsWith(fence[1]!) ? 1 : 0))
    const close = fence[1]!
    return splitText(body.join('\n'), max - 10).map(piece => `${open}\n${piece}\n${close}`)
  }
  return splitText(block, max)
}

/**
 * Markdown cut into parts that each render within `max` characters, at block boundaries: a code
 * block that has to be cut is closed and opened again, so every part is complete on its own.
 */
export function splitMarkdown(md: string, max: number): string[] {
  const parts: string[] = []
  let current = ''
  for (const block of blocks(md).flatMap(b => (rendered(b) > max ? cutBlock(b, max) : [b]))) {
    const joined = current ? `${current}\n\n${block}` : block
    if (current && rendered(joined) > max) {
      parts.push(current)
      current = block
    } else {
      current = joined
    }
  }
  if (current) parts.push(current)
  return parts
}

/** Markdown rendered as Telegram messages, each within `max` characters. */
export function markdownParts(md: string, max: number): string[] {
  return splitMarkdown(md, max).map(markdownToHtml)
}

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span'])

/**
 * Why Telegram would refuse this HTML, or null if it's fine: only its tags, properly nested, no
 * stray < > &, and no formatting inside code.
 */
export function telegramHtmlProblem(html: string): string | null {
  const stack: string[] = []
  const tag = /<(\/?)([a-z-]+)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/gi
  let last = 0
  for (const m of html.matchAll(tag)) {
    const between = html.slice(last, m.index)
    if (/[<>]/.test(between)) return `stray < or > before ${m[0]}`
    if (/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(between)) return 'a bare &'
    last = m.index! + m[0].length
    const name = m[2]!.toLowerCase()
    if (!ALLOWED.has(name)) return `<${name}> isn't allowed`
    if (!m[1]) {
      const inside = stack.at(-1)
      if (inside === 'code' || (inside === 'pre' && name !== 'code')) return `<${name}> inside <${inside}>`
      if (name === 'a' && stack.includes('a')) return '<a> inside <a>'
      if (name === 'blockquote' && stack.includes('blockquote')) return 'nested <blockquote>'
      if (name === 'pre' && stack.length > 0) return `<pre> inside <${inside}>`
      stack.push(name)
    } else if (stack.pop() !== name) {
      return `</${name}> closes the wrong tag`
    }
  }
  const tail = html.slice(last)
  if (/[<>]/.test(tail)) return 'stray < or >'
  if (/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(tail)) return 'a bare &'
  return stack.length > 0 ? `<${stack.at(-1)}> is never closed` : null
}
