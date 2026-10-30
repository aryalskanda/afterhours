// `cq awake`: keeping the computer awake while tasks run. Idle sleep is held off by default
// (keepAwake). `cq awake lid on` keeps it awake with the lid closed too: on Linux, a systemd-inhibit
// lock on the lid switch; on a Mac it takes turning sleep off (pmset disablesleep) and so root: it
// asks for your password once, to put a sudo rule in place that allows exactly that and nothing else
// (platform/power.ts). On Windows, the power plan's lid action is set to "do nothing" while tasks run
// and put back after; no rights needed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { LOW_BATTERY_PCT } from '../daemon/awake'
import { machineWord, powerSystem, SUDOERS_FILE, sudoersRule, systemSleepSwitch, windowsLidSwitch } from '../platform/power'
import { loadConfig, saveConfig } from '../shared/config'

const USAGE = 'Usage: cq awake [status] | cq awake on|off | cq awake lid on|off'

/** Asks for your password (in this terminal) to put the sudo rule in place; true once it works. */
export async function installRule(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'cq-awake-'))
  const file = join(dir, 'afterhours')
  try {
    writeFileSync(file, sudoersRule(userInfo().username), { mode: 0o600 })
    console.log(`Closing the lid sleeps the Mac unless sleep is turned off, which takes your password.`)
    console.log(`This asks for it once, to allow only "pmset -a disablesleep 1" and "… 0" without it (${SUDOERS_FILE}).`)
    const run = (argv: string[]) => Bun.spawnSync(argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exitCode === 0
    // visudo checks the rule first: a broken file in sudoers.d would break sudo.
    if (!run(['sudo', '/usr/sbin/visudo', '-cf', file])) return false
    if (!run(['sudo', '/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'wheel', file, SUDOERS_FILE])) return false
    return await systemSleepSwitch.allowed()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function awakeCommand(args: string[]): Promise<boolean> {
  const config = loadConfig()
  const power = powerSystem()
  const word = power ? machineWord(power.kind) : 'computer'
  const [sub, value] = args
  if (sub === undefined || sub === 'status') {
    console.log(`While tasks run: ${config.keepAwake ? `the ${word} stays awake` : `the ${word} may sleep (cq awake on to change)`}`)
    if (power?.kind === 'mac') {
      const ready = await systemSleepSwitch.allowed()
      console.log(`With the lid closed: ${config.keepAwakeLidClosed ? (ready ? 'stays awake too' : 'on, but not set up: run cq awake lid on') : 'sleeps (cq awake lid on to change)'}`)
      if (await power.sleepDisabled()) console.log('Sleep is turned off on this Mac right now.')
    } else if (power?.kind === 'linux') {
      console.log(`With the lid closed: ${config.keepAwakeLidClosed ? 'stays awake too (a systemd-inhibit lock on the lid switch)' : 'sleeps (cq awake lid on to change)'}`)
    } else if (power?.kind === 'wsl') {
      const ready = await windowsLidSwitch.allowed()
      console.log(`With the lid closed: ${config.keepAwakeLidClosed ? (ready ? 'stays awake too (the power plan’s lid action is "do nothing" while tasks run)' : 'on, but Windows wouldn’t let Afterhours change it: set "When I close the lid: Do nothing" in Windows’ power settings') : 'sleeps (cq awake lid on to change)'}`)
    }
    return true
  }
  if (sub === 'on' || sub === 'off') {
    saveConfig({ ...config, keepAwake: sub === 'on', ...(sub === 'off' ? { keepAwakeLidClosed: false } : {}) })
    console.log(sub === 'on' ? `While tasks run, the ${word} stays awake.` : `The ${word} sleeps as it usually does, tasks or not.`)
    return true
  }
  if (sub !== 'lid' || (value !== 'on' && value !== 'off')) {
    console.error(USAGE)
    return false
  }
  if (value === 'off') {
    saveConfig({ ...config, keepAwakeLidClosed: false })
    console.log(`Off: closing the lid sleeps the ${word} again, tasks or not.`)
    if (power?.kind === 'mac') console.log(`The sudo rule stays, unused; remove it with: sudo rm ${SUDOERS_FILE}`)
    return true
  }
  if (power?.kind === 'linux') {
    if (!Bun.which('systemd-inhibit')) {
      console.error('This needs systemd (systemd-inhibit), which this system doesn’t have.')
      return false
    }
    saveConfig({ ...config, keepAwake: true, keepAwakeLidClosed: true })
    console.log('Done. While tasks run, closing the lid doesn’t sleep the computer; once they’re done, it does again.')
    return true
  }
  if (power?.kind === 'wsl') {
    if (!(await windowsLidSwitch.allowed())) {
      console.error('Windows wouldn’t let Afterhours change what closing the lid does. Set "When I close the lid: Do nothing" in Windows’ power settings (Control Panel → Power Options → Choose what closing the lid does).')
      return false
    }
    saveConfig({ ...config, keepAwake: true, keepAwakeLidClosed: true })
    console.log('Done. While tasks run, closing the lid doesn’t sleep the PC; once they’re done, Windows’ own setting is put back.')
    console.log(`On battery below ${LOW_BATTERY_PCT}% it may sleep. Turn it off with: cq awake lid off`)
    return true
  }
  if (power?.kind !== 'mac') {
    console.error('There is no lid to hold here.')
    return false
  }
  if (!(await systemSleepSwitch.allowed()) && !(await installRule())) {
    console.error("It isn't set up, so nothing changed.")
    return false
  }
  saveConfig({ ...config, keepAwake: true, keepAwakeLidClosed: true })
  console.log(`Done. While tasks run, the Mac stays awake with its lid closed too, and sleeps normally once they're done.`)
  console.log(`On battery below ${LOW_BATTERY_PCT}% it may sleep. Turn it off with: cq awake lid off`)
  return true
}
