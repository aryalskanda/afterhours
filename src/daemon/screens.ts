import type { ExecMode } from '../shared/types'

// Recognizers for the few Claude Code screens cq answers with keystrokes. They work on
// `tmux capture-pane` text, so they key on stable wording rather than layout.

export interface MenuOption {
  n: number
  label: string
  focused: boolean
}

const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/

function optionsAfter(screen: string, marker: RegExp): MenuOption[] {
  const lines = screen.split('\n')
  const start = lines.findIndex(l => marker.test(l))
  if (start < 0) return []
  const options: MenuOption[] = []
  for (const line of lines.slice(start + 1)) {
    const m = OPTION_RE.exec(line)
    if (m) options.push({ n: Number(m[2]), label: m[3]!, focused: Boolean(m[1]) })
  }
  return options
}

/** "Quick safety check: Is this a project you created or one you trust?" — focus starts on "No, exit". */
export function trustDialog(screen: string): { present: boolean; yesFocused: boolean } {
  const present = /Yes, I trust this folder/.test(screen) && /No, exit|Quick safety check/.test(screen)
  return { present, yesFocused: /❯\s*Yes, I trust this folder/.test(screen) }
}

const PLAN_MARKER = /Would you like to proceed\?/

/** The plan approval dialog shown after Claude calls ExitPlanMode. */
export function planDialog(screen: string): { present: boolean; options: MenuOption[] } {
  if (!PLAN_MARKER.test(screen) || !/plan/i.test(screen)) return { present: false, options: [] }
  return { present: true, options: optionsAfter(screen, PLAN_MARKER) }
}

export interface PlanChoice {
  option: MenuOption
  /** The dialog didn't offer the job's mode: approve with manual edits and switch on the next permission prompt. */
  switchAfter?: ExecMode
}

export function choosePlanOption(options: MenuOption[], execMode: ExecMode): PlanChoice | null {
  const find = (re: RegExp) => options.find(o => re.test(o.label))
  const wanted: Record<ExecMode, RegExp> = {
    auto: /auto mode/i,
    acceptEdits: /auto-accept|accept edits/i,
    bypassPermissions: /bypass/i,
  }
  const exact = find(wanted[execMode])
  if (exact) return { option: exact }
  const fallback = find(/manually approve/i) ?? options.find(o => /^yes\b/i.test(o.label))
  return fallback ? { option: fallback, switchAfter: execMode } : null
}

export function feedbackOption(options: MenuOption[]): MenuOption | undefined {
  return options.find(o => /tell claude what to change|keep planning/i.test(o.label))
}

/** Claude Code's own auto-continue is armed and counting down to the reset. */
export function autoContinueArmed(screen: string): boolean {
  return /continuing automatically/i.test(screen)
}
