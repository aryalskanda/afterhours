// The pull requests tasks opened, for the daily digest: found in what each task said at the end
// (a task that opens one reports its link), checked with GitHub's gh, and merged from a phone.

import type { DigestPr } from '@afterhours/protocol'
import { cleanEnv } from '../shared/config'

const PR_LINK = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

/** Pull request links in texts, each once, first seen first. */
export function prLinks(texts: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(PR_LINK)) seen.add(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`)
  }
  return [...seen]
}

/** `gh pr view --json number,title,state,isDraft,url`, read: null unless it's open. */
export function openPr(json: string): DigestPr | null {
  try {
    const d = JSON.parse(json) as { number?: unknown; title?: unknown; state?: unknown; isDraft?: unknown; url?: unknown }
    if (d.state !== 'OPEN' || typeof d.url !== 'string' || typeof d.number !== 'number') return null
    const repo = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\//.exec(d.url)?.[1] ?? ''
    return { url: d.url, repo, number: d.number, title: typeof d.title === 'string' ? d.title : '', draft: d.isDraft === true }
  } catch {
    return null
  }
}

export type Gh = (args: string[]) => Promise<{ code: number; out: string; err: string }>

/** Runs gh, or says it isn't there. */
export function systemGh(timeoutMs = 20_000): Gh | null {
  const path = Bun.which('gh')
  if (!path) return null
  return async args => {
    try {
      const proc = Bun.spawn([path, ...args], { env: cleanEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { code, out, err }
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      return { code: 1, out: '', err: e instanceof Error ? e.message : String(e) }
    }
  }
}

/** At most this many links are looked up for one digest. */
const MAX_LOOKUPS = 10

/** Which of these pull requests are still open, newest link first. */
export async function openPrs(urls: string[], gh: Gh | null): Promise<{ prs: DigestPr[]; note: string | null }> {
  if (urls.length === 0) return { prs: [], note: null }
  if (!gh) return { prs: [], note: 'GitHub’s gh isn’t installed here, so open pull requests aren’t listed.' }
  const looked = await Promise.all(urls.slice(0, MAX_LOOKUPS).map(url => gh(['pr', 'view', url, '--json', 'number,title,state,isDraft,url'])))
  const prs = looked.flatMap(r => {
    const pr = r.code === 0 ? openPr(r.out) : null
    return pr ? [pr] : []
  })
  const failed = looked.filter(r => r.code !== 0).length
  return { prs, note: failed === looked.length ? 'gh couldn’t look the pull requests up (signed in? online?).' : null }
}

/** Merges an open pull request (a merge commit, as these repos do). */
export async function mergePr(url: string, gh: Gh | null): Promise<{ ok: boolean; text: string }> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) return { ok: false, text: 'That isn’t a pull request link.' }
  if (!gh) return { ok: false, text: 'GitHub’s gh isn’t installed on this machine.' }
  const name = url.replace(/^https:\/\/github\.com\/[\w.-]+\//, '').replace('/pull/', ' #')
  const r = await gh(['pr', 'merge', url, '--merge'])
  if (r.code === 0) return { ok: true, text: `Merged ${name}.` }
  const why = r.err.trim().split('\n').find(l => l.trim()) ?? 'unknown error'
  return { ok: false, text: `Couldn’t merge ${name}: ${why}` }
}
