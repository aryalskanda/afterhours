// Claude Code's own "stop asking" choices for a permission prompt (its `permission_suggestions`):
// which of them an app may apply, and what each says in words. Applying one returns it to Claude
// Code in the hook's `updatedPermissions`, so Claude Code writes the rule itself.

import { isAbsolute, relative } from 'node:path'

/** One of Claude Code's permission updates, as its hooks see them. */
export interface PermissionUpdate {
  type: string
  rules?: { toolName: string; ruleContent?: string }[]
  behavior?: string
  destination?: string
  mode?: string
  directories?: string[]
}

/** At most this many choices are offered. */
const MAX = 4

function isUpdate(v: unknown): v is PermissionUpdate {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'
}

/**
 * The suggestions an app may apply: allow rules, accepting edits, and extra folders inside the ones
 * the machine shares. Never a mode that skips prompts, never a deny rule, never a folder outside.
 */
export function usableSuggestions(raw: unknown, inside: (dir: string) => boolean): PermissionUpdate[] {
  if (!Array.isArray(raw)) return []
  const out: PermissionUpdate[] = []
  for (const s of raw) {
    if (!isUpdate(s)) continue
    if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length > 0 && s.rules.every(r => typeof r?.toolName === 'string')) out.push(s)
    else if (s.type === 'setMode' && s.mode === 'acceptEdits') out.push(s)
    else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length > 0 && s.directories.every(d => typeof d === 'string' && inside(d))) out.push(s)
    if (out.length === MAX) break
  }
  return out
}

function where(destination: string | undefined): string {
  switch (destination) {
    case 'session':
      return ' for the rest of this task'
    case 'localSettings':
      return ' in this project'
    case 'projectSettings':
      return ' in this project, for everyone on it'
    case 'userSettings':
      return ' in every project'
    default:
      return ''
  }
}

/** "npm test:*" → "commands starting with npm test"; an exact command stays as it is. */
function bashRule(content: string): string {
  const prefix = /^(.*?):\*$/.exec(content)
  return prefix ? `commands starting with ${prefix[1]}` : `the command ${content}`
}

function ruleWords(r: { toolName: string; ruleContent?: string }, cwd: string | null): string {
  const content = r.ruleContent?.trim()
  if (!content) return r.toolName === 'Edit' || r.toolName === 'Write' ? 'edits' : r.toolName
  switch (r.toolName) {
    case 'Bash':
      return bashRule(content)
    case 'WebFetch':
      return content.startsWith('domain:') ? `fetching from ${content.slice(7)}` : `fetching ${content}`
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = content.replace(/^\/\//, '/')
      const rel = cwd ? relative(cwd, path).replace(/\\/g, '/') : ''
      const shown = cwd && isAbsolute(path) && !rel.startsWith('..') && !isAbsolute(rel) ? rel || 'this folder' : path
      return `${r.toolName === 'Read' ? 'reading' : 'editing'} ${shown}`
    }
    default:
      return `${r.toolName} ${content}`
  }
}

/** What applying the update does, in words a person reads on a lock screen. */
export function suggestionLabel(s: PermissionUpdate, cwd: string | null = null): string {
  if (s.type === 'setMode') return 'Accept edits from now on'
  if (s.type === 'addDirectories') return `Allow ${s.directories!.join(', ')}${where(s.destination)}`
  const rules = (s.rules ?? []).map(r => ruleWords(r, cwd))
  return `Always allow ${rules.join(' and ')}${where(s.destination)}`
}
