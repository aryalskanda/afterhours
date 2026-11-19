// Claude Code as set up on this machine, for apps: the account (owners only), the MCP servers by
// name (never their commands, URLs or keys), and a folder's CLAUDE.md.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeInfo } from '@afterhours/protocol'

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function servers(raw: unknown, scope: ClaudeInfo['mcp'][number]['scope']): ClaudeInfo['mcp'] {
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, { type?: unknown; url?: unknown }>).map(([name, s]) => ({
    name,
    scope,
    type: typeof s?.type === 'string' ? s.type : typeof s?.url === 'string' ? 'http' : 'stdio',
  }))
}

/**
 * Which Claude account Claude Code is signed in to: a stable id (the account's uuid, else the
 * organization's), never the email. Null when signed out or unreadable (an API key needs no account).
 */
export function claudeAccount(claudeJson: string): string | null {
  const account = (readJson(claudeJson)?.oauthAccount ?? null) as { accountUuid?: unknown; organizationUuid?: unknown } | null
  const id = account?.accountUuid ?? account?.organizationUuid
  return typeof id === 'string' && id ? id : null
}

/** When Claude Code last fetched the signed-in account's profile (it does at sign-in); null if unknown. */
export function claudeProfileAt(claudeJson: string): number | null {
  const at = ((readJson(claudeJson)?.oauthAccount ?? null) as { profileFetchedAt?: unknown } | null)?.profileFetchedAt
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/**
 * Whether Claude Code is signed in to another account than the last time this looked, remembering
 * the account (as a stable id) in `kv`. On the very first look there's nothing to compare with, so
 * a usage-limit block read before this account's profile was fetched counts as a switch: it came
 * from the account before.
 */
export function accountSwitched(o: {
  claudeJson: string
  kv: { get(key: string): unknown; set(key: string, value: unknown): void }
  now: number
}): boolean {
  const now = claudeAccount(o.claudeJson)
  if (!now) return false // signed out, or an API key: nothing to compare
  const before = o.kv.get('claude.account')
  if (before === now) return false
  o.kv.set('claude.account', now)
  if (before) return true
  const limits = (o.kv.get('limits') ?? {}) as { blockedUntil?: number | null; updatedAt?: number }
  const signedIn = claudeProfileAt(o.claudeJson)
  return (limits.blockedUntil ?? 0) > o.now && signedIn !== null && (limits.updatedAt ?? 0) < signedIn
}

/** Biggest CLAUDE.md sent to an app. */
const MAX_MEMORY = 200_000

export function claudeInfo(o: { claudeJson: string; folder: string | null; owner: boolean; version: string | null }): ClaudeInfo {
  const config = readJson(o.claudeJson) ?? {}
  const projects = (config.projects ?? {}) as Record<string, { mcpServers?: unknown }>
  const mcp = [
    ...servers(config.mcpServers, 'user'),
    ...(o.folder ? servers(projects[o.folder]?.mcpServers, 'local') : []),
    ...(o.folder ? servers(readJson(join(o.folder, '.mcp.json'))?.mcpServers, 'project') : []),
  ]
  let memory: ClaudeInfo['memory'] = null
  if (o.folder) {
    const path = join(o.folder, 'CLAUDE.md')
    const exists = existsSync(path)
    let text: string | undefined
    if (exists) {
      try {
        text = readFileSync(path, 'utf8').slice(0, MAX_MEMORY)
      } catch {
        text = undefined
      }
    }
    memory = { path, exists, ...(text !== undefined ? { text } : {}) }
  }
  const account = config.oauthAccount as { emailAddress?: unknown; organizationName?: unknown } | undefined
  return {
    version: o.version,
    ...(o.owner
      ? { account: account ? { email: typeof account.emailAddress === 'string' ? account.emailAddress : null, organization: typeof account.organizationName === 'string' ? account.organizationName : null } : null }
      : {}),
    mcp,
    memory,
  }
}
