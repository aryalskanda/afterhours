#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { HELP } from '../daemon/commands'
import { runDaemon, VERSION } from '../daemon/main'
import { BRAND } from '../shared/brand'
import { CQ_HOME, findExecutable, loadConfig, paths, readToken, TMUX_SESSION, TMUX_SOCKET } from '../shared/config'
import type { LaunchSpec } from '../shared/types'
import { doctor, report } from './doctor'
import { install, nextSteps, uninstall, update } from './install'
import { setup } from './setup'
import { telegramCommand } from './telegram'
import { daemonUrl, restartAgent } from './util'

const CLI_HELP = `${BRAND.name} ${VERSION}: queue Claude Code tasks from your phone; they run on this Mac while you're away.

Getting started:
  cq setup             guided setup: folders, defaults, background service, permissions, Telegram

Setup and service:
  cq telegram <token>  connect your Telegram bot (from @BotFather) and pair your account
  cq telegram off      stop using Telegram
  cq install           (re)install and start it at login
  cq restart           restart it (after granting Full Disk Access)
  cq update            update to the latest release
  cq uninstall         stop it and remove it from login items (keeps ${CQ_HOME.replace(process.env.HOME ?? '', '~')})
  cq doctor            check that everything is in place
  cq report            write a support file (no prompts or code)
  cq attach            watch the running job live (read-only; detach with Ctrl-b d)
  cq logs [-f]         the background service's log
  cq daemon            run it in this terminal instead of in the background

Queue commands (the same ones work over iMessage; jobs default to the current folder):
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

function attach(): void {
  const tmux = findExecutable('tmux', loadConfig().tmuxPath)
  if (!tmux) {
    console.error('tmux not found. Install it with: brew install tmux')
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

function logs(follow: boolean): void {
  if (!existsSync(paths.log)) {
    console.error(`No log at ${paths.log} yet (the background service writes it; \`cq daemon\` logs to the terminal).`)
    process.exit(1)
  }
  Bun.spawnSync(['tail', ...(follow ? ['-f'] : []), '-n', '60', paths.log], { stdio: ['inherit', 'inherit', 'inherit'] })
}

// Dispatch last, so every declaration above is initialized before a command runs.
async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'daemon':
      return runDaemon()
    case 'launch':
      return launch(Number(rest[0]))
    case 'setup':
      return setup()
    case 'install': {
      const result = await install()
      if (result) console.log(nextSteps(result))
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
