// A finished task's own branch: merged into your checkout, or thrown away. The same for apps (the
// router, which checks a device's rules first) and the Telegram bot.

import { oneLine } from './format'
import type { Store } from './store'
import type { git as gitModule } from './system'

export type BranchGit = Pick<typeof gitModule, 'mergeBranch' | 'discardBranch'>

export async function settleBranch(
  store: Store,
  git: BranchGit,
  id: number,
  action: 'merge' | 'discard',
): Promise<{ ok: true; text: string } | { ok: false; code: 'not-found' | 'invalid' | 'gone' | 'failed'; text: string }> {
  const job = store.getJob(id)
  if (!job) return { ok: false, code: 'not-found', text: `No task #${id}.` }
  if (!job.branch) return { ok: false, code: 'invalid', text: `#${job.id} didn't run on its own branch.` }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'held') return { ok: false, code: 'gone', text: `#${job.id} hasn't finished.` }
  if (action === 'merge') {
    const done = await git.mergeBranch(job.projectDir, job.branch, job.workDir, `Merge Afterhours #${job.id}: ${oneLine(job.prompt, 72)}`)
    if (!done.ok) return { ok: false, code: 'failed', text: done.text }
    store.updateJob(job.id, { branchNote: done.text })
    return { ok: true, text: done.text }
  }
  const done = await git.discardBranch(job.projectDir, job.branch, job.workDir)
  if (!done.ok) return { ok: false, code: 'failed', text: done.text }
  store.updateJob(job.id, { branchNote: 'Discarded' })
  return { ok: true, text: `Threw away ${job.branch}.` }
}
