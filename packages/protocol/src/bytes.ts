// Byte helpers that behave the same in Bun, browsers, Electron and React Native (Hermes).

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null
const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null

export function utf8(text: string): Uint8Array {
  if (encoder) return encoder.encode(text)
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

export function fromUtf8(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes)
  let text = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!
    const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0
    if (n === 0 || i + n > bytes.length) throw new Error('invalid UTF-8')
    let c = n === 1 ? b : b & (0xff >> (n + 1))
    for (let k = 1; k < n; k++) {
      const next = bytes[i + k]!
      if ((next & 0xc0) !== 0x80) throw new Error('invalid UTF-8')
      c = (c << 6) | (next & 63)
    }
    text += String.fromCodePoint(c)
    i += n
  }
  return text
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Compares without stopping at the first difference, so timing doesn't reveal where they differ. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

/** Base64url without padding: safe in URLs, QR codes and JSON. */
export function toBase64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!
    if (i + 2 < bytes.length) out += B64[n & 63]!
  }
  return out
}

export function fromBase64url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('invalid base64url')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let at = 0
  for (const c of text) {
    const v = B64_INDEX.get(c)
    if (v === undefined) throw new Error('invalid base64url')
    value = (value << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (value >> bits) & 0xff
    }
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw new Error('invalid hex')
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}
