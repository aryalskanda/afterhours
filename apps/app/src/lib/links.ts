// Links that open the app.

const FIELDS = ['r', 'm', 's', 'n', 'x'] as const

/**
 * The pairing link from this screen's address: the link's own fields (afterhours://pair?r=…&m=…),
 * or `?link=<the link>`, whose fields a router may have split off into the address's own.
 */
export function pairingLinkFrom(params: Record<string, string | string[] | undefined>): string | null {
  const one = (k: string) => {
    const v = params[k]
    return typeof v === 'string' && v ? v : undefined
  }
  const fields = new Map<string, string>()
  const link = one('link')
  if (link) {
    const q = link.indexOf('?')
    for (const part of q >= 0 ? link.slice(q + 1).split('&') : []) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      try {
        fields.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)))
      } catch {
        // Damaged: the link's own check says so.
      }
    }
  }
  for (const k of FIELDS) {
    const v = one(k)
    if (v && !fields.has(k)) fields.set(k, v)
  }
  if (fields.size === 0) return link ?? null
  return `afterhours://pair?${FIELDS.flatMap(k => (fields.has(k) ? [`${k}=${encodeURIComponent(fields.get(k)!)}`] : [])).join('&')}`
}
