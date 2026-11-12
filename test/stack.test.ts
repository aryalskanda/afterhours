import { expect, test } from 'bun:test'
import { settleBranch, stackBelow, type BranchGit } from '../src/daemon/branches'
import { Store } from '../src/daemon/store'
import type { JobSpec } from '../src/shared/types'

const spec: JobSpec = { projectDir: '/p', prompt: 'x', plan: false, review: false, execMode: 'auto', model: 'haiku', effort: 'low', sessionPolicy: 'new', source: 'test' }

/** Three finished tasks, each on top of the one before. */
function three() {
  const store = new Store(':memory:')
  const ids: number[] = []
  for (const prompt of ['Make it blue', 'Make it bold', 'Add a footer']) {
    const j = store.addJob({ ...spec, prompt }, 1)
    store.updateJob(j.id, { status: 'done', finishedAt: 2, branch: `afterhours/${j.id}`, workDir: `/p/.claude/worktrees/afterhours-${j.id}`, stackedOn: ids.at(-1) ?? null })
    ids.push(j.id)
  }
  const calls: string[] = []
  const git: BranchGit = {
    mergeBranch: async (_dir, branch) => (calls.push(`merge ${branch}`), { ok: true, text: `Merged ${branch} into main.` }),
    discardBranch: async (_dir, branch) => (calls.push(`discard ${branch}`), { ok: true, text: '' }),
    pullRequest: async (_dir, branch, _title, body) => (calls.push(`pr ${branch}\n${body}`), { ok: true, text: 'Opened', url: 'https://github.com/x/y/pull/1' }),
  }
  return { store, ids, git, calls }
}

test('what a task builds on: nearest first, while the branches are open', () => {
  const t = three()
  expect(stackBelow(t.store, t.store.getJob(t.ids[2]!)!).map(j => j.id)).toEqual([t.ids[1]!, t.ids[0]!])
  t.store.updateJob(t.ids[0]!, { branchNote: 'Merged into main.' })
  expect(stackBelow(t.store, t.store.getJob(t.ids[2]!)!).map(j => j.id)).toEqual([t.ids[1]!])
})

test('merging the newest merges them all, and notes the earlier ones', async () => {
  const t = three()
  const [a, b, c] = t.ids as [number, number, number]
  const r = await settleBranch(t.store, t.git, c, 'merge')
  expect(r).toEqual({ ok: true, text: `Merged afterhours/${c} into main. It has the work of #${a}–#${c}.` })
  expect(t.calls).toEqual([`merge afterhours/${c}`, `discard afterhours/${b}`, `discard afterhours/${a}`])
  expect([a, b].map(id => t.store.getJob(id)!.branchNote)).toEqual([`Merged with #${c}`, `Merged with #${c}`])
})

test('a pull request for the newest lists every task in it', async () => {
  const t = three()
  const [a, b, c] = t.ids as [number, number, number]
  await settleBranch(t.store, t.git, c, 'pr')
  expect(t.calls[0]).toContain(`- #${a}: Make it blue\n- #${b}: Make it bold\n- #${c}: Add a footer`)
  expect(t.store.getJob(a)!.branchNote).toBe(`In #${c}'s pull request`)
})

test('throwing away a task others build on is refused; the newest can go', async () => {
  const t = three()
  const [, b, c] = t.ids as [number, number, number]
  expect(await settleBranch(t.store, t.git, b, 'discard')).toMatchObject({ ok: false, code: 'invalid', text: `#${c} builds on #${b}: discard #${c} first, or merge it (that merges both).` })
  expect(await settleBranch(t.store, t.git, c, 'discard')).toMatchObject({ ok: true })
  expect(await settleBranch(t.store, t.git, b, 'discard')).toMatchObject({ ok: true })
})
