import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverToInbox, peerToken } from '../src/daemon/inbox'

/** A stand-in for a Claude Code session's inbox: records the lines it receives. */
function fakeInbox(answer?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cq-inbox-'))
  const path = join(dir, 'peer.sock')
  const lines: string[] = []
  let buf = ''
  const server = Bun.listen({
    unix: path,
    socket: {
      open(sock) {
        if (answer) sock.write(answer + '\n')
      },
      data(_sock, data) {
        buf += Buffer.from(data).toString('utf8')
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        lines.push(...parts.filter(Boolean))
      },
    },
  })
  return { path, lines, stop: () => server.stop(true) }
}

function claudeDirWithKey(pid: number, token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cq-claude-'))
  mkdirSync(join(dir, 'sessions'))
  writeFileSync(join(dir, 'sessions', `${pid}.abc123.key`), JSON.stringify({ peerToken: token, procStart: 'x', pidDomain: 'darwin' }))
  return dir
}

describe('inbox delivery', () => {
  test('an auth line with the published token, then one user message', async () => {
    const inbox = fakeInbox()
    const claudeDir = claudeDirWithKey(4242, 'tok-123')
    expect(peerToken(4242, claudeDir)).toBe('tok-123')
    const d = await deliverToInbox({ pid: 4242, messagingSocketPath: inbox.path }, 'Continue from where you left off.', { claudeDir, waitMs: 50 })
    expect(d.ok).toBe(true)
    expect(inbox.lines.map(l => JSON.parse(l))).toEqual([
      { type: 'auth', token: 'tok-123' },
      { type: 'user', message: { role: 'user', content: 'Continue from where you left off.' } },
    ])
    inbox.stop()
  })

  test('no published token: the message goes without an auth line', async () => {
    const inbox = fakeInbox('{"type":"held"}')
    const claudeDir = mkdtempSync(join(tmpdir(), 'cq-claude-'))
    const d = await deliverToInbox({ pid: 7, messagingSocketPath: inbox.path }, 'continue', { claudeDir, waitMs: 50 })
    expect(d).toEqual({ ok: true, reply: '{"type":"held"}' })
    expect(inbox.lines.map(l => JSON.parse(l).type)).toEqual(['user'])
    inbox.stop()
  })

  test('no inbox, or nobody listening', async () => {
    expect(await deliverToInbox({ pid: 1 }, 'continue')).toEqual({ ok: false, error: 'that session has no inbox' })
    const d = await deliverToInbox({ pid: 1, messagingSocketPath: join(tmpdir(), 'no-such-inbox.sock') }, 'continue', { waitMs: 50 })
    expect(d.ok).toBe(false)
  })
})
