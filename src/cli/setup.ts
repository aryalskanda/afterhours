import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { BRAND } from '../shared/brand'
import { detectCodeFolders, expandHome, findExecutable, loadConfig, saveConfig, type Config } from '../shared/config'
import type { Effort, ExecMode } from '../shared/types'
import { claudeStatus, doctor } from './doctor'
import { install, migrateIfNeeded, type InstallResult } from './install'
import { telegramCommand, TOKEN_RE } from './telegram'
import { ask, confirmYes, daemonHealth, restartAgent, run } from './util'

const tilde = (p: string) => (p === homedir() || p.startsWith(homedir() + '/') ? '~' + p.slice(homedir().length) : p)

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** "1, 3" or "1 ~/work" → folders; a string is what to tell the person instead. */
export function parseFolderChoice(answer: string, candidates: string[]): string[] | string {
  const tokens = answer.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return 'Pick at least one folder.'
  const out: string[] = []
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      const p = candidates[Number(t) - 1]
      if (!p) return `There's no option ${t}.`
      out.push(p)
    } else {
      const p = resolve(expandHome(t))
      if (!isDir(p)) return `Not a folder: ${t}`
      out.push(p)
    }
  }
  return [...new Set(out)]
}

function choose<T extends string>(label: string, options: [T, string][], current: string): T {
  options.forEach(([value, hint], i) => console.log(`    ${i + 1}) ${value}${hint ? ` · ${hint}` : ''}`))
  const fallback = String(Math.max(1, options.findIndex(([v]) => v === current) + 1))
  for (;;) {
    const answer = ask(`  ${label}`, fallback)
    const picked = options[Number(answer) - 1] ?? options.find(([v]) => v === answer)
    if (picked) return picked[0]
    console.log('  Pick one of the numbers above.')
  }
}

let stepNo = 0
function step(title: string): void {
  stepNo++
  console.log(`\n${stepNo}. ${title}`)
}

async function waitForHealth(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    const h = await daemonHealth()
    if (h) return h
    await Bun.sleep(1000)
  }
  return null
}

async function fullDiskAccess(result: InstallResult): Promise<void> {
  const first = await waitForHealth(15)
  if (first?.fullDiskAccess) {
    console.log('  ✔ Already granted.')
    return
  }
  console.log(`  The Claude sessions ${BRAND.name} starts need this to work in your folders while nobody is there to click "Allow".`)
  console.log('  Opening System Settings → Privacy & Security → Full Disk Access.')
  console.log(`  Click +, press ⌘⇧G, paste the path below, then switch it on:\n\n    ${result.program}\n`)
  run(['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
  for (let attempt = 0; attempt < 5; attempt++) {
    ask("  Press Enter when it's switched on")
    restartAgent()
    await Bun.sleep(2000)
    const health = await waitForHealth(15)
    if (health?.fullDiskAccess) {
      console.log('  ✔ Granted.')
      return
    }
    console.log(`  ✖ Not yet. Check that the switch next to ${result.program.split('/').pop()} is on.`)
  }
  console.log('  Skipping for now. Once it is on, run cq restart and then cq doctor.')
}

async function telegramStep(): Promise<void> {
  const config = loadConfig()
  if (config.telegram.enabled && config.telegram.ownerId) {
    console.log(`  ✔ Already connected${config.telegram.ownerName ? ` and paired with ${config.telegram.ownerName}` : ''}.`)
    return
  }
  console.log('  In Telegram, message @BotFather, send /newbot, pick a name and a username ending in "bot", and copy the token it gives you.')
  for (;;) {
    const token = ask('  Paste the token (or press Enter to skip)')
    if (!token) {
      console.log('  Skipped. Run cq telegram <token> whenever you like.')
      return
    }
    if (!TOKEN_RE.test(token)) {
      console.log("  That doesn't look like a bot token (it looks like 123456789:AAH4…).")
      continue
    }
    if (await telegramCommand([token])) return
  }
}

const MODES: Record<'plan' | 'auto' | 'review', { plan: boolean; review: boolean; execMode: ExecMode }> = {
  plan: { plan: true, review: false, execMode: 'auto' },
  auto: { plan: false, review: false, execMode: 'auto' },
  review: { plan: true, review: true, execMode: 'auto' },
}

function askDefaults(config: Config): void {
  const d = config.defaults
  d.model = choose('Model', [['sonnet', 'balanced; the best fit for a Pro plan'], ['opus', 'strongest; uses your limit fastest'], ['haiku', 'fast and light']], d.model)
  d.effort = choose<Effort>('Effort', [['low', ''], ['medium', ''], ['high', 'recommended'], ['xhigh', ''], ['max', '']], d.effort)
  const mode = choose('Mode', [['plan', 'Claude plans first, then does it (recommended)'], ['auto', 'no plan'], ['review', 'you approve each plan from your phone']], d.review ? 'review' : d.plan ? 'plan' : 'auto')
  Object.assign(d, MODES[mode])
  config.isolate = confirmYes('  Run each new conversation on its own git branch, so your checkout is never touched?')
}

export async function setup(): Promise<void> {
  stepNo = 0
  console.log(`${BRAND.name} setup: queue Claude Code tasks from your phone; they run on this Mac while you're away.`)
  if (!migrateIfNeeded()) return

  step('Claude Code')
  const claude = claudeStatus()
  if (!claude.path) {
    console.log('  ✖ Claude Code isn’t installed. Install it (https://claude.com/claude-code), sign in, then run cq setup again.')
    return
  }
  if (!claude.loggedIn) {
    console.log(`  ✖ Claude Code ${claude.version} isn’t signed in. Run \`claude\`, sign in, then run cq setup again.`)
    return
  }
  console.log(`  ✔ ${claude.version}, signed in${claude.authMethod ? ` (${claude.authMethod})` : ''}. ${BRAND.name} uses it as you would, with your own plan.`)

  step('tmux (runs Claude in the background)')
  if (!findExecutable('tmux')) {
    const brew = findExecutable('brew')
    if (!brew || !confirmYes('  tmux is missing. Install it with Homebrew now?')) {
      console.log('  ✖ Install tmux (brew install tmux), then run cq setup again.')
      return
    }
    if (Bun.spawnSync([brew, 'install', 'tmux'], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) return
  }
  console.log(`  ✔ ${run([findExecutable('tmux')!, '-V']).out}`)

  step('Your code folders (what you browse and search from your phone)')
  const config = loadConfig()
  const candidates = detectCodeFolders()
  candidates.forEach((p, i) => console.log(`    ${i + 1}) ${tilde(p)}`))
  if (candidates.length === 0) console.log('    (none of the usual places exist; type a path)')
  for (;;) {
    const parsed = parseFolderChoice(ask('  Which hold your projects? Numbers or paths, separated by commas', candidates.length ? '1' : ''), candidates)
    if (typeof parsed === 'string') {
      console.log(`  ${parsed}`)
      continue
    }
    config.folders.roots = parsed.map(tilde)
    break
  }

  step('Defaults for new tasks (each task can still change them)')
  askDefaults(config)
  saveConfig(config)

  step(`Run ${BRAND.name} in the background`)
  const result = await install()
  if (!result) return

  step('Full Disk Access')
  await fullDiskAccess(result)

  step('Your phone')
  await telegramStep()

  console.log(`\nAll set. Send your bot a prompt; ${BRAND.name} takes it from there.\n`)
  await doctor()
}
