import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { BRAND } from '../shared/brand'
import { detectCodeFolders, expandHome, findExecutable, loadConfig, saveConfig, type Config } from '../shared/config'
import type { Effort, ExecMode } from '../shared/types'
import { inContainer, installHint, isMac, isWsl } from '../platform/os'
import { awakeCommand } from './awake'
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

/**
 * What a person types for a folder, as a path here: quotes and a trailing slash dropped, "\\ " read
 * as a space, and (inside WSL) a Windows path such as D:\\IT Works turned into /mnt/d/IT Works.
 */
export function folderPath(typed: string, wsl = isWsl()): string {
  let t = typed.trim()
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim()
  t = t.replace(/\\ /g, ' ')
  const drive = /^([A-Za-z]):(?:[\\/]+(.*))?$/.exec(t)
  if (drive && wsl) t = `/mnt/${drive[1]!.toLowerCase()}/${(drive[2] ?? '').replace(/\\/g, '/')}`
  t = t.replace(/\/+$/, '')
  return resolve(expandHome(t || '/'))
}

/**
 * "1, 3", "1 ~/work" or a path (spaces and Windows paths included) → folders; a string is what to
 * tell the person instead. Commas separate; inside a piece, numbers separate by spaces, but a piece
 * that is a folder as it stands (D:\IT Works) is taken whole.
 */
export function parseFolderChoice(answer: string, candidates: string[], wsl = isWsl()): string[] | string {
  const pieces = answer.split(',').map(x => x.trim()).filter(Boolean)
  if (pieces.length === 0) return 'Pick at least one folder.'
  const out: string[] = []
  for (const piece of pieces) {
    const whole = /^[\d\s]+$/.test(piece) ? null : folderPath(piece, wsl)
    if (whole && isDir(whole)) {
      out.push(whole)
      continue
    }
    // Not a folder as a whole: numbers and paths without spaces, separated by spaces.
    for (const t of piece.split(/\s+/)) {
      if (/^\d+$/.test(t)) {
        const p = candidates[Number(t) - 1]
        if (!p) return `There's no option ${t}.`
        out.push(p)
      } else {
        const p = folderPath(t, wsl)
        if (!isDir(p)) {
          // A path with spaces is reported whole, not as the word that stopped it.
          const shown = /^\d/.test(piece) ? t : piece
          return `Not a folder: ${shown}${wsl && /^[A-Za-z]:/.test(shown) ? ` (looked for ${folderPath(shown, wsl)})` : ''}`
        }
        out.push(p)
      }
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

/** While tasks run the computer stays awake (the default); a laptop can also work with its lid closed. */
async function awakeStep(): Promise<void> {
  const where = isMac ? 'Mac' : isWsl() ? 'PC' : 'computer'
  console.log(`  While tasks run, the ${where} stays awake by itself, and sleeps as usual once they're done.`)
  if (isWsl()) {
    console.log('  With the lid closed, Windows decides: set "When I close the lid: Do nothing" in Control Panel → Power Options.')
    return
  }
  if (!confirmYes('  Is this a laptop you want to keep working with its lid closed?')) {
    console.log('  Skipped. Turn it on later with: cq awake lid on')
    return
  }
  if (!(await awakeCommand(['lid', 'on']))) console.log('  Skipped. Try it again later with: cq awake lid on')
}

async function telegramStep(): Promise<void> {
  const config = loadConfig()
  if (config.telegram.enabled && config.telegram.ownerId) {
    console.log(`  ✔ Already connected${config.telegram.ownerName ? ` and paired with ${config.telegram.ownerName}` : ''}.`)
    return
  }
  console.log('  You talk to Afterhours through a Telegram bot that only you can use. Making one takes a minute:')
  console.log('    1. In Telegram, search for @BotFather (the one with the blue check) and open it.')
  console.log('    2. Send it /newbot, then pick a name and a username that ends in "bot".')
  console.log('    3. It replies with a token, a long code like 123456789:AAH4… Copy it.')
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
  console.log(`${BRAND.name} setup: queue Claude Code tasks from Telegram; they run on this ${isMac ? 'Mac' : isWsl() ? 'PC' : 'computer'} while you're away.`)
  console.log('It takes about five minutes. You can press Ctrl+C at any time and run cq setup again.')
  if (!migrateIfNeeded()) return

  step('Claude Code')
  let claude = claudeStatus()
  if (!claude.path) {
    console.log('  Afterhours runs Claude Code, Anthropic’s coding assistant, with your own Claude account.')
    if (!confirmYes('  Install it now (its official installer, from claude.ai)?')) {
      console.log('  ✖ Install Claude Code (https://claude.com/claude-code), then run cq setup again.')
      return
    }
    if (Bun.spawnSync(['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
      console.log('  ✖ The Claude Code installer did not finish. See https://claude.com/claude-code, then run cq setup again.')
      return
    }
    claude = claudeStatus()
    if (!claude.path) {
      console.log('  ✖ Claude Code installed, but cq cannot find it. Open a new terminal and run cq setup again.')
      return
    }
  }
  if (!claude.loggedIn) {
    console.log(`  Claude Code ${claude.version} needs you to sign in with your Claude account (a Pro or Max plan, or an API key).`)
    console.log('  It opens now: sign in (it shows a link to open in a browser), then type /exit to come back here.')
    if (confirmYes('  Sign in now?')) {
      Bun.spawnSync([claude.path, '/login'], { stdio: ['inherit', 'inherit', 'inherit'] })
      claude = claudeStatus()
    }
    if (!claude.loggedIn) {
      console.log('  ✖ Not signed in yet. Run `claude`, sign in, then run cq setup again.')
      return
    }
  }
  console.log(`  ✔ ${claude.version}, signed in${claude.authMethod ? ` (${claude.authMethod})` : ''}. ${BRAND.name} uses it as you would, with your own plan.`)

  step('tmux (runs Claude in the background)')
  if (!findExecutable('tmux')) {
    const hint = installHint('tmux')
    // Only a command we know how to run (a package manager was found): never guess one.
    if (/^install /.test(hint) || !confirmYes(`  tmux is missing. Install it now (${hint})?`)) {
      console.log(`  ✖ Install tmux (${hint}), then run cq setup again.`)
      return
    }
    if (Bun.spawnSync(['sh', '-c', hint], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
      console.log(`  ✖ That did not work${isMac ? ' (Homebrew is from https://brew.sh)' : ''}. Install tmux yourself, then run cq setup again.`)
      return
    }
    if (!findExecutable('tmux')) {
      console.log('  ✖ tmux did not install. Install it yourself, then run cq setup again.')
      return
    }
  }
  console.log(`  ✔ ${run([findExecutable('tmux')!, '-V']).out}`)

  step('Your code folders (what you browse and search from your phone)')
  const config = loadConfig()
  const candidates = detectCodeFolders()
  candidates.forEach((p, i) => console.log(`    ${i + 1}) ${tilde(p)}`))
  if (candidates.length === 0) console.log('    (none of the usual places exist; type a path)')
  if (isWsl()) console.log('    (Windows folders work too: type D:\\Projects or "D:\\My Projects", and it finds them under /mnt/d)')
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

  if (isMac) {
    step('Full Disk Access')
    await fullDiskAccess(result)
  }

  if (!inContainer()) {
    step('Staying awake')
    await awakeStep()
  }

  step('Your phone (Telegram)')
  await telegramStep()

  console.log(`\nAll set. Send your bot a prompt; ${BRAND.name} takes it from there.\n`)
  await doctor()
}
