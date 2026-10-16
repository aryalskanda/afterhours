// Claude writes Markdown. This reads it into a small tree (blocks of styled spans) that the app
// renders with its own components: headings, emphasis, code, lists, quotes, rules, tables, and
// images on the web (https only; shown when you ask).

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** http(s) links only. */
  href?: string
}

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'item'; depth: number; marker: string; spans: Span[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] }
  | { kind: 'image'; alt: string; src: string }

type Flags = Omit<Span, 'text'>

const EMPHASIS: { re: RegExp; flag: 'bold' | 'italic' | 'strike' }[] = [
  { re: /\*\*(?=\S)([^\n]*?\S)\*\*/, flag: 'bold' },
  { re: /(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/, flag: 'bold' },
  { re: /~~(?=\S)([^\n]*?\S)~~/, flag: 'strike' },
  { re: /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/, flag: 'italic' },
  { re: /(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/, flag: 'italic' },
]

const OPEN = ''
const CLOSE = ''

/** One paragraph's worth of inline Markdown, as spans. */
export function inline(text: string): Span[] {
  const saved: Span[] = []
  const keep = (span: Span) => `${OPEN}${saved.push(span) - 1}${CLOSE}`
  let s = text.replace(/[]/g, '')
  // Code first: nothing inside a code span is formatted. Then links.
  s = s.replace(/``(.+?)``/g, (_m, code: string) => keep({ text: code.trim(), code: true }))
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep({ text: code, code: true }))
  // An image inside a line of text is a link to it.
  s = s.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (_m, alt: string, href: string) => keep({ text: alt || 'image', href }))
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) => keep({ text: label, href }))
  const out: Span[] = []
  emphasis(s, {}, out, saved)
  return merge(out)
}

function emphasis(text: string, flags: Flags, out: Span[], saved: Span[]): void {
  let best: { m: RegExpExecArray; flag: 'bold' | 'italic' | 'strike' } | null = null
  for (const p of EMPHASIS) {
    const m = p.re.exec(text)
    if (m && (!best || m.index < best.m.index)) best = { m, flag: p.flag }
  }
  if (!best) {
    plain(text, flags, out, saved)
    return
  }
  plain(text.slice(0, best.m.index), flags, out, saved)
  emphasis(best.m[1]!, { ...flags, [best.flag]: true }, out, saved)
  emphasis(text.slice(best.m.index + best.m[0].length), flags, out, saved)
}

function plain(text: string, flags: Flags, out: Span[], saved: Span[]): void {
  for (const part of text.split(new RegExp(`(${OPEN}\\d+${CLOSE})`))) {
    if (!part) continue
    const m = new RegExp(`^${OPEN}(\\d+)${CLOSE}$`).exec(part)
    out.push(m ? { ...flags, ...saved[Number(m[1])]! } : { ...flags, text: part })
  }
}

/** Joins neighbours with the same style, so a renderer makes fewer pieces. */
function merge(spans: Span[]): Span[] {
  const out: Span[] = []
  const same = (a: Span, b: Span) => a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.strike === b.strike && a.href === b.href
  for (const s of spans) {
    const last = out.at(-1)
    if (last && same(last, s)) last.text += s.text
    else out.push({ ...s })
  }
  return out
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
}

/** A whole Markdown text, as blocks. */
export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', spans: inline(paragraph.join('\n')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!)
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush()
      const header = cells(line).map(inline)
      const rows: Span[][][] = []
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]!); i++) rows.push(cells(lines[i]!).map(inline))
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    const image = /^\s*!\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)\s*$/.exec(line)
    if (image) {
      flush()
      blocks.push({ kind: 'image', alt: image[1]!.trim(), src: image[2]! })
      i++
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: inline(heading[2]!) })
      i++
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      flush()
      const quoted: string[] = []
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ kind: 'quote', spans: inline(quoted.join('\n')) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      flush()
      const depth = Math.min(Math.floor(item[1]!.length / 2), 4)
      let rest = item[3]!
      let marker = /\d/.test(item[2]!) ? item[2]!.replace(')', '.') : depth === 0 ? '•' : '◦'
      const task = /^\[([ xX])\]\s+(.*)$/.exec(rest)
      if (task) {
        marker = task[1] === ' ' ? '☐' : '☑'
        rest = task[2]!
      }
      blocks.push({ kind: 'item', depth, marker, spans: inline(rest) })
      i++
      continue
    }
    if (line.trim() === '') flush()
    else paragraph.push(line.trim())
    i++
  }
  flush()
  return blocks
}

/** The text alone, for previews: "Steps 1. Add a theme store…". */
export function plainText(md: string): string {
  return parse(md)
    .map(b =>
      b.kind === 'code'
        ? b.text
        : b.kind === 'rule'
          ? ''
          : b.kind === 'image'
            ? b.alt
            : b.kind === 'table'
              ? b.rows.map(r => r.map(c => c.map(s => s.text).join('')).join(' · ')).join('\n')
              : b.spans.map(s => s.text).join(''),
    )
    .filter(Boolean)
    .join('\n')
}
