import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, resolve } from 'node:path'
import { BRAND } from '../shared/brand'
import { expandHome, findExecutable, findGitBash, loadConfig, saveConfig, type Config } from '../shared/config'
import { folderLabel, folderPath, suggestProjectFolders, type FolderSuggestion } from '../daemon/folder-suggest'
import { within } from '../shared/paths'
import type { Effort, ExecMode } from '../shared/types'
import { inContainer, installHint, isMac, isWindows, isWsl } from '../platform/os'
import { awakeCommand } from './awake'
import { findToken, maskToken, openLink, readClipboard } from './clipboard'
import { claudeStatus, doctor } from './doctor'
import { install, migrateIfNeeded, type InstallResult } from './install'
import { telegramCommand } from './telegram'
import { ask, confirmYes, daemonHealth, restartAgent, run, runHere } from './util'

/** "/Users/me/code" → "~/code" (on Windows "C:\Users\me\code" → "~/code" too, which expandHome reads back). */
const tilde = (p: string) => {
  const home = homedir()
  if (isWindows) return within(home, p) ? ('~' + p.slice(home.length)).replace(/\\/g, '/') : p
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export { folderPath }

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

/**
 * The folders where Claude may work, without typing: found from where you've used Claude Code and
 * where git projects are, all chosen at once. Enter takes them; numbers pick some; a path adds one.
 */
export function chooseFolders(current: string[], o: { wsl?: boolean; found?: FolderSuggestion[] } = {}): string[] {
  const wsl = o.wsl ?? isWsl()
  const found = o.found ?? suggestProjectFolders({ wsl })
  const label = (p: string) => folderLabel(p, { wsl })
  if (found.length === 0) {
    const keep = current.length > 0 ? current : []
    console.log(`  I couldn't find your projects, so Claude can work anywhere in your home folder${keep.length > 0 ? ` (and ${keep.map(label).join(', ')})` : ''}.`)
    console.log('  You can add folders later from Telegram: Settings → Project folders.')
    return keep
  }
  console.log('  I found these, from where you have used Claude Code and where your git projects are:')
  found.forEach((f, i) => console.log(`    ${i + 1}) ${label(f.path)}  (${f.why})`))
  console.log('  Claude will only work inside the folders you choose, and you can change them later from Telegram.')
  const all = found.map((_, i) => i + 1).join(',')
  for (;;) {
    const answer = ask('  Press Enter to use all of these, or type numbers (like 1,3) or a folder', all)
    const parsed = parseFolderChoice(answer, found.map(f => f.path))
    if (typeof parsed === 'string') {
      console.log(`  ${parsed}`)
      continue
    }
    return parsed
  }
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
let stepTotal = 0
function step(title: string): void {
  stepNo++
  console.log(`\nStep ${stepNo} of ${stepTotal}: ${title}`)
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
  const where = isMac ? 'Mac' : isWindows || isWsl() ? 'PC' : 'computer'
  console.log(`  While tasks run, the ${where} stays awake by itself, and sleeps as usual once they're done.`)
  if (isWindows || isWsl()) {
    console.log('  With the lid closed, Windows decides: set "When I close the lid: Do nothing" in Control Panel → Power Options.')
    return
  }
  if (!confirmYes('  Is this a laptop you want to keep working with its lid closed?')) {
    console.log('  Skipped. Turn it on later with: cq awake lid on')
    return
  }
  if (!(await awakeCommand(['lid', 'on']))) console.log('  Skipped. Try it again later with: cq awake lid on')
}

export async function telegramStep(): Promise<void> {
  const config = loadConfig()
  if (config.telegram.enabled && config.telegram.ownerId) {
    console.log(`  ✔ Already connected${config.telegram.ownerName ? ` and paired with ${config.telegram.ownerName}` : ''}.`)
    return
  }
  console.log('  You talk to Afterhours through a Telegram bot that only you can use. Making one takes a minute:')
  console.log('    1. Telegram opens on BotFather (Telegram\'s official bot for making bots). If it doesn\'t, search for @BotFather.')
  console.log('    2. Send it /newbot, then pick a name and a username that ends in "bot".')
  console.log('    3. It replies with a token, a long code like 123456789:AAH4… Tap it to copy.')
  if (confirmYes('  Open BotFather in Telegram now?')) openLink('https://t.me/BotFather')
  for (;;) {
    const typed = ask('  After you copy the token, press Enter (or paste it here, or type "skip")')
    if (/^skip$/i.test(typed)) {
      console.log('  Skipped. Connect it later with: cq telegram <token>')
      return
    }
    // Pasted here, or still on the clipboard.
    const token = findToken(typed) ?? (typed ? null : findToken(readClipboard()))
    if (!token) {
      console.log(typed ? "  That doesn't look like a bot token (it looks like 123456789:AAH4…)." : "  I couldn't find a token on your clipboard. Copy it in Telegram first, then press Enter.")
      continue
    }
    if (!typed) {
      console.log(`  Found it: ${maskToken(token)}`)
      if (!confirmYes('  Use this token?')) continue
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

export async function setup(o: { custom?: boolean } = {}): Promise<void> {
  stepNo = 0
  // Steps this run will show: Claude, Git Bash or tmux, folders, (defaults), background, (Mac: disk access), (awake), phone.
  stepTotal = 5 + (o.custom ? 1 : 0) + (isMac ? 1 : 0) + (inContainer() ? 0 : 1)
  console.log(`${BRAND.name} setup: queue Claude Code tasks from Telegram; they run on this ${isMac ? 'Mac' : isWindows || isWsl() ? 'PC' : 'computer'} while you're away.`)
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
    const installer = isWindows
      ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']
      : ['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']
    if (!runHere(installer)) {
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

  if (isWindows) {
    // No tmux on Windows: tasks run in cq's own terminal host. Claude Code needs Git Bash, though.
    step('Git for Windows (Claude Code runs its commands with its bash)')
    if (!findGitBash()) {
      const hint = installHint('git')
      if (!confirmYes(`  Git for Windows is missing. Install it now (${hint})?`)) {
        console.log(`  ✖ Install Git for Windows (${hint}, or https://git-scm.com/downloads/win), then run cq setup again.`)
        return
      }
      if (!runHere([...hint.split(' '), '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']) || !findGitBash()) {
        console.log('  ✖ Git did not install. Install it from https://git-scm.com/downloads/win, open a new terminal, and run cq setup again.')
        return
      }
    }
    console.log(`  ✔ ${run(['git', '--version']).out || 'Git for Windows'} (${findGitBash()})`)
  } else {
    step('tmux (runs Claude in the background)')
    if (!(await tmuxStep())) return
  }

  step('Your project folders (where Claude may work)')
  const config = loadConfig()
  config.folders.roots = chooseFolders(config.folders.roots).map(tilde)

  if (o.custom) {
    step('Defaults for new tasks (each task can still change them)')
    askDefaults(config)
  } else {
    console.log('\nNew tasks start with the recommended settings (Claude plans first, Sonnet, high effort, on its own git branch).')
    console.log('You can change any of it on a task from your phone. For these questions here: cq setup --custom')
  }
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

  console.log(`\nAll set. Open Telegram and send your bot what Claude should do; ${BRAND.name} takes it from there.`)
  console.log('Everything else (folders, settings, sleep) is in the bot too. In a terminal, just type cq for a short menu.\n')
  await doctor()
}

async function tmuxStep(): Promise<boolean> {
  if (!findExecutable('tmux')) {
    const hint = installHint('tmux')
    // Only a command we know how to run (a package manager was found): never guess one.
    if (/^install /.test(hint) || !confirmYes(`  tmux is missing. Install it now (${hint})?`)) {
      console.log(`  ✖ Install tmux (${hint}), then run cq setup again.`)
      return false
    }
    if (Bun.spawnSync(['sh', '-c', hint], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
      console.log(`  ✖ That did not work${isMac ? ' (Homebrew is from https://brew.sh)' : ''}. Install tmux yourself, then run cq setup again.`)
      return false
    }
    if (!findExecutable('tmux')) {
      console.log('  ✖ tmux did not install. Install it yourself, then run cq setup again.')
      return false
    }
  }
  console.log(`  ✔ ${run([findExecutable('tmux')!, '-V']).out}`)
  return true
}
