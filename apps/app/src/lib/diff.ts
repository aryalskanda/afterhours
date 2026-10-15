// A unified diff as lines to draw: hunk headers, context, additions and removals, each with its
// line number in the old and the new file.

export interface DiffLine {
  kind: 'hunk' | 'ctx' | 'add' | 'del' | 'note'
  text: string
  old: number | null
  new: number | null
}

/** Lines after the file header (`diff --git`, `index`, `---`, `+++`), numbered from each hunk. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      out.push({ kind: 'hunk', text: hunk[3]!.trim(), old: null, new: null })
      continue
    }
    if (!inHunk) {
      // The header: say what happened to the file when git says it in words.
      if (/^(new file|deleted file|rename from|rename to|Binary files)/.test(line)) out.push({ kind: 'note', text: line, old: null, new: null })
      continue
    }
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), old: null, new: newNo++ })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), old: oldNo++, new: null })
    else if (line.startsWith('\\')) out.push({ kind: 'note', text: line.slice(2), old: null, new: null })
    else out.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ })
  }
  return out
}
