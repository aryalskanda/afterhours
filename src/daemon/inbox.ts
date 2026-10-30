import { readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { CLAUDE_DIR, type LiveSession } from './sessions'

export interface Delivery {
  /** The message was written to the session's inbox. Whether Claude acts on it shows in its transcript. */
  ok: boolean
  /** What the session answered on the connection, if anything (for the log). */
  reply?: string
  error?: string
}

/** The token a session publishes so other processes on this Mac can authenticate to its inbox. */
export function peerToken(pid: number, claudeDir = CLAUDE_DIR): string | null {
  try {
    const dir = join(claudeDir, 'sessions')
    const file = readdirSync(dir).find(f => f.startsWith(`${pid}.`) && f.endsWith('.key'))
    if (!file) return null
    const key = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { peerToken?: unknown }
    return typeof key.peerToken === 'string' ? key.peerToken : null
  } catch {
    return null
  }
}

/**
 * Posts `text` into a running Claude Code session through its inbox socket, in the form Claude
 * Code's own log gives for it: an auth line (optional on macOS), then one user-message line.
 * Claude reads it as a message from another session (input, not authority), so it suits
 * "continue" after a usage limit, not prompts that should count as yours.
 */
export function deliverToInbox(
  session: Pick<LiveSession, 'pid' | 'messagingSocketPath'>,
  text: string,
  o: { claudeDir?: string; waitMs?: number } = {},
): Promise<Delivery> {
  const path = session.messagingSocketPath
  if (!path) return Promise.resolve({ ok: false, error: 'that session has no inbox' })
  const token = peerToken(session.pid, o.claudeDir)
  const payload =
    [...(token ? [JSON.stringify({ type: 'auth', token })] : []), JSON.stringify({ type: 'user', message: { role: 'user', content: text } })].join('\n') +
    '\n'
  return new Promise(resolve => {
    let reply = ''
    let settled = false
    const finish = (d: Delivery) => {
      if (settled) return
      settled = true
      resolve(d)
    }
    const answered = () => ({ ok: true, ...(reply.trim() ? { reply: reply.trim().slice(0, 500) } : {}) })
    // Windows: the inbox is a named pipe (\\.\pipe\…), which node:net reaches and Bun.connect doesn't.
    if (process.platform === 'win32') {
      const sock = connect(path)
      sock.on('connect', () => {
        sock.write(payload)
        setTimeout(() => {
          sock.end()
          finish(answered())
        }, o.waitMs ?? 1000)
      })
      sock.on('data', data => (reply += data.toString('utf8')))
      sock.on('close', () => finish(answered()))
      sock.on('error', err => finish({ ok: false, error: err.message }))
      return
    }
    Bun.connect({
      unix: path,
      socket: {
        open(sock) {
          sock.write(payload)
          // Give the session a moment to answer (a refusal or a hold notice), then hang up.
          setTimeout(() => {
            sock.end()
            finish(answered())
          }, o.waitMs ?? 1000)
        },
        data(_sock, data) {
          reply += Buffer.from(data).toString('utf8')
        },
        close() {
          finish(answered())
        },
        error(_sock, err) {
          finish({ ok: false, error: err.message })
        },
        connectError(_sock, err) {
          finish({ ok: false, error: err.message })
        },
      },
    }).catch(err => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  })
}
