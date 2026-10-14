#!/usr/bin/env bun
// Compatibility check against the real Claude Code: run it before every release, and nightly
// in CI. Afterhours answers a few Claude Code screens by their wording, so a Claude Code update
// can break it; this catches that. It starts a private daemon (throwaway home, port and tmux
// socket) on a scratch git repo and pushes three small Haiku tasks through it:
//   1. plan mode: the folder trust prompt and the plan dialog get answered, the work gets done
//   2. a shell command in accept-edits mode: the permission request is relayed and allowed
//   3. its own branch: the task runs in a worktree and its work is committed on that branch
// It uses your Claude sign-in (in CI, an API key via apiKeyHelper) and costs a few cents.
// Exit code 0 means every check passed. `--keep` keeps the scratch folder afterwards.
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowName } from '../src/daemon/runner'
import { BRAND } from '../src/shared/brand'

const PORT = Number(process.env.COMPAT_PORT ?? 7799)
const SOCKET = `${BRAND.slug}-compat`
const JOB_TIMEOUT_SEC = Number(process.env.COMPAT_JOB_TIMEOUT ?? 300)
const keep = process.argv.includes('--keep')
const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-compat-`))
const home = join(root, 'home')
const repo = join(root, 'repo')
const logFile = join(root, 'daemon.log')

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

mkdirSync(home, { recursive: true })
mkdirSync(repo)
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'compat@example.com')
git('config', 'user.name', 'Compat check')
writeFileSync(join(repo, 'README.md'), '# compat\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')

writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    port: PORT,
    imessage: { enabled: false, allowSms: false },
    telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
    keepAwake: false,
    isolate: false,
    trustedDirs: [repo],
    folders: { roots: [root], maxDepth: 3 },
    // The defaults new users get, on the cheapest model.
    defaults: { plan: true, review: false, execMode: 'auto', model: 'haiku', effort: 'low' },
    timeouts: { launchSec: 120, stuckSec: 600, limitGraceSec: 30, approvalSec: 300, questionSec: 300, reviewSec: 600, backgroundSec: 120 },
  }),
)

const daemon = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli', 'cq.ts'), 'daemon'], {
  env: { ...process.env, CQ_HOME: home, CQ_TMUX_SOCKET: SOCKET },
  stdout: Bun.file(logFile),
  stderr: Bun.file(join(root, 'daemon.err')),
})

let cleanedUp = false
async function cleanup(): Promise<void> {
  if (cleanedUp) return
  cleanedUp = true
  daemon.kill()
  await daemon.exited
  Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

async function waitFor<T>(what: string, check: () => T | null | undefined | false, seconds: number): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const value = check()
    if (value) return value
    if (daemon.exitCode !== null) throw new Error(`the daemon exited (${daemon.exitCode}) while waiting for ${what}`)
    await Bun.sleep(1000)
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}`)
}

const daemonLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

async function cq(text: string): Promise<string> {
  const token = readFileSync(join(home, 'token'), 'utf8').trim()
  const res = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cq-token': token },
    body: JSON.stringify({ text, cwd: repo }),
  })
  return ((await res.json()) as { reply: string }).reply
}

async function queue(text: string): Promise<number> {
  const reply = await cq(text)
  const id = /^Queued #(\d+)/.exec(reply)?.[1]
  if (!id) throw new Error(`couldn't queue: ${reply}`)
  console.log(`   queued #${id}`)
  return Number(id)
}

type JobRow = { id: number; status: string; plan_approved: number; last_message: string | null; branch: string | null; work_dir: string | null; hold_reason: string | null; error: string | null }

// Opened once the daemon has created it. Read-write on purpose: a read-only connection to a WAL
// database can fail while the daemon writes.
const open: { db?: Database } = {}
function openDb(): Database {
  if (!open.db) {
    open.db = new Database(join(home, 'state.db'))
    open.db.exec('PRAGMA busy_timeout = 3000;')
  }
  return open.db
}
const job = (id: number) => openDb().query<JobRow, [number]>('SELECT * FROM jobs WHERE id = ?').get(id)
const pendingPermission = (id: number) =>
  openDb().query<{ code: string }, [number]>(`SELECT code FROM approvals WHERE job_id = ? AND kind = 'permission' AND status = 'pending'`).get(id)

/** Waits for a job to end, allowing each permission request it raises when `allow` is set. */
async function settle(id: number, allow = false): Promise<{ row: JobRow; allowed: number }> {
  let allowed = 0
  for (let i = 0; i < JOB_TIMEOUT_SEC; i++) {
    const row = job(id)
    if (row && ['done', 'held', 'failed', 'cancelled'].includes(row.status)) {
      if (row.status !== 'done') throw new Error(`#${id} ended ${row.status}: ${row.hold_reason ?? row.error ?? 'no reason given'}`)
      return { row, allowed }
    }
    const pending = allow ? pendingPermission(id) : null
    if (pending) {
      console.log(`   ${await cq(`y ${pending.code}`)}`)
      allowed++
    }
    await Bun.sleep(1000)
  }
  throw new Error(`#${id} didn't finish within ${JOB_TIMEOUT_SEC}s`)
}

/** What a failed job's terminal showed, and the job cleared so the next check can start. */
async function diagnose(): Promise<void> {
  const active = openDb().query<{ id: number }, []>(`SELECT id FROM jobs WHERE status IN ('running', 'held') ORDER BY id LIMIT 1`).get()
  if (!active) return
  const pane = Bun.spawnSync(['tmux', '-L', SOCKET, 'capture-pane', '-p', '-J', '-S', '-25', '-t', `=${BRAND.slug}:=${windowName(active.id)}`], { stdout: 'pipe', stderr: 'ignore' })
  const screen = pane.stdout.toString().trimEnd()
  if (screen) console.log(`   Claude's screen for #${active.id}:\n${screen.replace(/^/gm, '   │ ')}`)
  await cq('skip')
}

const results: { name: string; error: string | null }[] = []
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n• ${name}`)
  const started = Date.now()
  try {
    await fn()
    results.push({ name, error: null })
    console.log(`✔ passed in ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    results.push({ name, error })
    console.log(`✖ ${error}`)
    await diagnose().catch(() => {})
  }
}

try {
  await waitFor('the daemon to start', () => daemonLog().includes('listening on'), 30)
  const version = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe' }).stdout.toString().trim()
  console.log(`${BRAND.name} compatibility check against Claude Code ${version || '(version unknown)'}`)
  console.log(`scratch: ${root}`)

  await check('plan mode: trust prompt, plan dialog, then the work', async () => {
    const id = await queue('q plan: Create a file named hello.txt containing just the word hi. Keep the plan to one line.')
    const { row } = await settle(id)
    if (!row.plan_approved) throw new Error('the plan was never approved')
    const file = join(repo, 'hello.txt')
    if (!existsSync(file) || readFileSync(file, 'utf8').trim() !== 'hi') throw new Error('hello.txt is missing or wrong')
    const choice = new RegExp(`#${id}: answered plan dialog with "([^"]*)"`).exec(daemonLog())?.[1]
    if (choice) console.log(`   plan dialog answered with "${choice}"`)
    if (choice && !/auto mode/i.test(choice)) {
      console.log('   ⚠ the dialog offered no auto mode option; Afterhours fell back to switching modes after approval')
    }
  })

  await check('permission request relayed and allowed', async () => {
    const id = await queue(
      `q edits: Run this exact shell command with the Bash tool, then reply with one word: python3 -c "open('perm.txt','w').write('42')"`,
    )
    const { allowed } = await settle(id, true)
    if (allowed === 0) throw new Error('no permission request reached Afterhours')
    const file = join(repo, 'perm.txt')
    if (!existsSync(file) || readFileSync(file, 'utf8').trim() !== '42') throw new Error("the allowed command didn't run")
  })

  await check('own branch: worktree, then a commit on the branch', async () => {
    const id = await queue('q branch new edits: Create a file named branch.txt in the current directory containing just the word ok.')
    const { row } = await settle(id)
    if (!row.branch || !row.work_dir) throw new Error("the job didn't get its own branch")
    if (existsSync(join(repo, 'branch.txt'))) throw new Error('the work landed in the main checkout')
    const subject = git('log', '-1', '--format=%s', row.branch)
    if (!subject.startsWith(`${BRAND.name} #${id}`)) throw new Error(`the branch has no task commit (last: ${subject})`)
    if (!git('show', '--name-only', '--format=', row.branch).split('\n').includes('branch.txt')) throw new Error('branch.txt is not on the branch')
    console.log(`   ${row.branch}: ${subject}`)
  })

  const limits = openDb().query<{ value: string }, []>(`SELECT value FROM kv WHERE key = 'limits'`).get()
  const fiveHour = limits ? (JSON.parse(limits.value) as { fiveHour?: { usedPct: number | null } }).fiveHour : undefined
  console.log(
    fiveHour?.usedPct != null
      ? `\nStatus line: plan limits reported (5-hour window ${Math.round(fiveHour.usedPct)}% used).`
      : '\nStatus line: no plan limits reported (expected with an API key; with a Pro or Max sign-in this means the status line format changed).',
  )
} catch (err) {
  results.push({ name: 'setup', error: err instanceof Error ? err.message : String(err) })
  console.log(`✖ ${err instanceof Error ? err.message : err}`)
} finally {
  open.db?.close()
  await cleanup()
}

const failed = results.filter(r => r.error)
if (failed.length === 0) {
  console.log(`\nAll ${results.length} checks passed.`)
  if (!keep) rmSync(root, { recursive: true, force: true })
} else {
  console.log(`\n${failed.length} of ${results.length} checks failed. The daemon log and scratch repo are in ${root}`)
}
process.exit(failed.length === 0 ? 0 : 1)
