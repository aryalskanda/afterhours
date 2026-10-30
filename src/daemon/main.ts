import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import hookScript from '../../bin/cq-hook.sh' with { type: 'text' }
import statusScript from '../../bin/cq-statusline.sh' with { type: 'text' }
import { basename, join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { BRAND } from '../shared/brand'
import {
  cleanEnv,
  codeRoots,
  CQ_HOME,
  ensureHome,
  ensureToken,
  findClaude,
  findExecutable,
  loadConfig,
  paths,
  saveConfig,
  TMUX_SOCKET,
  writeFileAtomic,
  type Config,
} from '../shared/config'
import { TelegramApi } from '../telegram/api'
import { TelegramBridge, type TelegramStatus } from '../telegram/bot'
import { chatSource, continueSpec } from './chats'
import { runCommand } from './commands'
import { FolderMap } from './folders'
import { LidAwake } from './awake'
import { PowerControl } from './power'
import { Notifier } from './notify'
import { Remote, type RemoteStatus } from './remote'
import { allowedRoots, isAllowed } from './remote/router'
import { Runner, type HookPayload, type ToolActivity } from './runner'
import { deliverToInbox } from './inbox'
import { CLAUDE_DIR, CLAUDE_JSON, findConversation, liveConversation, liveSessions, sessionHolders } from './sessions'
import { pruneUploads } from './uploads'
import { Store } from './store'
import { git } from './system'
import { hasFullDiskAccess, KeepAwake, openInVsCode, reopenInVsCode } from '../platform/desktop'
import { powerSystem, systemSleepSwitch } from '../platform/power'
import { isMac, isWindows, osLabel } from '../platform/os'
import { systemProcs } from './procs'
import { Tmux, TMUX_CONF, type TmuxDriver } from './tmux'
import { WinTerm } from './winterm'
import { SessionWatcher } from './watch'

/** From package.json, which a release tag must match. */
export const VERSION: string = pkg.version

export function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

/** How to run this program again: `bun src/cli/cq.ts` while developing, the binary once installed. */
export function selfCommand(): string[] {
  return /(^|[\\/])bun(-debug)?(\.exe)?$/i.test(process.execPath) ? [process.execPath, Bun.main] : [process.execPath]
}

export interface Health {
  ok: true
  version: string
  pid: number
  home: string
  claude: string
  tmux: string
  telegram: TelegramStatus | { ok: false; error: string }
  remote: RemoteStatus
  /** Whether this process may read Full-Disk-Access-protected files (and so ~/Documents without prompts). */
  fullDiskAccess: boolean
}

export async function runDaemon(): Promise<void> {
  ensureHome()
  const token = ensureToken()
  let config = loadConfig()
  let configMtime = mtime(paths.config)
  const getConfig = () => config
  const putConfig = (next: Config) => {
    config = next
    saveConfig(next)
    configMtime = mtime(paths.config)
  }

  // Windows has no sh or tmux: hooks run `cq hook`, and tasks run in cq's own terminal host.
  if (!isWindows) {
    writeFileAtomic(paths.hookScript, hookScript, 0o755)
    writeFileAtomic(paths.statusScript, statusScript, 0o755)
    writeFileAtomic(paths.tmuxConf, TMUX_CONF)
  } else {
    removeOldBinaries()
  }

  const claudePath = findClaude(config.claudePath)
  const tmuxPath = isWindows ? 'conpty' : findExecutable('tmux', config.tmuxPath)
  if (!claudePath || !tmuxPath) {
    const what = !claudePath ? (isWindows ? 'claude.exe' : 'claude') : 'tmux'
    log(`can't start: ${what} not found (set ${claudePath ? 'tmuxPath' : 'claudePath'} in ${paths.config})`)
    process.exit(1)
  }
  const terminals: TmuxDriver = isWindows ? new WinTerm(selfCommand(), cleanEnv()) : new Tmux(tmuxPath, TMUX_SOCKET, paths.tmuxConf, cleanEnv())

  const store = new Store(paths.db)
  store.pruneEvents(Date.now() - 30 * 24 * 3600_000)
  pruneUploads(paths.uploads, Date.now())
  store.pruneLimitSamples(Date.now() - 8 * 86_400_000)
  // Hooks that were waiting on these lost their connection when the daemon stopped.
  store.expirePendingApprovals(Date.now())

  const notifier = new Notifier({ level: () => config.notify, aliases: () => config.aliases, now: Date.now, log })
  // Tool calls go to the apps once remote access is set up below.
  let onActivity: (a: ToolActivity) => void = () => {}
  const runner = new Runner({
    store,
    tmux: terminals,
    notify: notice => notifier.send(notice),
    config: getConfig,
    saveConfig: putConfig,
    now: Date.now,
    claudePath,
    selfCommand: selfCommand(),
    port: config.port,
    home: CQ_HOME,
    jobsDir: paths.jobs,
    scripts: { hook: paths.hookScript, status: paths.statusScript, ...(isWindows ? { program: selfCommand() } : {}) },
    writeFile: (path, text) => writeFileAtomic(path, text, 0o600),
    sessionHolders,
    git,
    killPid: pid => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    },
    log,
    // Only into a VS Code that's running on this desktop: never started just for this.
    reopenInVsCode: sessionId => reopenInVsCode(sessionId, log),
    activity: a => onActivity(a),
    // Folders an "allow" rule from an app may add: only ones the machine shares with apps.
    allowedDir: dir => isAllowed(dir, allowedRoots(config)),
    uploadsDir: paths.uploads,
    procs: systemProcs,
  })

  const chats = chatSource({ store, liveSessions: () => liveSessions() })
  const watcher = new SessionWatcher({
    liveSessions: () => liveSessions(),
    conversation: s => liveConversation(s),
    findConversation: sessionId => findConversation(sessionId),
    queued: sessionId => store.running().some(j => j.sessionId === sessionId) || store.pendingForSession(sessionId) !== null,
    limits: () => runner.limits(),
    store,
    notify: notice => notifier.send(notice),
    enabled: () => config.watchSessions,
    autoContinue: () => config.watchSessions && config.autoContinueChats,
    graceMs: () => config.timeouts.limitGraceSec * 1000,
    deliver: (s, text) => deliverToInbox(s, text),
    enqueue: (chat, takeover) => {
      // The same model and effort the bot would pick: your last choices, else your defaults.
      const last = store.kvGet<{ model?: string; effort?: Config['defaults']['effort'] }>('telegram.last') ?? {}
      return runner.enqueue(
        continueSpec(chat, { model: last.model ?? config.defaults.model, effort: last.effort ?? config.defaults.effort, takeover, source: 'watch' }),
      )
    },
    log,
    now: Date.now,
  })

  // Staying awake and sleeping, with the system's own tools, from the apps, the bot and text commands.
  const power = powerSystem()
  const keepAwake = new KeepAwake()
  const lidAwake = power?.kind === 'mac' ? new LidAwake({ system: power, sleep: systemSleepSwitch, store, now: Date.now, log }) : null
  const mac = power
    ? new PowerControl({
        system: power,
        store,
        runner,
        config: getConfig,
        saveConfig: putConfig,
        notify: notice => notifier.send(notice),
        now: Date.now,
        log,
        lid: lidAwake ? { awake: lidAwake, sleep: systemSleepSwitch } : undefined,
        canInhibitLid: power.kind === 'linux' && Bun.which('systemd-inhibit') !== null,
        holdingAwake: () => keepAwake.holding,
      })
    : null

  const commandContext = (source: 'cli' | 'remote', cwd?: string) => ({
    runner,
    store,
    config: getConfig,
    saveConfig: putConfig,
    now: Date.now,
    cwd,
    source,
    chats,
    mac,
  })
  const command = (text: string, source: 'cli', cwd?: string) => runCommand(text, commandContext(source, cwd))

  const folders = new FolderMap({
    roots: () => codeRoots(config),
    store,
    now: Date.now,
    log,
  })
  folders.refreshIfStale()

  const remote = new Remote({
    store,
    runner,
    chats,
    folders,
    config: getConfig,
    saveConfig: putConfig,
    command: (text, guard) => runCommand(text, { ...commandContext('remote'), guard }),
    version: VERSION,
    git,
    openInVsCode: sessionId => openInVsCode(sessionId, log),
    uploadsDir: paths.uploads,
    claudeDir: CLAUDE_DIR,
    claudeJson: CLAUDE_JSON,
    claudePath,
    logPath: paths.log,
    reportsPath: paths.appReports,
    // A stand-in for Expo's push service, for private test runs.
    push: process.env.CQ_PUSH_URL ? { url: process.env.CQ_PUSH_URL, receiptsUrl: process.env.CQ_PUSH_RECEIPTS_URL } : undefined,
    restart: () => {
      log('restarting, as an owner asked from an app')
      process.exit(75)
    },
    // Every new device, said in your Telegram chat (telegram is set below).
    onPaired: (device, role) => void telegram?.devicePaired(device, role),
    mac,
    log,
    now: Date.now,
  })
  onActivity = a => remote.activity(a)
  remote.apply()
  notifier.addSink((text, notice) => remote.notice(text, notice), { unfiltered: true })

  let telegram: TelegramBridge | null = null
  const telegramKey = () => JSON.stringify([config.telegram.enabled, config.telegram.token])
  let telegramStarted = ''
  const startTelegram = () => {
    telegram?.stop()
    telegram = null
    telegramStarted = telegramKey()
    const { enabled, token } = config.telegram
    if (!enabled || !token) return
    telegram = new TelegramBridge({
      api: new TelegramApi(token),
      store,
      runner,
      folders,
      chats,
      config: getConfig,
      saveConfig: putConfig,
      commandContext: () => commandContext('cli'),
      mac,
      git,
      uploadsDir: paths.uploads,
      now: Date.now,
      log,
    })
    void telegram.start()
  }
  startTelegram()
  notifier.addSink((_text, notice) => telegram?.notify(notice))

  // Without Full Disk Access a task can stop on a macOS prompt nobody is there to click: say so, once a day.
  setTimeout(() => {
    if (!isMac || hasFullDiskAccess() || Date.now() - (store.kvGet<number>('warned.fullDiskAccess') ?? 0) < 24 * 3600_000) return
    store.kvSet('warned.fullDiskAccess', Date.now())
    notifier.send({
      type: 'setup_warning',
      message:
        'Full Disk Access is missing, so a task can stop on a macOS prompt nobody is there to click. ' +
        `On the Mac: System Settings → Privacy & Security → Full Disk Access → add ${join(paths.bin, 'cq-launcher').replace(homedir(), '~')}, then run cq restart.`,
    })
  }, 20_000)

  /** What `cq pair`, `cq devices`, `cq remote` and `cq audit` ask the daemon. */
  async function remoteApi(req: Request, url: URL): Promise<Response> {
    const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
    if (url.pathname === '/api/remote' && req.method === 'GET') return Response.json(remote.status())
    if (url.pathname === '/api/remote/pair' && req.method === 'POST') {
      const role = body.role === 'viewer' || body.role === 'operator' ? body.role : 'owner'
      const result = remote.openOffer({ role, autoApprove: body.yes === true, ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined })
      if (typeof result === 'string') return Response.json({ error: result }, { status: 409 })
      return Response.json({ ...result, status: remote.status() })
    }
    const pair = /^\/api\/remote\/pair\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)
    if (pair) {
      const view = req.method === 'POST' ? remote.decide(pair[1]!, body.approve === true) : remote.offer(pair[1]!)
      return view ? Response.json(view) : Response.json({ error: 'no such pairing' }, { status: 404 })
    }
    if (url.pathname === '/api/remote/devices' && req.method === 'GET') {
      return Response.json(remote.devices({ revoked: url.searchParams.get('all') === '1' }))
    }
    if (url.pathname === '/api/remote/devices/remove' && req.method === 'POST') {
      const found = remote.findDevice(String(body.device ?? ''))
      if (typeof found === 'string') return Response.json({ error: found }, { status: 404 })
      remote.removeDevice(found.id, 'this machine')
      return Response.json({ removed: found.name })
    }
    if (url.pathname === '/api/remote/devices/rename' && req.method === 'POST') {
      const found = remote.findDevice(String(body.device ?? ''))
      const name = String(body.name ?? '').trim()
      if (typeof found === 'string') return Response.json({ error: found }, { status: 404 })
      if (!name) return Response.json({ error: 'Give the new name.' }, { status: 400 })
      remote.renameDevice(found.id, name)
      return Response.json({ renamed: found.name, to: name })
    }
    if (url.pathname === '/api/remote/audit' && req.method === 'GET') {
      return Response.json(remote.auditLog(Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50)))
    }
    return new Response('not found', { status: 404 })
  }

  // Windows: right after a restart, the daemon before this one can still hold the port for a moment.
  if (isWindows) await portFree(config.port, 10_000)
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      idleTimeout: 30,
      async fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === '/api/health') {
          const health: Health = {
            ok: true,
            version: VERSION,
            pid: process.pid,
            home: CQ_HOME,
            claude: claudePath,
            tmux: tmuxPath,
            telegram: telegram ? { ...telegram.status(), pairCode: null } : { ok: false, error: 'not set up (cq telegram <token>)' },
            remote: remote.status(),
            fullDiskAccess: hasFullDiskAccess(),
          }
          return Response.json(health)
        }
        if (req.headers.get('x-cq-token') !== token) return new Response('unauthorized', { status: 401 })

        if (url.pathname === '/api/telegram' && req.method === 'GET') {
          return Response.json(telegram?.status() ?? { ok: false, bot: null, paired: false, owner: null, pairCode: null, error: 'not set up' })
        }

        const hook = /^\/hook\/([A-Za-z]+)$/.exec(url.pathname)
        if (hook && req.method === 'POST') {
          srv.timeout(req, 0) // permission and question hooks wait for your reply
          const payload = (await req.json().catch(() => ({}))) as HookPayload
          const response = await runner.onHook(hook[1]!, Number(url.searchParams.get('job')), payload)
          return Response.json(response)
        }
        if (url.pathname === '/statusline' && req.method === 'POST') {
          const payload = (await req.json().catch(() => ({}))) as { rate_limits?: unknown }
          return new Response(runner.onStatusline(Number(url.searchParams.get('job')), payload))
        }
        if (url.pathname === '/api/command' && req.method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as { text?: string; cwd?: string }
          const text = (body.text ?? '').trim()
          const reply = await command(text, 'cli', body.cwd)
          return Response.json({ reply: reply ?? `Unknown command "${text.split(/\s+/)[0]}". Try: cq help` })
        }
        if (url.pathname.startsWith('/api/remote')) return remoteApi(req, url)
        const launch = /^\/api\/jobs\/(\d+)\/launch$/.exec(url.pathname)
        if (launch && req.method === 'GET') {
          const spec = runner.launchSpec(Number(launch[1]))
          return spec ? Response.json(spec) : new Response('no such job', { status: 404 })
        }
        return new Response('not found', { status: 404 })
      },
    })
  } catch (err) {
    log(`can't listen on 127.0.0.1:${config.port} (${err instanceof Error ? err.message : err}). Is another cq daemon running?`)
    // Exit 0 so launchd doesn't keep restarting a duplicate.
    process.exit(0)
  }

  // When an update replaces the installed binary (brew upgrade, cq update), restart into it.
  const startedAs = selfCommand().length === 1 ? binaryStamp() : null
  let ticks = 0
  let watchTicks = 0
  const timer = setInterval(async () => {
    if (startedAs && ++ticks % 30 === 0 && binaryStamp() !== startedAs) {
      log('a new version was installed; restarting into it')
      shutdown(75) // non-zero, so launchd starts us again
      return
    }
    const m = mtime(paths.config)
    if (m !== configMtime) {
      configMtime = m
      try {
        config = loadConfig()
        log('reloaded config.json')
        if (telegramKey() !== telegramStarted) startTelegram()
        remote.apply()
      } catch (err) {
        log(`ignoring config.json change: ${err instanceof Error ? err.message : err}`)
      }
    }
    folders.refreshIfStale()
    // About every 30 s: did one of your other chats (VS Code, a terminal) stop on a usage limit?
    if (++watchTicks % 15 === 0) {
      watcher.check().catch(err => log(`watching other chats failed: ${err instanceof Error ? err.message : err}`))
    }
    await runner.tick()
    remote.tick()
    void mac?.tick()
    // Not awaited: Telegram being slow must never hold up the queue.
    telegram?.tick().catch(err => log(`telegram: tidying up failed: ${err instanceof Error ? err.message : err}`))
    // Awake while tasks run, or for a while you asked for with nothing running. On Linux the lid
    // switch is held off by the same lock; on a Mac it takes turning sleep off.
    const awake = (config.keepAwake && runner.hasWork()) || (mac?.awakeHeld() ?? false)
    keepAwake.set(awake, { lid: power?.kind === 'linux' && config.keepAwakeLidClosed })
    void lidAwake?.tick(config.keepAwakeLidClosed && awake)
  }, 2000)

  function shutdown(code = 0): void {
    log('stopping (Claude sessions in tmux keep running and are picked up on the next start)')
    clearInterval(timer)
    keepAwake.set(false)
    // Sleep turned off for tasks goes back on; started again with work, it goes off again.
    lidAwake?.releaseNow()
    folders.stopWatching()
    telegram?.stop()
    remote.stop()
    server.stop(true)
    store.close()
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())

  const where = isWindows ? 'terminal host (ConPTY)' : `tmux -L ${TMUX_SOCKET}`
  log(`${BRAND.name} ${VERSION} listening on 127.0.0.1:${config.port} · ${osLabel()} · claude ${claudePath} · ${where} · state ${CQ_HOME}`)
}

/** Waits up to `ms` for nothing to be listening on the port; false if something still is. */
async function portFree(port: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; ; await Bun.sleep(500)) {
    try {
      Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() }).stop(true)
      return true
    } catch {
      if (Date.now() > end) return false
    }
  }
}

/** Windows: an update renames the running cq.exe aside (it can't be replaced); once nothing runs it, it goes. */
function removeOldBinaries(): void {
  let names: string[] = []
  try {
    names = readdirSync(paths.bin)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(`${basename(paths.binary)}.old-`)) continue
    try {
      rmSync(join(paths.bin, name), { force: true })
    } catch {
      // still in use by a process that hasn't ended yet: next time
    }
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Identifies the installed binary's current version (following a Homebrew link). */
function binaryStamp(): string | null {
  try {
    const real = realpathSync(paths.binary)
    const st = statSync(real)
    return `${real}:${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}
