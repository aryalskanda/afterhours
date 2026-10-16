// Code in Claude's answers, a little coloured: keywords, strings, comments and numbers, for the
// languages Claude writes most; diffs get their added and removed lines. Anything else stays plain.

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'added' | 'removed'

export interface Token {
  text: string
  kind: TokenKind
}

interface Grammar {
  keywords: Set<string>
  /** Line comments ("//", "#"), and whether block comments are C-style. */
  line: string[]
  block: boolean
  /** Triple-quoted strings (Python). */
  triple: boolean
  /** Template literals (JavaScript). */
  backtick: boolean
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const C_LIKE = 'if else for while do switch case default break continue return function class extends new this super import export from as const let var try catch finally throw typeof instanceof in of void delete yield async await static public private protected interface type enum implements readonly true false null undefined'

const GRAMMARS: Record<string, Grammar> = {
  js: { keywords: words(C_LIKE), line: ['//'], block: true, triple: false, backtick: true },
  ts: { keywords: words(`${C_LIKE} declare namespace abstract keyof infer satisfies is never unknown any string number boolean`), line: ['//'], block: true, triple: false, backtick: true },
  py: { keywords: words('def class if elif else for while return import from as with try except finally raise lambda yield pass break continue in is not and or None True False async await global nonlocal assert del'), line: ['#'], block: false, triple: true, backtick: false },
  sh: { keywords: words('if then else elif fi for while until do done case esac in function return local export source exit set unset echo cd'), line: ['#'], block: false, triple: false, backtick: false },
  go: { keywords: words('package import func return if else for range switch case default break continue go defer select chan map struct interface type var const nil true false'), line: ['//'], block: true, triple: false, backtick: true },
  rust: { keywords: words('fn let mut pub use mod struct enum impl trait for in if else match loop while return break continue as ref move where self Self crate super async await unsafe dyn const static true false Some None Ok Err'), line: ['//'], block: true, triple: false, backtick: false },
  c: { keywords: words(`${C_LIKE} int char float double long short unsigned signed struct union typedef sizeof include define ifndef endif fun val var when object data sealed override open lateinit func guard let struct protocol extension init deinit nil self Self`), line: ['//'], block: true, triple: false, backtick: false },
  json: { keywords: words('true false null'), line: [], block: false, triple: false, backtick: false },
  css: { keywords: words('important media import from to'), line: [], block: true, triple: false, backtick: false },
  sql: { keywords: words('select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as and or not null primary key references'), line: ['--'], block: true, triple: false, backtick: false },
}

const ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', tsx: 'ts', python: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  golang: 'go', rs: 'rust', cpp: 'c', 'c++': 'c', h: 'c', java: 'c', kotlin: 'c', kt: 'c', swift: 'c', cs: 'c', csharp: 'c', scss: 'css', jsonc: 'json',
  postgres: 'sql', sqlite: 'sql', mysql: 'sql',
}

/** The grammar for a fence's language, if it has one. */
function grammarFor(lang: string): Grammar | null {
  const l = lang.toLowerCase()
  return GRAMMARS[ALIASES[l] ?? l] ?? null
}

function push(out: Token[], text: string, kind: TokenKind): void {
  if (!text) return
  const last = out.at(-1)
  if (last && last.kind === kind) last.text += text
  else out.push({ text, kind })
}

/** Code as tokens, line breaks kept. Unknown languages come back as one plain token. */
export function highlight(code: string, lang: string): Token[] {
  const l = lang.toLowerCase()
  if (l === 'diff' || l === 'patch') {
    const out: Token[] = []
    code.split('\n').forEach((line, i) => {
      if (i > 0) push(out, '\n', 'plain')
      push(out, line, line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : 'plain')
    })
    return out
  }
  const g = grammarFor(l)
  if (!g) return code ? [{ text: code, kind: 'plain' }] : []
  const out: Token[] = []
  let i = 0
  const n = code.length
  const sql = g === GRAMMARS.sql
  while (i < n) {
    const rest = code.slice(i)
    const lineComment = g.line.find(p => rest.startsWith(p))
    // `#` starts a comment in shell only at a word's start ($#, a#b aren't comments).
    if (lineComment && !(lineComment === '#' && g === GRAMMARS.sh && i > 0 && !/\s/.test(code[i - 1]!))) {
      const end = code.indexOf('\n', i)
      const stop = end < 0 ? n : end
      push(out, code.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (g.block && rest.startsWith('/*')) {
      const end = code.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      push(out, code.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (g.triple && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const q = rest.slice(0, 3)
      const end = code.indexOf(q, i + 3)
      const stop = end < 0 ? n : end + 3
      push(out, code.slice(i, stop), 'string')
      i = stop
      continue
    }
    const ch = code[i]!
    if (ch === '"' || ch === "'" || (ch === '`' && g.backtick)) {
      let j = i + 1
      while (j < n && code[j] !== ch && !(code[j] === '\n' && ch !== '`')) j += code[j] === '\\' ? 2 : 1
      // Closed: up to its quote. Left open: up to the end of the line.
      const stop = Math.min(n, code[j] === ch ? j + 1 : j)
      push(out, code.slice(i, stop), 'string')
      i = stop
      continue
    }
    const num = /^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(rest)
    if (num && (i === 0 || !/[\w$]/.test(code[i - 1]!))) {
      push(out, num[0], 'number')
      i += num[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      push(out, word[0], g.keywords.has(sql ? word[0].toLowerCase() : word[0]) ? 'keyword' : 'plain')
      i += word[0].length
      continue
    }
    push(out, ch, 'plain')
    i++
  }
  return out
}
