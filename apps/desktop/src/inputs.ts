// What the window sends the app is checked before use: the page is trusted, but a bug (or worse)
// in it shouldn't reach further than it needs to. Each check throws on anything unexpected.

export interface Notice {
  title: string
  body: string
  /** Where clicking it goes, inside the app: "/inbox", "/machine/…". */
  route: string
}

const SECRET_KEY = /^afterhours\.[a-zA-Z0-9._-]{1,64}$/

export function checkSecretKey(key: unknown): string {
  if (typeof key !== 'string' || !SECRET_KEY.test(key)) throw new Error('bad secret name')
  return key
}

export function checkSecretValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 * 1024) throw new Error('bad secret')
  return value
}

export function checkRoute(route: unknown): string {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.length > 300 || /[\s\\]/.test(route)) {
    throw new Error('bad route')
  }
  return route
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)

export function checkNotice(n: unknown): Notice {
  if (typeof n !== 'object' || n === null) throw new Error('bad notification')
  const { title, body, route } = n as Record<string, unknown>
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('bad notification')
  return { title: oneLine(title, 120) || 'Afterhours', body: oneLine(body, 300), route: checkRoute(route) }
}

export function checkCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error('bad count')
  return Math.min(count, 999)
}
