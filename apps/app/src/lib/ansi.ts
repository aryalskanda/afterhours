// A terminal's colour codes (SGR) turned into styled runs of text, one list per line. Everything
// else (cursor moves, titles) is dropped.

export interface Run {
  text: string
  fg?: number | string
  bg?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

type Style = Omit<Run, 'text'>

/** xterm's 256 colours past the first 16: a 6×6×6 cube, then greys. */
function color256(n: number): number | string {
  if (n < 16) return n
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`
}

function apply(style: Style, codes: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) Object.keys(s).forEach(k => delete s[k as keyof Style])
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 22) {
      delete s.bold
      delete s.dim
    } else if (c === 23) delete s.italic
    else if (c === 24) delete s.underline
    else if (c === 27) delete s.inverse
    else if (c >= 30 && c <= 37) s.fg = c - 30
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8
    else if (c === 39) delete s.fg
    else if (c >= 40 && c <= 47) s.bg = c - 40
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8
    else if (c === 49) delete s.bg
    else if ((c === 38 || c === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      s[c === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]!)
      i += 2
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
      s[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`
      i += 4
    }
  }
  return s
}

// SGR sequences we read, and the other escape sequences we drop.
const ESCAPES = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g

/** Lines of styled runs; adjacent text with the same style is one run. */
export function parseAnsi(text: string): Run[][] {
  const lines: Run[][] = []
  let style: Style = {}
  for (const line of text.split('\n')) {
    const runs: Run[] = []
    let last = 0
    const push = (t: string) => {
      if (!t) return
      const prev = runs[runs.length - 1]
      if (prev && JSON.stringify({ ...prev, text: '' }) === JSON.stringify({ ...style, text: '' })) prev.text += t
      else runs.push({ ...style, text: t })
    }
    for (const m of line.matchAll(ESCAPES)) {
      push(line.slice(last, m.index))
      last = m.index! + m[0].length
      if (m[1] !== undefined) style = apply(style, m[1] === '' ? [0] : m[1].split(';').map(Number))
    }
    push(line.slice(last))
    lines.push(runs)
  }
  return lines
}

/** The text without any escape codes. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, '')
}
