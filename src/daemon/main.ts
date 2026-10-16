import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import hookScript from '../../bin/cq-hook.sh' with { type: 'text' }
import statusScript from '../../bin/cq-statusline.sh' with { type: 'text' }
import { join } from 'node:path'
import pkg from '../../package.json' with { type: 'json' }
import { IMessageBridge, type BridgeStatus } from '../imessage/bridge'
import { BRAND } from '../shared/brand'
import {
  cleanEnv,
  codeRoots,
  CQ_HOME,
  ensureHome,
  ensureToken,
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
import { Notifier } from './notify'
import { Remote, type RemoteStatus } from './remote'
import { allowedRoots, isAllowed } from './remote/router'
import { Runner, type HookPayload, type ToolActivity } from './runner'
import { deliverToInbox } from './inbox'
import { findConversation, liveConversation, liveSessions, sessionHolders } from './sessions'
import { Store } from './store'
import { git } from './system'
import { hasFullDiskAccess, KeepAwake, openInVsCode, reopenInVsCode } from '../platform/desktop'
import { isMac, osLabel } from '../platform/os'
import { Tmux, TMUX_CONF } from './tmux'
import { SessionWatcher } from './watch'

/** From package.json, which a release tag must match. */
export const VERSION: string = pkg.version

export function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

/** How to run this program again: `bun src/cli/cq.ts` while developing, the binary once installed. */
export function selfCommand(): string[] {
  return /(^|\/)bun(-debug)?$/.test(process.execPath) ? [process.execPath, Bun.main] : [process.execPath]
}

export interface Health {
  ok: true
  version: string
  pid: number
  home: string
  claude: string
  tmux: string
  imessage: BridgeStatus | { ok: false; error: string }
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

  writeFileAtomic(paths.hookScript, hookScript, 0o755)
  writeFileAtomic(paths.statusScript, statusScript, 0o755)
  writeFileAtomic(paths.tmuxConf, TMUX_CONF)

  const claudePath = findExecutable('claude', config.claudePath)
  const tmuxPath = findExecutable('tmux', config.tmuxPath)
  if (!claudePath || !tmuxPath) {
    log(`can't start: ${claudePath ? 'tmux' : 'claude'} not found (set ${claudePath ? 'tmuxPath' : 'claudePath'} in ${paths.config})`)
    process.exit(1)
  }

  const store = new Store(paths.db)
  store.pruneEvents(Date.now() - 30 * 24 * 3600_000)
  // Hooks that were waiting on these lost their connection when the daemon stopped.
  store.expirePendingApprovals(Date.now())

  const notifier = new Notifier({ level: () => config.notify, aliases: () => config.aliases, now: Date.now, log })
  // Tool calls go to the apps once remote access is set up below.
  let onActivity: (a: ToolActivity) => void = () => {}
  const runner = new Runner({
    store,
    tmux: new Tmux(tmuxPath, TMUX_SOCKET, paths.tmuxConf, cleanEnv()),
    notify: notice => notifier.send(notice),
    config: getConfig,
    saveConfig: putConfig,
    now: Date.now,
    claudePath,
    selfCommand: selfCommand(),
    port: config.port,
    home: CQ_HOME,
    jobsDir: paths.jobs,
    scripts: { hook: paths.hookScript, status: paths.statusScript },
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
  })

  const chats = chatSource({ store, liveSessions: () => liveSessions() })
  const watcher = new SessionWatcher({
    liveSessions: () => liveSessions(),
    conversation: s => liveConversation(s),
    findConversation: sessionId => findConversation(sessionId),
    queued: sessionId => store.active()?.sessionId === sessionId || store.pendingForSession(sessionId) !== null,
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

  const commandContext = (source: 'cli' | 'imessage' | 'remote', cwd?: string) => ({
    runner,
    store,
    config: getConfig,
    saveConfig: putConfig,
    now: Date.now,
    cwd,
    source,
    chats,
  })
  const command = (text: string, source: 'cli' | 'imessage', cwd?: string) => runCommand(text, commandContext(source, cwd))

  const folders = new FolderMap({
    roots: () => codeRoots(config),
    maxDepth: () => config.folders.maxDepth,
    cachePath: join(CQ_HOME, 'folders.json'),
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
    command: (text, guard) => runCommand(text, { ...commandContext('remote'), guard }),
    version: VERSION,
    git,
    openInVsCode: sessionId => openInVsCode(sessionId, log),
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

  let bridge: IMessageBridge | null = null
  if (config.imessage.enabled) {
    const b = new IMessageBridge({
      allowSms: config.imessage.allowSms,
      getWatermark: () => store.kvGet<number>('imessage.watermark'),
      setWatermark: rowid => store.kvSet('imessage.watermark', rowid),
      getReplyChat: () => store.kvGet<string>('imessage.chat'),
      setReplyChat: chat => store.kvSet('imessage.chat', chat),
      onCommand: async text => {
        try {
          return await command(text, 'imessage')
        } catch (err) {
          log(`command failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
          return `Something went wrong: ${err instanceof Error ? err.message : err}`
        }
      },
      now: Date.now,
      log,
    })
    if (b.start()) notifier.addSink(text => b.notify(text))
    bridge = b
  }

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
            imessage: bridge?.status() ?? { ok: false, error: 'iMessage is turned off in config.json' },
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

  const keepAwake = new KeepAwake()
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
    // Not awaited: Telegram being slow must never hold up the queue.
    telegram?.tick().catch(err => log(`telegram: tidying up failed: ${err instanceof Error ? err.message : err}`))
    keepAwake.set(config.keepAwake && runner.hasWork())
  }, 2000)

  function shutdown(code = 0): void {
    log('stopping (Claude sessions in tmux keep running and are picked up on the next start)')
    clearInterval(timer)
    keepAwake.set(false)
    bridge?.stop()
    telegram?.stop()
    remote.stop()
    server.stop(true)
    store.close()
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())

  log(`${BRAND.name} ${VERSION} listening on 127.0.0.1:${config.port} · ${osLabel()} · claude ${claudePath} · tmux -L ${TMUX_SOCKET} · state ${CQ_HOME}`)
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
