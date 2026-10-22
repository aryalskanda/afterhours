// A task's processes: its window's process and everything below it, all ended by a kill.

import { expect, test } from 'bun:test'
import { descendants, endProcesses, parsePs, systemProcs } from '../src/daemon/procs'

test('the tree below a process, parents first, from ps', () => {
  const parents = parsePs('  1     0\n 500     1\n 501   500\n 502   501\n 503   500\n 900     1\n garbage\n')
  expect(descendants(parents, 500)).toEqual([500, 501, 503, 502])
  expect(descendants(parents, 900)).toEqual([900])
  // A process that's its own parent (as ps shows some) doesn't loop.
  expect(descendants(new Map([[0, 0], [5, 0]]), 0)).toEqual([0, 5])
})

test('a real process tree ends: what ignores SIGTERM gets SIGKILL', async () => {
  // A shell with two children, one of which ignores SIGTERM.
  const shell = Bun.spawn(['sh', '-c', "sleep 30 & (trap '' TERM; sleep 30) & wait"], { stdout: 'ignore', stderr: 'ignore' })
  try {
    let tree: number[] = []
    for (let i = 0; i < 50 && tree.length < 3; i++) {
      await Bun.sleep(20)
      tree = await systemProcs.tree(shell.pid)
    }
    expect(tree[0]).toBe(shell.pid)
    expect(tree.length).toBeGreaterThanOrEqual(3)
    const forced = await endProcesses(tree, { procs: systemProcs, graceMs: 500 })
    expect(forced.length).toBeGreaterThanOrEqual(1)
    await shell.exited
    await Bun.sleep(50)
    expect(tree.filter(pid => pid !== shell.pid && systemProcs.alive(pid))).toEqual([])
  } finally {
    for (const pid of await systemProcs.tree(shell.pid).catch(() => [])) systemProcs.signal(pid, 'SIGKILL')
    shell.kill('SIGKILL')
  }
})
