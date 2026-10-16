// What a permission request does, in a plain line, and what to look at twice: deleting recursively,
// rewriting git history, running code from the internet, sudo, secrets, files outside the project.
// A guide for the person deciding, not a guard: the machine's rules and Claude Code's own checks stay.

export type RiskLevel = 'high' | 'medium' | 'low'

export interface Risk {
  level: RiskLevel
  /** What it does, in words ("Runs the tests"). Null when there's nothing clearer than the command. */
  summary: string | null
  /** Why to look twice, most serious first. */
  reasons: string[]
}

interface Rule {
  level: Exclude<RiskLevel, 'low'>
  test: RegExp
  reason: string
}

const RULES: Rule[] = [
  { level: 'high', test: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive)\b/i, reason: 'Deletes files and folders, recursively' },
  { level: 'high', test: /\bgit\s+push\b[^\n]*\s(--force\b|-f\b|--force-with-lease\b)/, reason: 'Rewrites history on the remote (force push)' },
  { level: 'high', test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)/, reason: 'Throws away uncommitted work' },
  { level: 'high', test: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: 'Runs a script straight from the internet' },
  { level: 'high', test: /(^|[;&|]\s*)sudo\b/, reason: 'Runs as the administrator (sudo)' },
  { level: 'high', test: /\b(mkfs|dd\s+if=|diskutil\s+erase|shutdown|reboot)\b/, reason: 'Touches disks or the machine itself' },
  { level: 'high', test: /\bchmod\s+(-R\s+)?777\b/, reason: 'Makes files writable by anyone' },
  { level: 'high', test: /(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|kube|docker)\b/, reason: 'Reaches into keys or credentials' },
  { level: 'high', test: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i, reason: 'Deletes database data' },
  { level: 'high', test: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, reason: 'Publishes a package' },
  { level: 'medium', test: /\bgit\s+push\b/, reason: 'Pushes to the remote' },
  { level: 'medium', test: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bgem\s+install\b|\bcargo\s+add\b/, reason: 'Installs packages from the internet' },
  { level: 'medium', test: /\b(curl|wget)\b/, reason: 'Reaches the internet' },
  { level: 'medium', test: /\bkill(all)?\s+(-9\s+)?/, reason: 'Stops processes' },
  { level: 'medium', test: /\bdocker\s+(system\s+prune|rm|rmi|volume\s+rm)\b/, reason: 'Removes Docker data' },
  { level: 'medium', test: /\b(export|set)\s+[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)\b|\.env\b/, reason: 'Handles secrets' },
  { level: 'medium', test: /\brm\b/, reason: 'Deletes files' },
]

/** What common commands do, first match wins. */
const SUMMARIES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/, () => 'Runs the tests'],
  [/^(npx\s+)?(jest|vitest|pytest|go\s+test|cargo\s+test)\b/, () => 'Runs the tests'],
  [/^(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|format)\b/, m => `Runs the project’s ${m[2]}`],
  [/^(npm|pnpm|yarn|bun)\s+run\s+(\S+)/, m => `Runs the script “${m[2]}”`],
  [/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b\s*(.*)$/, m => (m[3]?.trim() ? `Installs ${m[3].trim()}` : 'Installs the project’s packages')],
  [/^git\s+(status|diff|log|show|branch)\b/, () => 'Looks at the git repo'],
  [/^git\s+commit\b/, () => 'Commits changes'],
  [/^git\s+push\b/, () => 'Pushes commits to the remote'],
  [/^git\s+(checkout|switch)\s+(-b\s+)?(\S+)/, m => `Switches to the branch ${m[3]}`],
  [/^(ls|cat|head|tail|less|wc|find|grep|rg|tree)\b/, () => 'Reads files'],
  [/^rm\s+(-\S+\s+)*(\S+)/, m => `Deletes ${m[2]}`],
  [/^mkdir\b/, () => 'Makes a folder'],
  [/^(mv|cp)\b/, m => (m[1] === 'mv' ? 'Moves or renames files' : 'Copies files')],
  [/^(curl|wget)\b/, () => 'Downloads from the internet'],
  [/^(python3?|node|bun|deno|ruby)\s+(\S+)/, m => `Runs ${m[2]}`],
  [/^(make|just)\b\s*(\S*)/, m => (m[2] ? `Runs make ${m[2]}` : 'Runs make')],
  [/^docker\b/, () => 'Uses Docker'],
  [/^(gh)\s+pr\s+create\b/, () => 'Opens a pull request'],
]

const ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }

/** A Bash command's risk. */
export function commandRisk(command: string): Risk {
  const cmd = command.split('\n')[0]!.trim()
  const reasons: { level: RiskLevel; reason: string }[] = []
  for (const r of RULES) if (r.test.test(command) && !reasons.some(x => x.reason === r.reason)) reasons.push({ level: r.level, reason: r.reason })
  // A recursive delete already says "deletes"; a force push already says "pushes".
  const said = new Set(reasons.map(r => r.reason))
  const kept = reasons.filter(
    r => !(r.reason === 'Deletes files' && said.has('Deletes files and folders, recursively')) && !(r.reason === 'Pushes to the remote' && said.has('Rewrites history on the remote (force push)')),
  )
  kept.sort((a, b) => ORDER[a.level] - ORDER[b.level])
  return { level: kept[0]?.level ?? 'low', summary: summarize(cmd), reasons: kept.map(r => r.reason) }
}

function summarizeStep(step: string): string | null {
  for (const [re, say] of SUMMARIES) {
    const m = re.exec(step)
    if (m) return say(m)
  }
  return null
}

/** Each step of `a && b; c` in words: "Deletes build, then pushes commits to the remote". */
function summarize(cmd: string): string | null {
  // Changing folder isn't a step worth saying.
  const steps = cmd.split(/\s*(?:&&|;|\|\|)\s*/).filter(x => x && !/^cd(\s|$)/.test(x))
  const said = steps.map(summarizeStep)
  const known = said.filter((x): x is string => x !== null)
  if (known.length === 0) return null
  const text = known.slice(0, 3).map((x, i) => (i === 0 ? x : x[0]!.toLowerCase() + x.slice(1))).join(', then ')
  return known.length < steps.length || known.length > 3 ? `${text}, and more` : text
}

/** Whether `path` is inside `folder` (both absolute), or in a task's own branch checkout (`.claude/worktrees`). */
function inside(path: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, '')
  return path === f || path.startsWith(`${f}/`) || path.includes('/.claude/worktrees/')
}

const NONE: Risk = { level: 'low', summary: null, reasons: [] }

/**
 * A permission request's risk: the command for Bash, the file for edits and reads. Only commands
 * get a summary; for the rest the file or the site already says it.
 */
export function permissionRisk(tool: string | undefined, detail: string | undefined, folder: string | null): Risk {
  const d = (detail ?? '').trim()
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return commandRisk(d)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = d.split('\n')[0] ?? ''
      const secret = /(^|\/)(\.env(\.[^/]*)?|id_[a-z0-9]+|[^/]*\.(pem|key))$/.test(path) && !/\.env\.(example|sample)$/.test(path)
      if (secret) return { level: 'high', summary: null, reasons: ['Changes a file with secrets'] }
      if (path.startsWith('/') && folder && !inside(path, folder)) return { level: 'high', summary: null, reasons: ['Changes a file outside the project'] }
      return NONE
    }
    case 'Read':
      return folder && d.startsWith('/') && !inside(d, folder) ? { level: 'medium', summary: null, reasons: ['Reads a file outside the project'] } : NONE
    default:
      return NONE
  }
}
