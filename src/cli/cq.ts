#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { HELP } from '../daemon/commands'
import { runDaemon, VERSION } from '../daemon/main'
import { findHost, runTermHost } from '../daemon/winterm'
import { BRAND } from '../shared/brand'
import { CQ_HOME, findExecutable, loadConfig, paths, readToken, TMUX_SESSION, TMUX_SOCKET } from '../shared/config'
import type { LaunchSpec } from '../shared/types'
import { doctor, report } from './doctor'
import { install, nextSteps, uninstall, update } from './install'
import { awakeCommand } from './awake'
import { foldersCommand } from './folders'
import { auditCommand, devicesCommand, pairCommand, remoteCommand } from './remote'
import { setup } from './setup'
import { installHint, isWindows } from '../platform/os'
import { runService } from '../platform/service'
import { telegramCommand } from './telegram'
import { daemonUrl, restartAgent } from './util'

const CLI_HELP = `${BRAND.name} ${VERSION}: queue Claude Code tasks from your phone; they run on this computer while you're away.

Getting started:
  cq setup             guided setup: folders, defaults, background service, permissions, Telegram

Setup and service:
  cq telegram <token>  connect your Telegram bot (from @BotFather) and pair your account
  cq telegram off      stop using Telegram
  cq folders           the project folders the bot searches; cq folders add|remove <path>
  cq awake             whether this computer stays awake while tasks run (cq awake on|off); cq awake lid on: with the lid closed too
  cq install           (re)install and run it in the background (a LaunchAgent on macOS, a systemd user service on Linux, a startup app on Windows)
  cq restart           restart it (on macOS, after granting Full Disk Access)
  cq update            update to the latest release
  cq uninstall         stop it and stop it starting by itself (keeps ${CQ_HOME.replace(homedir(), '~')})
  cq doctor            check that everything is in place
  cq report            write a support file (no prompts or code)
  cq attach            watch the running job live (read-only; detach with ${isWindows ? 'Ctrl-C' : 'Ctrl-b d'})
  cq logs [-f]         the background service's log
  cq daemon            run it in this terminal instead of in the background

Queue commands (jobs default to the current folder):
${HELP.split('\n').slice(1).map(l => '  ' + l).join('\n')}

${BRAND.name} runs Claude Code with your own sign-in and plan. It is not made by or affiliated with Anthropic.`

async function remote(text: string): Promise<void> {
  const token = readToken()
  try {
    if (!token) throw new Error('no token yet')
    const res = await fetch(daemonUrl('/api/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cq-token': token },
      body: JSON.stringify({ text, cwd: process.cwd() }),
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    console.log(((await res.json()) as { reply: string }).reply)
  } catch (err) {
    console.error(`${BRAND.name} isn't reachable (${err instanceof Error ? err.message : err}).`)
    console.error('Set it up with `cq setup`, or run it in this terminal with `cq daemon`.')
    process.exit(1)
  }
}

/** Runs inside the job's tmux window: fetches the exact claude command from the daemon and runs it. */
async function launch(id: number): Promise<void> {
  const token = readToken() ?? ''
  let spec: LaunchSpec | null = null
  for (let i = 0; i < 20 && !spec; i++) {
    try {
      const res = await fetch(daemonUrl(`/api/jobs/${id}/launch`), { headers: { 'x-cq-token': token } })
      if (res.ok) spec = (await res.json()) as LaunchSpec
    } catch {
      // daemon busy or restarting
    }
    if (!spec) await Bun.sleep(500)
  }
  if (!spec) {
    console.error(`couldn't get job #${id} from ${BRAND.name}.`)
    process.exit(70)
  }
  process.on('SIGINT', () => {}) // Claude handles its own Ctrl-C
  const child = Bun.spawn(spec.argv, { cwd: spec.cwd, stdio: ['inherit', 'inherit', 'inherit'] })
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  process.exit(await child.exited)
}

/**
 * What bin/cq-hook.sh and bin/cq-statusline.sh do, for Windows, which has neither sh nor (always)
 * curl: passes Claude Code's JSON on stdin to the daemon and prints its answer. Never fails: if
 * the daemon is unreachable, Claude Code carries on as if there were no hook.
 */
async function relay(path: string, o: { maxSec: number; fallback?: string }): Promise<void> {
  const job = process.env.CQ_JOB_ID
  if (!job) return
  const token = readToken()
  let out = ''
  try {
    if (!token) throw new Error('no token')
    const res = await fetch(`http://127.0.0.1:${process.env.CQ_PORT || 7787}${path}?job=${encodeURIComponent(job)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cq-token': token },
      body: await Bun.stdin.text(),
      signal: AbortSignal.timeout(o.maxSec * 1000),
    })
    out = await res.text()
  } catch {
    // unreachable: say nothing
  }
  process.stdout.write(out || (o.fallback ?? '').replace('#', `#${job}`))
}

/** Windows: the running task's screen, streamed from the terminal host. */
async function attachWindows(): Promise<void> {
  const host = await findHost()
  if (!host) {
    console.error('Nothing to watch right now (no job is running).')
    process.exit(0)
  }
  const ws = new WebSocket(`${host.url.replace('http', 'ws')}/attach?token=${encodeURIComponent(readToken() ?? '')}`)
  ws.binaryType = 'arraybuffer'
  let opened = false
  ws.onopen = () => {
    opened = true
    process.stdout.write('\x1b[2J\x1b[H')
  }
  ws.onmessage = e => process.stdout.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
  ws.onclose = () => {
    process.stdout.write('\x1b[0m\n')
    if (!opened) console.error('Nothing to watch right now (no job is running).')
    process.exit(0)
  }
  process.on('SIGINT', () => ws.close())
  await new Promise(() => {})
}

function attach(): Promise<void> | void {
  if (isWindows) return attachWindows()
  const tmux = findExecutable('tmux', loadConfig().tmuxPath)
  if (!tmux) {
    console.error(`tmux not found. Install it with: ${installHint('tmux')}`)
    process.exit(1)
  }
  const env = { ...process.env }
  delete env.TMUX // allow attaching from inside your own tmux
  const r = Bun.spawnSync([tmux, '-L', TMUX_SOCKET, 'attach', '-r', '-t', `=${TMUX_SESSION}`], {
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  if (r.exitCode !== 0) console.error('Nothing to watch right now (no job is running).')
  process.exit(0)
}

function logs(follow: boolean): Promise<void> | void {
  if (!existsSync(paths.log)) {
    console.error(`No log at ${paths.log} yet (the background service writes it; \`cq daemon\` logs to the terminal).`)
    process.exit(1)
  }
  if (isWindows) return tailWindows(paths.log, 60, follow)
  Bun.spawnSync(['tail', ...(follow ? ['-f'] : []), '-n', '60', paths.log], { stdio: ['inherit', 'inherit', 'inherit'] })
}

/** `tail -n <lines> [-f]`, which Windows doesn't have. */
async function tailWindows(path: string, lines: number, follow: boolean): Promise<void> {
  const read = (from: number, to: number): string => {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(to - from)
      readSync(fd, buf, 0, buf.length, from)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  }
  let size = statSync(path).size
  // The last 256 KB hold far more than 60 lines of this log.
  const text = read(Math.max(0, size - 256 * 1024), size)
  process.stdout.write(text.split('\n').slice(-lines - 1).join('\n'))
  while (follow) {
    await Bun.sleep(500)
    const now = statSync(path).size
    if (now < size) size = 0 // the log was started over
    if (now > size) process.stdout.write(read(size, now))
    size = now
  }
}

// Dispatch last, so every declaration above is initialized before a command runs.
async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'daemon':
      return runDaemon()
    case 'launch':
      return launch(Number(rest[0]))
    // Run by Claude Code and by the service, not by people: the Windows stand-ins for the hook
    // scripts, tmux's server, and launchd/systemd keeping the daemon running.
    case 'hook':
      return relay(`/hook/${rest[0] ?? ''}`, { maxSec: Number(process.env.CQ_HOOK_MAX_TIME || 4000) })
    case 'statusline':
      return relay('/statusline', { maxSec: 2, fallback: `${BRAND.slug} #` })
    case 'term-host':
      return runTermHost()
    case 'service':
      return runService()
    case 'setup':
      return setup()
    case 'install': {
      const result = await install()
      if (result) console.log(nextSteps(result))
      if (result && !result.started) process.exitCode = 1
      return
    }
    case 'uninstall':
      return uninstall()
    case 'restart':
      console.log(restartAgent() ? `Restarted ${BRAND.name}.` : `Couldn't restart: ${BRAND.name} isn't installed. Run cq setup.`)
      return
    case 'update':
      return update()
    case 'telegram':
      if (!(await telegramCommand(rest))) process.exitCode = 1
      return
    case 'pair':
      if (!(await pairCommand(rest))) process.exitCode = 1
      return
    case 'devices':
      if (!(await devicesCommand(rest))) process.exitCode = 1
      return
    case 'remote':
      if (!(await remoteCommand(rest))) process.exitCode = 1
      return
    case 'audit':
      if (!(await auditCommand(rest))) process.exitCode = 1
      return
    case 'folders':
      if (!foldersCommand(rest)) process.exitCode = 1
      return
    case 'awake':
      if (!(await awakeCommand(rest))) process.exitCode = 1
      return
    case 'doctor':
      return doctor()
    case 'report':
      return report()
    case 'attach':
      return attach()
    case 'logs':
      return logs(rest.includes('-f'))
    case 'help':
    case '--help':
    case '-h':
      console.log(CLI_HELP)
      return
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION)
      return
    default:
      return remote([cmd, ...rest].join(' '))
  }
}

await main()
