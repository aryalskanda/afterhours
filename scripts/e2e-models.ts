#!/usr/bin/env bun
// End-to-end check, with the real Claude Code, of two things only a real run shows:
//   - plan with one model, work with another: Sonnet writes the plan, and once it's approved the
//     same conversation resumes on Haiku, which does the work;
//   - a live link: at the end, Claude publishes a claude.ai artifact and the link is kept.
// A private daemon (throwaway home, port and tmux socket) runs one small task in a scratch git
// repo. Uses your Claude sign-in (a little of your plan's usage), and publishes one private
// artifact to your claude.ai account. `--keep` keeps the scratch folder.

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from '../src/shared/brand'

const PORT = Number(process.env.E2E_PORT ?? 7799)
const SOCKET = `${BRAND.slug}-e2e-models`
const TIMEOUT_SEC = Number(process.env.E2E_JOB_TIMEOUT ?? 600)
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-e2e-models-`))
const home = join(root, 'home')
const repo = join(root, 'projects', 'hello')

function git(...args: string[]): void {
  const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
}

mkdirSync(home, { recursive: true })
mkdirSync(repo, { recursive: true })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'e2e@example.com')
git('config', 'user.name', 'E2E check')
writeFileSync(join(repo, 'README.md'), '# hello\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')

writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    port: PORT,
    telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
    keepAwake: false,
    // Leave your other Claude chats alone: this daemon only runs its own task.
    watchSessions: false,
    autoContinueChats: false,
    isolate: false,
    trustedDirs: [repo],
    folders: { roots: [root], maxDepth: 3 },
    defaults: { plan: true, review: false, execMode: 'auto', model: 'sonnet', effort: 'low' },
    timeouts: { launchSec: 120, stuckSec: 600, limitGraceSec: 30, approvalSec: 300, questionSec: 300, reviewSec: 600, backgroundSec: 120 },
  }),
)

const logFile = join(root, 'daemon.log')
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli', 'cq.ts'), 'daemon'], {
  env: { ...process.env, CQ_HOME: home, CQ_TMUX_SOCKET: SOCKET, CQ_PORT: String(PORT) },
  stdout: Bun.file(logFile),
  stderr: Bun.file(join(root, 'daemon.err')),
})
const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

let failures = 0
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}

async function command(text: string): Promise<string> {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': token },
    body: JSON.stringify({ text, cwd: repo }),
  })
  return ((await res.json()) as { reply: string }).reply
}

function job(id: number): Record<string, unknown> | null {
  const db = new Database(join(home, 'state.db'), { readonly: true })
  try {
    return db.query<Record<string, unknown>, [number]>('SELECT * FROM jobs WHERE id = ?').get(id)
  } finally {
    db.close()
  }
}

async function until<T>(find: () => T | null | undefined | false, what: string, sec: number): Promise<T> {
  const end = Date.now() + sec * 1000
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(1000)
  }
}

try {
  await until(() => log().includes('listening on'), 'the daemon', 30)
  console.log(`scratch: ${root}`)
  const reply = await command(
    `q ${repo} plan sonnet>haiku link: Create hello.html: a small page that says "Hello from Afterhours" in big friendly letters, centered on a warm background. Keep it to one file.`,
  )
  const id = Number(/#(\d+)/.exec(reply)?.[1])
  check(Number.isInteger(id), 'queued', reply)
  const queued = job(id)!
  check(queued.model === 'sonnet' && queued.work_model === 'haiku' && queued.want_link === 1, 'plans with Sonnet, works with Haiku, ends with a live link', `${queued.model}>${queued.work_model}`)

  // The plan, then the handover to Haiku.
  await until(() => log().includes(`#${id}: plan approved; haiku carries it out`), 'the plan to be approved and handed over', TIMEOUT_SEC)
  check(true, 'the plan was approved and handed over')
  const after = await until(() => {
    const j = job(id)
    return j && Number(j.launches) >= 2 ? j : null
  }, 'the work model to start', 120)
  const argv = (JSON.parse(String(after.launch_spec)) as { argv: string[] }).argv
  check(argv[argv.indexOf('--model') + 1] === 'haiku', 'the same conversation resumed on Haiku', argv.slice(1, 8).join(' '))
  check(argv.includes('--resume'), 'resumed, not a new conversation')
  check(argv[argv.indexOf('--permission-mode') + 1] === 'auto', 'in the task’s own mode (auto)')

  // The work, then the live link.
  const done = await until(() => {
    const j = job(id)
    return j && ['done', 'failed', 'cancelled'].includes(String(j.status)) ? j : j?.status === 'held' ? j : null
  }, 'the task to end', TIMEOUT_SEC)
  check(done.status === 'done', 'it finished', `${done.status}${done.hold_reason ? ` (${done.hold_reason})` : ''}`)
  check(existsSync(join(repo, 'hello.html')), 'Haiku made hello.html')
  const links = done.links ? (JSON.parse(String(done.links)) as { url: string; title: string | null }[]) : []
  check(links.length > 0 && links[0]!.url.startsWith('https://claude.ai/'), 'a live link came back', links[0]?.url ?? String(done.link_note ?? 'no link, no note'))
  check(!String(done.last_message ?? '').includes('claude.ai/'), "the task's answer stayed Claude's answer", String(done.last_message ?? '').slice(0, 120))
  console.log(`\n${links[0] ? `Live link: ${links[0].url}${links[0].title ? ` (${links[0].title})` : ''}` : 'No live link.'}`)
} catch (err) {
  failures++
  console.log(`✗ ${err instanceof Error ? err.message : err}`)
  console.log(log().split('\n').slice(-25).join('\n'))
} finally {
  daemon.kill()
  await daemon.exited
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
  if (keep) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
}

console.log(failures ? '\nFAILED' : '\nAll passed.')
process.exit(failures ? 1 : 0)
