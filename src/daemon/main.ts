import { closeSync, openSync, realpathSync, statSync } from 'node:fs'
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
import { chatSource } from './chats'
import { runCommand } from './commands'
import { FolderMap } from './folders'
import { Notifier } from './notify'
import { Runner, type HookPayload } from './runner'
import { liveConversation, liveSessions, sessionHolders } from './sessions'
import { Store } from './store'
import { git, KeepAwake } from './system'
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
  /** Whether this process may read Full-Disk-Access-protected files (and so ~/Documents without prompts). */
  fullDiskAccess: boolean
}

/** chat.db is readable only with Full Disk Access, and checking it never pops up a prompt. */
function hasFullDiskAccess(): boolean {
  try {
    closeSync(openSync(join(homedir(), 'Library', 'Messages', 'chat.db'), 'r'))
    return true
  } catch {
    return false
  }
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
  })

  const chats = chatSource({ store, liveSessions: () => liveSessions() })
  const watcher = new SessionWatcher({
    liveSessions: () => liveSessions(),
    conversation: s => liveConversation(s),
    queued: sessionId => store.active()?.sessionId === sessionId || store.pendingForSession(sessionId) !== null,
    limits: () => runner.limits(),
    kvGet: key => store.kvGet(key),
    kvSet: (key, value) => store.kvSet(key, value),
    notify: notice => notifier.send(notice),
    enabled: () => config.watchSessions,
    now: Date.now,
  })

  const commandContext = (source: 'cli' | 'imessage', cwd?: string) => ({
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
      } catch (err) {
        log(`ignoring config.json change: ${err instanceof Error ? err.message : err}`)
      }
    }
    folders.refreshIfStale()
    // About every 30 s: did one of your other chats (VS Code, a terminal) stop on a usage limit?
    if (++watchTicks % 15 === 0) {
      try {
        watcher.check()
      } catch (err) {
        log(`watching other chats failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    await runner.tick()
    keepAwake.set(config.keepAwake && runner.hasWork())
  }, 2000)

  function shutdown(code = 0): void {
    log('stopping (Claude sessions in tmux keep running and are picked up on the next start)')
    clearInterval(timer)
    keepAwake.set(false)
    bridge?.stop()
    telegram?.stop()
    server.stop(true)
    store.close()
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())

  log(`${BRAND.name} ${VERSION} listening on 127.0.0.1:${config.port} · claude ${claudePath} · tmux -L ${TMUX_SOCKET} · state ${CQ_HOME}`)
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
