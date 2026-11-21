// Switching the Claude account Claude Code uses on this machine, from a phone: one account at a
// time, as you'd do it at the computer. `claude auth login` runs in a hidden terminal; without a
// browser here it prints a sign-in link, and after you sign in, that page shows a code, which is
// typed back in. Nothing is replaced until the new sign-in succeeds, so giving up leaves the old
// account signed in. While a task runs, the queue pauses and the switch waits for it.

import { cleanEnv } from '../shared/config'
import type { TmuxDriver } from './tmux'

/** What `claude auth status --json` says. The email is only ever shown to the owner, never logged. */
export interface AuthStatus {
  loggedIn: boolean
  email: string | null
  plan: string | null
  method: string | null
}

export type SwitchState =
  | { stage: 'idle' }
  /** A task is running: the queue is paused, and the switch starts once it's done. */
  | { stage: 'waiting'; job: number }
  | { stage: 'starting' }
  /** Open this, sign in, and send the code the page shows. */
  | { stage: 'link'; url: string; since: number }
  | { stage: 'checking' }
  | { stage: 'done'; account: AuthStatus }
  | { stage: 'failed'; reason: string }

export interface AccountDeps {
  term: TmuxDriver
  claudePath: string
  /** Where the login terminal starts (any folder; it touches no project). */
  cwd: string
  status(): Promise<AuthStatus>
  logout(): Promise<boolean>
  /** The tasks running now. */
  running(): number[]
  paused(): boolean
  setPaused(on: boolean): void
  /** The new account is signed in: its usage limits start fresh. */
  accountChanged(): void
  /** Every change of the switch, to whoever is following it (Telegram, the apps). */
  tell(state: SwitchState): void
  now(): number
  log(line: string): void
}

const WINDOW = 'account-login'
/** How long the sign-in link stays good for here: after this the old account stays signed in. */
export const CODE_WAIT_MS = 15 * 60_000
/** How long to wait for the link to show. */
const LINK_WAIT_MS = 30_000
/** How long to wait for Claude Code to take the code. */
const CHECK_WAIT_MS = 60_000

/** The sign-in link on `claude auth login`'s screen, with any line wraps taken out; null if not yet. */
export function loginLink(screen: string): string | null {
  const at = screen.search(/https:\/\/\S*oauth\/authorize\?/)
  if (at < 0) return null
  let url = ''
  // Complete once something follows it (the prompt, or an empty line): not while it's still printing.
  let ended = false
  for (const line of screen.slice(at).split('\n')) {
    const part = line.trim()
    if (!part || /\s/.test(part) || /^paste/i.test(part)) {
      ended = true
      break
    }
    url += part
  }
  // A long link (…&state=…) or a short one (…/authorize?<token>), depending on Claude Code.
  return ended && /\?[^\s]{16,}/.test(url) ? url : null
}

/** `claude auth status --json`, read leniently. */
export function parseAuthStatus(json: string): AuthStatus {
  try {
    const d = JSON.parse(json) as Record<string, unknown>
    const s = (k: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : null)
    return { loggedIn: d.loggedIn === true, email: s('email'), plan: s('subscriptionType') ?? s('planTier'), method: s('authMethod') }
  } catch {
    return { loggedIn: false, email: null, plan: null, method: null }
  }
}

/** How many times Claude Code has said a sign-in went wrong on this screen. */
function errorCount(screen: string): number {
  return (screen.match(/invalid|expired|error|failed/gi) ?? []).length
}

export class AccountSwitch {
  private state: SwitchState = { stage: 'idle' }
  /** The switch paused the queue, so it resumes it after. */
  private pausedIt = false
  private stageAt = 0
  private busy = false
  private errorsBefore = 0

  constructor(private readonly d: AccountDeps) {}

  get current(): SwitchState {
    return this.state
  }

  /** Starts a switch (or says where the one going on is). */
  async start(): Promise<SwitchState> {
    if (this.state.stage === 'waiting' || this.state.stage === 'starting' || this.state.stage === 'link' || this.state.stage === 'checking') return this.state
    const running = this.d.running()
    if (running.length > 0) {
      if (!this.d.paused()) {
        this.d.setPaused(true)
        this.pausedIt = true
      }
      this.d.log(`account: switching once #${running[0]} is done; the queue is paused meanwhile`)
      return this.set({ stage: 'waiting', job: running[0]! })
    }
    return this.signIn()
  }

  /** The code the sign-in page showed, typed into Claude Code. It's never logged. */
  async code(code: string): Promise<SwitchState> {
    if (this.state.stage !== 'link') return this.state
    const clean = code.trim()
    if (!clean) return this.state
    // Errors already on the screen (from a code before this one) don't count against this one.
    this.errorsBefore = errorCount(await this.d.term.capture(WINDOW, 80))
    await this.d.term.sendText(WINDOW, clean)
    await this.d.term.sendKeys(WINDOW, 'Enter')
    this.d.log('account: code sent; checking the sign-in')
    return this.set({ stage: 'checking' })
  }

  /** Stops the switch: the old account stays signed in. */
  async cancel(reason = 'Stopped. The account you had stays signed in.'): Promise<SwitchState> {
    if (this.state.stage === 'idle' || this.state.stage === 'done' || this.state.stage === 'failed') return this.state
    await this.d.term.killWindow(WINDOW).catch(() => {})
    this.resume()
    this.d.log('account: switch stopped')
    return this.set({ stage: 'failed', reason })
  }

  /** Signs out with no new account (the owner asked for it, twice). */
  async signOut(): Promise<boolean> {
    const ok = await this.d.logout()
    this.d.log(ok ? 'account: signed out' : "account: couldn't sign out")
    return ok
  }

  /** Every few seconds from the daemon. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.advance()
    } finally {
      this.busy = false
    }
  }

  private async advance(): Promise<void> {
    const now = this.d.now()
    const s = this.state
    if (s.stage === 'waiting') {
      if (this.d.running().length === 0) await this.signIn()
      return
    }
    if (s.stage === 'starting') {
      const url = loginLink(await this.d.term.capture(WINDOW, 80))
      if (url) {
        this.d.log('account: sign-in link ready')
        this.set({ stage: 'link', url, since: now })
      } else if (now - this.stageAt > LINK_WAIT_MS) {
        await this.fail("Claude Code didn't show a sign-in link. The account you had stays signed in.")
      }
      return
    }
    if (s.stage === 'link') {
      if (now - s.since > CODE_WAIT_MS) await this.fail('No code came within 15 minutes, so the account you had stays signed in. Start again when you’re ready.')
      return
    }
    if (s.stage === 'checking') {
      const screen = await this.d.term.capture(WINDOW, 40)
      const pane = await this.d.term.pane(WINDOW)
      if (errorCount(screen) > this.errorsBefore && !pane?.dead) {
        // Claude Code refused the code and is asking again: say so, then back to the link.
        const url = loginLink(screen)
        this.d.tell({ stage: 'failed', reason: 'That code didn’t work. Send it again (copy all of it), or start over.' })
        if (url) this.set({ stage: 'link', url, since: now })
        else await this.fail('That code didn’t work, and Claude Code stopped. Start again.')
        return
      }
      if (pane?.dead || /success|logged in|signed in/i.test(screen)) {
        const account = await this.d.status()
        await this.d.term.killWindow(WINDOW).catch(() => {})
        if (!account.loggedIn) return this.fail('Claude Code isn’t signed in after that. Start again.')
        this.d.log(`account: signed in (${account.plan ?? account.method ?? 'claude'})`)
        this.d.accountChanged()
        this.resume()
        this.set({ stage: 'done', account })
        return
      }
      if (now - this.stageAt > CHECK_WAIT_MS) await this.fail('Claude Code didn’t finish signing in. The account you had stays signed in.')
    }
  }

  private async signIn(): Promise<SwitchState> {
    await this.d.term.killWindow(WINDOW).catch(() => {})
    // BROWSER: nothing opens on this machine; the link goes to your phone instead.
    await this.d.term.spawnWindow(WINDOW, this.d.cwd, { BROWSER: 'true' }, [this.d.claudePath, 'auth', 'login', '--claudeai'])
    this.d.log('account: starting the sign-in')
    return this.set({ stage: 'starting' })
  }

  private async fail(reason: string): Promise<void> {
    await this.d.term.killWindow(WINDOW).catch(() => {})
    this.resume()
    this.d.log(`account: ${reason}`)
    this.set({ stage: 'failed', reason })
  }

  private resume(): void {
    if (this.pausedIt) this.d.setPaused(false)
    this.pausedIt = false
  }

  private set(s: SwitchState): SwitchState {
    this.state = s
    this.stageAt = this.d.now()
    this.d.tell(s)
    return s
  }
}

/** `claude auth …`, waited for. */
async function auth(claudePath: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn([claudePath, 'auth', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: cleanEnv() })
    const timer = setTimeout(() => proc.kill(), 20_000)
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { code, out }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { code: 1, out: '' }
  }
}

/** How Claude Code is signed in on this machine. */
export async function authStatus(claudePath: string): Promise<AuthStatus> {
  return parseAuthStatus((await auth(claudePath, ['status', '--json'])).out)
}

export async function authLogout(claudePath: string): Promise<boolean> {
  return (await auth(claudePath, ['logout'])).code === 0
}
