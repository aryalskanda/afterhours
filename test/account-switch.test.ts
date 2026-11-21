import { expect, test } from 'bun:test'
import { AccountSwitch, CODE_WAIT_MS, loginLink, parseAuthStatus, type AuthStatus, type SwitchState } from '../src/daemon/account'
import { FakeTmux } from './fakes'

const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=xyz&state=s1'
const SCREEN = `Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\nPaste code here if prompted >`

function setup(o: { running?: number[]; signedIn?: AuthStatus } = {}) {
  let now = 1_000_000
  const term = new FakeTmux()
  const told: SwitchState[] = []
  const logs: string[] = []
  let paused = false
  let running = o.running ?? []
  let changed = 0
  let account: AuthStatus = { loggedIn: true, email: 'old@example.com', plan: 'pro', method: 'claude.ai' }
  const sw = new AccountSwitch({
    term,
    claudePath: '/bin/claude',
    cwd: '/tmp',
    status: async () => account,
    logout: async () => ((account = { loggedIn: false, email: null, plan: null, method: null }), true),
    running: () => running,
    paused: () => paused,
    setPaused: on => (paused = on),
    accountChanged: () => void changed++,
    tell: s => told.push(s),
    now: () => now,
    log: l => logs.push(l),
  })
  const win = () => term.windows.get('account-login')!
  return {
    sw, term, told, logs, win,
    advance: (ms: number) => (now += ms),
    paused: () => paused,
    changed: () => changed,
    finish: () => (running = []),
    signIn: (a: AuthStatus) => (account = a),
  }
}

test('the sign-in link, even wrapped across lines; none until it has its state', () => {
  expect(loginLink(SCREEN)).toBe(URL)
  const wrapped = `visit: ${URL.slice(0, 80)}\n${URL.slice(80)}\nPaste code here if prompted >`
  expect(loginLink(wrapped)).toBe(URL)
  // The short form Claude Code prints in a narrow terminal.
  expect(loginLink("visit:\nhttps://claude.ai/oauth/authorize?z-ASkAue38f9U5GNmgJL6wZdhMJi\nPaste code here if prompted > ")).toBe('https://claude.ai/oauth/authorize?z-ASkAue38f9U5GNmgJL6wZdhMJi')
  expect(loginLink('Opening browser to sign in…')).toBeNull()
  // Still being printed: nothing after it yet.
  expect(loginLink(`visit: ${URL.slice(0, 60)}`)).toBeNull()
})

test('auth status: what is signed in, read leniently', () => {
  expect(parseAuthStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max","authMethod":"claude.ai"}')).toEqual({ loggedIn: true, email: 'a@b.c', plan: 'max', method: 'claude.ai' })
  expect(parseAuthStatus('not json').loggedIn).toBe(false)
})

test('a switch: the link comes, the code is typed (never logged), and the new account is signed in', async () => {
  const t = setup()
  expect((await t.sw.start()).stage).toBe('starting')
  expect(t.win().argv).toEqual(['/bin/claude', 'auth', 'login', '--claudeai'])
  expect(t.win().env.BROWSER).toBe('true')
  t.win().screen = SCREEN
  await t.sw.tick()
  expect(t.sw.current).toMatchObject({ stage: 'link', url: URL })
  expect((await t.sw.code('  CODE#123  ')).stage).toBe('checking')
  expect(t.win().input).toEqual(['text:CODE#123', 'Enter'])
  expect(t.logs.join('\n')).not.toContain('CODE#123')
  t.win().screen += '\nLogin successful'
  t.win().dead = true
  t.signIn({ loggedIn: true, email: 'new@example.com', plan: 'max', method: 'claude.ai' })
  await t.sw.tick()
  expect(t.sw.current).toMatchObject({ stage: 'done', account: { email: 'new@example.com' } })
  expect(t.changed()).toBe(1)
  expect(t.term.windows.has('account-login')).toBe(false)
  expect(t.told.map(s => s.stage)).toEqual(['starting', 'link', 'checking', 'done'])
})

test('a code that didn’t work: said, and the link is back for another try', async () => {
  const t = setup()
  await t.sw.start()
  t.win().screen = SCREEN
  await t.sw.tick()
  await t.sw.code('wrong')
  t.win().screen += '\nOAuth error: Invalid code\nPaste code here if prompted >'
  await t.sw.tick()
  expect(t.told.at(-2)).toMatchObject({ stage: 'failed', reason: expect.stringContaining('didn’t work') })
  expect(t.sw.current.stage).toBe('link')
  // The old error doesn't count against the next code.
  await t.sw.code('right')
  await t.sw.tick()
  expect(t.sw.current.stage).toBe('checking')
})

test('with a task running: the queue pauses, it waits, then signs in, and resumes the queue after', async () => {
  const t = setup({ running: [244] })
  expect(await t.sw.start()).toEqual({ stage: 'waiting', job: 244 })
  expect(t.paused()).toBe(true)
  await t.sw.tick()
  expect(t.term.windows.has('account-login')).toBe(false)
  t.finish()
  await t.sw.tick()
  expect(t.sw.current.stage).toBe('starting')
  t.win().screen = SCREEN
  await t.sw.tick()
  await t.sw.code('c')
  t.win().dead = true
  await t.sw.tick()
  expect(t.sw.current.stage).toBe('done')
  expect(t.paused()).toBe(false)
})

test('no code within 15 minutes: the old account stays, and so does a pause it didn’t make', async () => {
  const t = setup()
  await t.sw.start()
  t.win().screen = SCREEN
  await t.sw.tick()
  t.advance(CODE_WAIT_MS + 1000)
  await t.sw.tick()
  expect(t.sw.current).toMatchObject({ stage: 'failed', reason: expect.stringContaining('stays signed in') })
  expect(t.term.windows.has('account-login')).toBe(false)
  expect(t.changed()).toBe(0)
})

test('stopped by you: the terminal closes and nothing changes', async () => {
  const t = setup({ running: [7] })
  await t.sw.start()
  expect((await t.sw.cancel()).stage).toBe('failed')
  expect(t.paused()).toBe(false)
})
