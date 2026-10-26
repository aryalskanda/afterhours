// The slash commands and skills a folder's tasks can use: the project's (.claude/commands,
// .claude/skills, here or at the repo's top) and yours (~/.claude). Names as you'd type them.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SlashCommand } from '@afterhours/protocol'

/** The description from a markdown file's front matter, else its first line of text. */
export function describe(text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)
  const fromFront = front ? /^description:\s*["']?(.+?)["']?\s*$/m.exec(front[1]!)?.[1] : undefined
  const body = front ? text.slice(front[0].length) : text
  const line = body.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(l => l.length > 0) ?? ''
  const d = (fromFront ?? line).trim()
  return d.length > 140 ? `${d.slice(0, 139)}…` : d
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 8192)
  } catch {
    return ''
  }
}

function commandsIn(dir: string, scope: SlashCommand['scope']): SlashCommand[] {
  const out: SlashCommand[] = []
  const walk = (at: string, depth: number) => {
    if (depth > 3) return
    let names: string[]
    try {
      // Sorted: a directory's own order differs between systems (macOS's is alphabetical, Linux's isn't).
      names = readdirSync(at).sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(at, name)
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) walk(path, depth + 1)
      else if (name.endsWith('.md')) {
        const rel = relative(dir, path).slice(0, -3)
        out.push({ name: rel.split('/').join(':'), description: describe(read(path)), scope, kind: 'command' })
      }
    }
  }
  walk(dir, 0)
  return out
}

function skillsIn(dir: string, scope: SlashCommand['scope']): SlashCommand[] {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names
    .filter(n => existsSync(join(dir, n, 'SKILL.md')))
    .map(n => {
      const text = read(join(dir, n, 'SKILL.md'))
      const named = /^---\n[\s\S]*?^name:\s*["']?(.+?)["']?\s*$[\s\S]*?\n---/m.exec(text)?.[1]
      return { name: named ?? n, description: describe(text), scope, kind: 'skill' as const }
    })
}

/** Everything `/` can start in this folder, the project's first; one name appears once. */
export function slashCommands(folder: string, top: string | null, claudeDir: string): SlashCommand[] {
  const roots = [...new Set([folder, ...(top ? [top] : [])])]
  const all = [
    ...roots.flatMap(r => [...commandsIn(join(r, '.claude', 'commands'), 'project'), ...skillsIn(join(r, '.claude', 'skills'), 'project')]),
    ...commandsIn(join(claudeDir, 'commands'), 'user'),
    ...skillsIn(join(claudeDir, 'skills'), 'user'),
  ]
  const seen = new Set<string>()
  return all.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true))).slice(0, 200)
}
