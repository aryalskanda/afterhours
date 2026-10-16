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
