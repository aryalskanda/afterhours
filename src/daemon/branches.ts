// A finished task's own branch: merged into your checkout, or thrown away. The same for apps (the
// router, which checks a device's rules first) and the Telegram bot.

import { oneLine } from './format'
import type { Job } from '../shared/types'
import type { Store } from './store'
import type { git as gitModule } from './system'

export type BranchGit = Pick<typeof gitModule, 'mergeBranch' | 'discardBranch' | 'pullRequest'>

export async function settleBranch(
  store: Store,
  git: BranchGit,
  id: number,
  action: 'merge' | 'discard' | 'pr',
): Promise<{ ok: true; text: string } | { ok: false; code: 'not-found' | 'invalid' | 'gone' | 'failed'; text: string }> {
  const job = store.getJob(id)
  if (!job) return { ok: false, code: 'not-found', text: `No task #${id}.` }
  if (!job.branch) return { ok: false, code: 'invalid', text: `#${job.id} didn't run on its own branch.` }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'held') return { ok: false, code: 'gone', text: `#${job.id} hasn't finished.` }
  // The tasks it builds on whose branches are still open: merging or proposing it takes their work too.
  const below = stackBelow(store, job)
  const range = below.length > 0 ? `#${below.at(-1)!.id}–#${job.id}` : `#${job.id}`
  if (action === 'merge') {
    const done = await git.mergeBranch(job.projectDir, job.branch, job.workDir, `Merge Afterhours ${range}: ${oneLine(job.prompt, 72)}`)
    if (!done.ok) return { ok: false, code: 'failed', text: done.text }
    store.updateJob(job.id, { branchNote: done.text })
    for (const b of below) {
      store.updateJob(b.id, { branchNote: `Merged with #${job.id}` })
      await git.discardBranch(b.projectDir, b.branch!, b.workDir, { merged: true })
    }
    return { ok: true, text: below.length > 0 ? `${done.text} It has the work of ${range}.` : done.text }
  }
  if (action === 'pr') {
    const title = oneLine(job.prompt, 72)
    const tasks = [...below].reverse().concat(job)
    const listed = tasks.length > 1 ? `This builds on earlier tasks, one commit each:\n${tasks.map(t => `- #${t.id}: ${oneLine(t.prompt, 100)}`).join('\n')}\n\n` : ''
    const body = `${job.prompt}\n\n${listed}${job.summary ? `${job.summary}\n\n` : ''}From Afterhours task${tasks.length > 1 ? 's' : ''} ${range}.`
    const pr = await git.pullRequest(job.workDir ?? job.projectDir, job.branch, title, body)
    if (!pr.ok) return { ok: false, code: 'failed', text: pr.text }
    store.updateJob(job.id, { branchNote: pr.url ?? pr.text })
    for (const b of below) store.updateJob(b.id, { branchNote: `In #${job.id}'s pull request` })
    return { ok: true, text: pr.text }
  }
  // Thrown away under a task that builds on it, that one's branch would lose its base.
  const above = store.stackedOnto(job.id).filter(a => a.branchNote === null && a.status !== 'cancelled')
  if (above.length > 0) {
    return { ok: false, code: 'invalid', text: `#${above[0]!.id} builds on #${job.id}: discard #${above[0]!.id} first, or merge it (that merges both).` }
  }
  const done = await git.discardBranch(job.projectDir, job.branch, job.workDir)
  if (!done.ok) return { ok: false, code: 'failed', text: done.text }
  store.updateJob(job.id, { branchNote: 'Discarded' })
  return { ok: true, text: `Threw away ${job.branch}.` }
}

/** The tasks `job` builds on, nearest first, while their branches are still open. */
export function stackBelow(store: Store, job: { stackedOn: number | null }): Job[] {
  const out: Job[] = []
  const seen = new Set<number>()
  let id = job.stackedOn
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const below = store.getJob(id)
    if (!below || !below.branch || below.branchNote !== null) break
    out.push(below)
    id = below.stackedOn
  }
  return out
}
