// Live links: claude.ai artifacts Claude publishes to show a task's result, found in what it said or
// in its tool results, and what it's asked to make one.

import { readTranscript } from './transcript'

export interface LiveLink {
  url: string
  title: string | null
}

/** At the end of a task that wants a live link (the Stop hook's reason: Claude keeps going). */
export const LINK_REQUEST =
  'Before you finish: publish a Claude artifact (with your Artifact tool) that shows the result of this task, ' +
  'so it can be seen from a phone. If you changed something visual, show it as it looks: screenshots of it running ' +
  "if you can take them, else a faithful HTML preview, and say how to try it. Otherwise, a short visual summary of what changed. " +
  'Keep it private and leave out secrets. Stop anything you started to take the screenshots (a server, a browser) before you finish. ' +
  'End your reply with the artifact’s link on its own line.'

/** A task of its own, for a task that already ended (Get a live link): the same, about what was done. */
export const LINK_TASK =
  'Publish a Claude artifact (with your Artifact tool) that shows the result of what you just did, so it can be seen ' +
  'from a phone. If it changed something visual, show it as it looks: screenshots of it running if you can take them, ' +
  'else a faithful HTML preview, and say how to try it. Otherwise, a short visual summary of what changed. ' +
  'Keep it private and leave out secrets. Change nothing else, and stop anything you started to take the screenshots ' +
  '(a server, a browser) before you finish. End your reply with the artifact’s link on its own line.'

const LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g

/** Artifact links in text, first seen first, with a markdown label as the title when there is one. */
export function artifactLinks(text: string): LiveLink[] {
  const out: LiveLink[] = []
  for (const m of text.matchAll(LINK)) {
    const url = m[0]
    if (out.some(l => l.url === url)) continue
    const before = text.slice(0, m.index)
    const label = /\[([^\]\n]{1,120})\]\($/.exec(before)?.[1] ?? null
    out.push({ url, title: label })
  }
  return out
}

/** Artifact links in a conversation's transcript since `since` (what Claude said, and its tools' results). */
export function linksInTranscript(path: string, since: number): LiveLink[] {
  try {
    const items = readTranscript(path).items.filter(i => (i.at ?? 0) >= since)
    return artifactLinks(items.map(i => ('result' in i ? `${i.detail}\n${i.result ?? ''}` : i.text)).join('\n'))
  } catch {
    return []
  }
}
