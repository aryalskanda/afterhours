import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BRAND } from './brand'
import type { Effort, ExecMode } from './types'

export const CQ_HOME = resolve(process.env.CQ_HOME ?? join(homedir(), BRAND.homeDir))

export const paths = {
  home: CQ_HOME,
  config: join(CQ_HOME, 'config.json'),
  token: join(CQ_HOME, 'token'),
  /** This machine's key for remote access (apps and the relay know it by its public half). */
  identity: join(CQ_HOME, 'identity.json'),
  db: join(CQ_HOME, 'state.db'),
  logs: join(CQ_HOME, 'logs'),
  log: join(CQ_HOME, 'logs', 'cqd.log'),
  /** The app's web build, when this machine serves it (cq app setup). */
  web: join(CQ_HOME, 'web'),
  /** The relay's keys and links, when this machine runs the relay itself. */
  relayDb: join(CQ_HOME, 'relay.db'),
  /** Problem reports sent from the apps. */
  appReports: join(CQ_HOME, 'logs', 'app-reports.log'),
  jobs: join(CQ_HOME, 'jobs'),
  /** Photos and files apps attach to tasks (kept 14 days). */
  uploads: join(CQ_HOME, 'uploads'),
  bin: join(CQ_HOME, 'bin'),
  binary: join(CQ_HOME, 'bin', 'cq'),
  hookScript: join(CQ_HOME, 'bin', 'cq-hook'),
  statusScript: join(CQ_HOME, 'bin', 'cq-statusline'),
  tmuxConf: join(CQ_HOME, 'tmux.conf'),
}

export const TMUX_SOCKET = process.env.CQ_TMUX_SOCKET ?? BRAND.slug
export const TMUX_SESSION = BRAND.slug
export const LAUNCH_AGENT_LABEL = BRAND.agentLabel

export interface Defaults {
  project?: string
  plan: boolean
  review: boolean
  execMode: ExecMode
  model: string
  /** With a plan: the model that carries it out, when it isn't `model` (plan with one, work with another). */
  workModel?: string | null
  effort: Effort
  /** With a plan: the effort that carries it out, when it isn't `effort`. */
  workEffort?: Effort | null
}

export interface Config {
  port: number
  defaults: Defaults
  /** Short names for project folders, e.g. { myapp: "/Users/me/code/myapp" }. */
  aliases: Record<string, string>
  /** Folders whose Claude Code "trust this folder?" prompt cq may accept on your behalf. */
  trustedDirs: string[]
  /** Run each new conversation on its own git branch (a worktree), so your checkout is never touched. */
  isolate: boolean
  notify: 'all' | 'important' | 'off'
  imessage: { enabled: boolean; allowSms: boolean }
  timeouts: {
    /** How long a permission request waits for your iMessage reply before it is denied. */
    approvalSec: number
    /** How long one of Claude's questions waits for your answer. */
    questionSec: number
    /** How long a `review` plan waits for your approval. */
    reviewSec: number
    /** No activity for this long while the session is idle means the job is stuck. */
    stuckSec: number
    /** Extra wait after a limit reset before cq types `continue` itself. */
    limitGraceSec: number
    /** A launch that hasn't produced its first event by then is stuck on a screen. */
    launchSec: number
    /**
     * After Claude's turn ends with background commands still running, how long to wait for
     * them before calling the job done (a dev server never finishes).
     */
    backgroundSec: number
  }
  /** The Telegram bot you control cq from. Set up with `cq telegram <token>`. */
  telegram: { enabled: boolean; token: string | null; ownerId: number | null; ownerName: string | null }
  /** The folder map the Telegram folder browser and search use. */
  /** The project folders searched and browsed (`cq folders`, or an owner in an app). `maxDepth` is no longer used: the map goes as deep as the tree, and two levels inside a project. */
  folders: { roots: string[]; maxDepth: number }
  /** Models offered as buttons. */
  models: string[]
  /** Start queue sessions with --remote-control so they show up in the Claude app. */
  remoteControl: boolean
  /** Tell you when one of your other Claude Code chats (VS Code, a terminal) stops on a usage limit. */
  watchSessions: boolean
  /** And continue it by itself at the reset: inside the open chat, else here. */
  autoContinueChats: boolean
  /** When a task that took a chat from VS Code ends, open the chat there again so VS Code is up to date. */
  reopenInVsCode: boolean
  /** Hold a `caffeinate -i` assertion while jobs are pending. */
  keepAwake: boolean
  /** And on a Mac, with the lid closed too: sleep turned off while jobs are pending (cq awake lid on). */
  keepAwakeLidClosed: boolean
  /** Remote access from the Afterhours apps, through a relay. Set up with `cq pair`. */
  remote: RemoteConfig
  claudePath?: string
  tmuxPath?: string
}

export interface RemoteConfig {
  enabled: boolean
  /** The relay's address, e.g. wss://relay.example.com/v1. */
  relay: string | null
  /** What the apps call this machine; empty means the computer's name. */
  name: string | null
  /** Folders apps may run tasks in, with their subfolders; empty means your home folder. */
  allowedRoots: string[]
  /** Whether apps may start tasks that skip every permission prompt (yolo / bypassPermissions). */
  allowBypass: boolean
  /** Whether apps may see the running task's terminal. */
  allowScreens: boolean
  /** Whether apps may type and press keys in a running task. */
  allowTyping: boolean
  /** Whether owners' apps may quit apps on this Mac and put it to sleep. */
  allowMac: boolean
  /**
   * Run the relay inside Afterhours, on this port of 127.0.0.1, serving the app's web build too
   * (cq app setup). This machine then reaches it locally; apps use `relay`, its public address.
   */
  serve: { port: number } | null
  /** Where that relay and the app are reachable from the internet, e.g. https://mac.tailnet.ts.net. */
  publicUrl: string | null
}

/** Whether `relay` is the relay this machine runs itself (remote.serve), at its public address. */
export function isOwnRelay(remote: Pick<RemoteConfig, 'relay' | 'publicUrl'>): boolean {
  if (!remote.relay || !remote.publicUrl) return false
  try {
    const relay = new URL(remote.relay)
    const own = new URL(remote.publicUrl)
    return relay.protocol === 'wss:' && own.protocol === 'https:' && relay.host === own.host
  } catch {
    return false
  }
}

export const DEFAULT_CONFIG: Config = {
  port: 7787,
  defaults: { plan: true, review: false, execMode: 'auto', model: 'sonnet', effort: 'high' },
  aliases: {},
  trustedDirs: [],
  isolate: true,
  notify: 'all',
  imessage: { enabled: false, allowSms: false },
  timeouts: {
    approvalSec: 900,
    questionSec: 900,
    reviewSec: 3600,
    stuckSec: 1200,
    limitGraceSec: 180,
    launchSec: 90,
    backgroundSec: 600,
  },
  telegram: { enabled: false, token: null, ownerId: null, ownerName: null },
  // Empty means "detect": see codeRoots(). `cq setup` asks.
  folders: { roots: [], maxDepth: 6 },
  models: ['opus', 'sonnet', 'haiku'],
  remoteControl: false,
  watchSessions: true,
  autoContinueChats: true,
  reopenInVsCode: true,
  keepAwake: true,
  keepAwakeLidClosed: false,
  remote: { enabled: false, relay: null, name: null, allowedRoots: [], allowBypass: false, allowScreens: true, allowTyping: true, allowMac: true, serve: null, publicUrl: null },
}

export function ensureHome(): void {
  for (const dir of [paths.home, paths.logs, paths.jobs, paths.bin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function loadConfig(): Config {
  let raw: Partial<Config> = {}
  try {
    raw = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<Config>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot parse ${paths.config}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    defaults: { ...DEFAULT_CONFIG.defaults, ...raw.defaults },
    aliases: { ...raw.aliases },
    trustedDirs: [...(raw.trustedDirs ?? [])],
    imessage: { ...DEFAULT_CONFIG.imessage, ...raw.imessage },
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...raw.timeouts },
    telegram: { ...DEFAULT_CONFIG.telegram, ...raw.telegram },
    folders: { ...DEFAULT_CONFIG.folders, ...raw.folders, roots: [...(raw.folders?.roots ?? DEFAULT_CONFIG.folders.roots)] },
    models: [...(raw.models ?? DEFAULT_CONFIG.models)],
    remote: { ...DEFAULT_CONFIG.remote, ...raw.remote, allowedRoots: [...(raw.remote?.allowedRoots ?? [])] },
  }
}

/** "~/x" → "/Users/me/x". */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Where people usually keep code, in the order `cq setup` suggests them. */
export const COMMON_CODE_FOLDERS = [
  '~/Documents/Programming',
  '~/Developer',
  '~/code',
  '~/Code',
  '~/Projects',
  '~/projects',
  '~/dev',
  '~/src',
  '~/repos',
  '~/workspace',
  '~/git',
  '~/Documents/GitHub',
  '~/Documents/Projects',
]

export function detectCodeFolders(): string[] {
  const seen = new Set<string>()
  return COMMON_CODE_FOLDERS.map(expandHome).filter(p => {
    if (seen.has(p.toLowerCase()) || !existsSync(p)) return false
    seen.add(p.toLowerCase())
    return true
  })
}

/** The folders the folder browser and search cover: configured, else detected, else home. */
export function codeRoots(config: Config): string[] {
  const configured = config.folders.roots.map(expandHome).filter(p => existsSync(p))
  if (configured.length > 0) return configured
  const detected = detectCodeFolders()
  return detected.length > 0 ? detected.slice(0, 3) : [homedir()]
}

export function saveConfig(config: Config): void {
  writeFileAtomic(paths.config, JSON.stringify(config, null, 2) + '\n', 0o600)
}

export function readToken(): string | null {
  try {
    return readFileSync(paths.token, 'utf8').trim() || null
  } catch {
    return null
  }
}

export function ensureToken(): string {
  const existing = readToken()
  if (existing) return existing
  const token = randomBytes(24).toString('hex')
  writeFileAtomic(paths.token, token + '\n', 0o600)
  return token
}

export function writeFileAtomic(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, path)
  chmodSync(path, mode)
}

/** PATH for the daemon and the sessions it starts: Claude, Homebrew and the system dirs first. */
export function searchPath(): string {
  const home = homedir()
  const fixed = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  const inherited = (process.env.PATH ?? '').split(':').filter(Boolean)
  return [...new Set([...fixed, ...inherited])].join(':')
}

/**
 * Environment for tmux and the Claude sessions inside it. Built from an allowlist so that
 * variables from the shell that launched cq (VS Code, another Claude session) never leak in:
 * Claude Code treats CLAUDECODE / CLAUDE_CODE_* as "you are nested inside another session".
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = [
    ...['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING'],
    // Set on purpose for a server or a container: Claude Code's sign-in without a browser
    // (claude setup-token), and the way out to the internet.
    ...['CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'],
  ]
  const env: Record<string, string> = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  env.HOME ??= homedir()
  // C.UTF-8 exists on every current Linux; en_US.UTF-8 often isn't generated on servers.
  env.LANG ??= process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  env.SHELL ??= ['/bin/zsh', '/bin/bash', '/bin/sh'].find(existsSync) ?? '/bin/sh'
  env.PATH = searchPath()
  env.TERM = 'xterm-256color'
  return { ...env, ...extra }
}

export function findExecutable(name: string, configured?: string): string | null {
  if (configured && existsSync(configured)) return configured
  return Bun.which(name, { PATH: searchPath() })
}
