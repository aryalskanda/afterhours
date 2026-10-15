// Runs a request on a machine and keeps how it went, for the line under the buttons.

import { useState } from 'react'
import { hub } from '../app-state'
import type { RequestBody } from '../lib/hub'

export interface ActionOutcome {
  ok: boolean
  text: string
}

export function useAction() {
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null)
  const run = async (machine: string, body: RequestBody, o: { done?: string; timeoutMs?: number } = {}) => {
    setOutcome(null)
    const r = await hub.request(machine, body, { timeoutMs: o.timeoutMs })
    setOutcome({ ok: r.ok, text: r.ok ? (r.text ?? o.done ?? 'Done.') : (r.error ?? 'It didn’t go through.') })
    return r
  }
  return { outcome, run, clear: () => setOutcome(null) }
}
