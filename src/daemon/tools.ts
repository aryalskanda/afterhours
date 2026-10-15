// One line saying what a tool call does, for a phone: the command, the file, the search. Paths
// inside the task's folder are shown relative to it.

import { relative } from 'node:path'

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function firstLine(text: string, max = 200): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function shortPath(path: string, cwd?: string | null): string {
  if (!cwd) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : path
}

/** `mcp__github__create_issue` → `github · create_issue`. */
export function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} · ${m[2]}` : name
}

export function toolSummary(name: string, input: unknown, cwd?: string | null): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return firstLine(str(i.command) ?? '', 300)
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return path ? shortPath(path, cwd) : ''
    case 'Grep': {
      const where = path ? ` in ${shortPath(path, cwd)}` : str(i.glob) ? ` in ${str(i.glob)}` : ''
      return `${str(i.pattern) ?? ''}${where}`
    }
    case 'Glob':
      return `${str(i.pattern) ?? ''}${path ? ` in ${shortPath(path, cwd)}` : ''}`
    case 'WebFetch':
      return str(i.url) ?? ''
    case 'WebSearch':
      return str(i.query) ?? ''
    case 'Task':
    case 'Agent':
      return [str(i.subagent_type), str(i.description)].filter(Boolean).join(': ')
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos.length : 0
      return `${todos} to-do${todos === 1 ? '' : 's'}`
    }
    case 'ExitPlanMode':
      return 'The plan is ready'
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: unknown } | undefined) : undefined
      return firstLine(str(q?.question) ?? '')
    }
    default: {
      // MCP and anything new: the first text argument says the most.
      const text = Object.values(i).map(str).find(Boolean)
      return text ? firstLine(text) : ''
    }
  }
}
