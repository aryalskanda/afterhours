// The models offered for new tasks: the ones Claude Code itself lists for this account, so a new
// model shows up in the bot and the apps without anyone editing config.json. Claude Code is asked
// the way its SDK asks: started with no prompt, sent one `initialize` request, and stopped once it
// answers. Nothing is sent to a model, so it uses none of the limit.

import { homedir } from 'node:os'
import { cleanEnv, type Config } from '../shared/config'

/** How long Claude Code gets to answer. */
const TIMEOUT_MS = 15_000
/** Asked again this often, and whenever Claude Code's version changes. */
const REFRESH_MS = 6 * 3600_000

const INITIALIZE = JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n'

/**
 * The short model names in Claude Code's answer to `initialize`: "opus", "sonnet", "fable"…, in
 * its order. Not "default" (it's one of the others), and not the pinned older versions
 * ("claude-opus-4-8"): those can still be typed, or added to `models` in config.json. Null when
 * the line isn't that answer.
 */
export function modelsFromInitialize(line: string): string[] | null {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return null
  }
  const m = message as { type?: unknown; response?: { subtype?: unknown; response?: { models?: unknown } } }
  if (m?.type !== 'control_response' || m.response?.subtype !== 'success') return null
  const models = m.response.response?.models
  if (!Array.isArray(models)) return null
  const names = models
    .map(x => (x as { value?: unknown })?.value)
    .filter((v): v is string => typeof v === 'string' && /^[a-z]+$/.test(v) && v !== 'default')
  return names.length > 0 ? [...new Set(names)] : null
}

/** Asks Claude Code for its models. Null when it can't say (too old, not signed in, too slow). */
export async function detectModels(claudePath: string, timeoutMs = TIMEOUT_MS): Promise<string[] | null> {
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    proc = Bun.spawn([claudePath, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      cwd: homedir(),
      env: cleanEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const child = proc
    // Stdin stays open: closed, Claude Code would take it as the end of the conversation and exit.
    const stdin = child.stdin as { write(data: string): unknown; flush(): unknown }
    stdin.write(INITIALIZE)
    stdin.flush()
    const answer = async (): Promise<string[] | null> => {
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true })
        let newline: number
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (line.includes('"control_response"')) return modelsFromInitialize(line)
        }
      }
      return null
    }
    // Not only a kill at the time limit: something it started can hold its output open.
    const tooSlow = new Promise<null>(done => {
      timer = setTimeout(() => done(null), timeoutMs)
    })
    return await Promise.race([answer(), tooSlow])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
    try {
      proc?.kill()
    } catch {
      // Already gone.
    }
  }
}

/**
 * What's offered: Claude Code's own models first, then any added in config.json (a pinned
 * version, say), then the defaults. Without an answer from Claude Code it's the config's list.
 */
export function offeredModels(config: Pick<Config, 'models' | 'defaults'>, found: string[] | null = detected): string[] {
  return [...new Set([...(found ?? []), ...config.models, config.defaults.model, ...(config.defaults.workModel ? [config.defaults.workModel] : [])])]
}

let detected: string[] | null = null

/** For tests: what Claude Code is taken to have said. */
export function setDetectedModels(models: string[] | null): void {
  detected = models
}

/**
 * Asks now, and again every six hours and when Claude Code's version changes (`version` is asked
 * every ten minutes). An attempt that fails keeps the last answer.
 */
export function watchModels(o: { claudePath: string; version: () => string | null; log: (line: string) => void }): { stop: () => void } {
  let askedAt = 0
  let askedVersion: string | null = null
  let busy = false
  const refresh = async () => {
    if (busy) return
    busy = true
    try {
      askedAt = Date.now()
      askedVersion = o.version()
      const found = await detectModels(o.claudePath)
      if (!found) {
        o.log(detected ? 'models: Claude Code gave no list; keeping the last one' : 'models: Claude Code gave no list; offering the ones in config.json')
        return
      }
      if (found.join() !== detected?.join()) o.log(`models: Claude Code offers ${found.join(', ')}`)
      detected = found
    } finally {
      busy = false
    }
  }
  void refresh()
  const timer = setInterval(() => {
    if (Date.now() - askedAt >= REFRESH_MS || o.version() !== askedVersion) void refresh()
  }, 600_000)
  return { stop: () => clearInterval(timer) }
}
