// The processes a task started: its window's process and everything below it (Claude, the
// commands it ran, a dev server it left running), so killing a task ends all of it.

export type Signal = 'SIGTERM' | 'SIGKILL'

export interface Procs {
  /** `root` and every process below it, parents first. */
  tree(root: number): Promise<number[]>
  /** False when the process is already gone (or isn't ours). */
  signal(pid: number, signal: Signal): boolean
  alive(pid: number): boolean
}

/** `ps -A -o pid=,ppid=` → each process's parent. */
export function parsePs(out: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) parents.set(Number(m[1]), Number(m[2]))
  }
  return parents
}

/** `root` and its descendants, parents first. */
export function descendants(parents: Map<number, number>, root: number): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) {
    if (pid === ppid) continue
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  const out: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return out
}

export const systemProcs: Procs = {
  async tree(root) {
    // Windows has no ps: the system's own process list (Toolhelp32).
    if (process.platform === 'win32') return descendants((await import('../platform/win32')).processParents(), root)
    const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => ps.kill(), 5000)
    const out = await new Response(ps.stdout).text()
    clearTimeout(timer)
    await ps.exited
    return descendants(parsePs(out), root)
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
}

/**
 * Ends processes: SIGTERM to each, then SIGKILL to whatever is still there after `graceMs`.
 * Returns the ones that needed SIGKILL.
 */
export async function endProcesses(pids: number[], o: { procs: Procs; graceMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<number[]> {
  if (pids.length === 0) return []
  const sleep = o.sleep ?? Bun.sleep
  const asked = pids.filter(pid => o.procs.signal(pid, 'SIGTERM'))
  const grace = o.graceMs ?? 2000
  for (let waited = 0; waited < grace && asked.some(pid => o.procs.alive(pid)); waited += 100) await sleep(100)
  const stubborn = asked.filter(pid => o.procs.alive(pid))
  for (const pid of stubborn) o.procs.signal(pid, 'SIGKILL')
  return stubborn
}
