import { BRAND } from '../shared/brand'
import type { Config } from '../shared/config'
import type { ExecMode, Job } from '../shared/types'

/** Single-quotes a string for the shell Claude Code runs hook commands with. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface ScriptPaths {
  hook: string
  status: string
}

/**
 * Settings passed with --settings for one queue session only. They layer on top of the
 * user's own settings and never touch ~/.claude/settings.json.
 */
export function sessionSettings(job: Job, config: Config, scripts: ScriptPaths): Record<string, unknown> {
  const command = (event: string, timeout: number) => ({
    type: 'command',
    command: `${shq(scripts.hook)} ${event}`,
    timeout,
  })
  const on = (event: string, timeout = 15) => [{ hooks: [command(event, timeout)] }]
  const settings: Record<string, unknown> = {
    autoContinueAtUsageLimit: true,
    // Safety net only: the PreToolUse hook below answers questions before Claude shows them.
    askUserQuestionTimeout: '10m',
    statusLine: { type: 'command', command: shq(scripts.status), refreshInterval: 60 },
    hooks: {
      SessionStart: on('SessionStart'),
      UserPromptSubmit: on('UserPromptSubmit'),
      // Waits for your iMessage reply, so it needs room beyond the approval timeout.
      PermissionRequest: on('PermissionRequest', config.timeouts.approvalSec + 60),
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [command('PreToolUse', config.timeouts.questionSec + 60)] },
        // Every tool call as it starts, for apps watching the task; async, so nothing waits on it.
        { hooks: [{ ...command('ToolStart', 15), async: true }] },
      ],
      // Activity signal for the watchdog and `st`; async, so tool calls never wait on it.
      PostToolUse: [{ hooks: [{ ...command('PostToolUse', 15), async: true }] }],
      Stop: on('Stop', 30),
      StopFailure: on('StopFailure'),
      Notification: on('Notification'),
      SessionEnd: on('SessionEnd'),
    },
  }
  if (job.execMode === 'bypassPermissions') settings.skipDangerousModePermissionPrompt = true
  return settings
}

export function startMode(job: Job): 'plan' | ExecMode {
  return job.plan && !job.planApproved ? 'plan' : job.execMode
}

export interface ArgvOptions {
  claudePath: string
  settingsPath: string
  /** --session-id <new> | --resume <id> [--fork-session --session-id <new>] */
  sessionArgs: string[]
  prompt: string
  name?: string
  remoteControl?: boolean
  /** Extra folders the session may read (an app's uploads). */
  addDirs?: string[]
}

export function claudeArgv(job: Job, o: ArgvOptions): string[] {
  const argv = [
    o.claudePath,
    ...o.sessionArgs,
    '--model',
    job.model,
    '--effort',
    job.effort,
    '--permission-mode',
    startMode(job),
    '--settings',
    o.settingsPath,
  ]
  if (job.execMode === 'bypassPermissions') argv.push('--allow-dangerously-skip-permissions')
  if (o.name) argv.push('--name', o.name)
  for (const dir of o.addDirs ?? []) argv.push('--add-dir', dir)
  if (o.remoteControl) argv.push(`--remote-control=cq-${job.id}`)
  // `--` so a prompt that starts with "-" is never read as a flag.
  argv.push('--', o.prompt)
  return argv
}

export function sessionName(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return `${BRAND.name}: ${oneLine.length > 48 ? oneLine.slice(0, 47) + '…' : oneLine}`
}
