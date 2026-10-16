// A backup of this device: its key, the machines it's paired with, and its settings, sealed with
// a passphrase (scrypt, then XChaCha20-Poly1305), to move to a new phone. Whoever has the file and
// the passphrase can act as this device, so the passphrase must be long.

import { fromBase64url, randomBytes, toBase64url, utf8 } from '@afterhours/protocol'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import type { Prefs } from './hub'
import type { SavedMachine } from './state'

export interface BackupContents {
  /** This device's key, as the hub keeps it. */
  identity: string
  deviceName: string
  machines: SavedMachine[]
  prefs: Prefs
  saved: string[]
}

interface Sealed {
  afterhours: 'backup'
  v: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  nonce: string
  data: string
}

/** The shortest passphrase accepted. */
export const MIN_PASSPHRASE = 12

/** scrypt's cost: 16 MB and about a second on a phone. Tests make it cheaper. */
const COST = { N: 2 ** 14, r: 8, p: 1 }

async function keyFor(passphrase: string, salt: Uint8Array, kdf: { N: number; r: number; p: number }): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase.normalize('NFKC')), salt, { ...kdf, dkLen: 32, maxmem: 2 ** 26 })
}

export async function sealBackup(contents: BackupContents, passphrase: string, o: { cost?: { N: number; r: number; p: number } } = {}): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`)
  const kdf = o.cost ?? COST
  const salt = randomBytes(16)
  const nonce = randomBytes(24)
  const key = await keyFor(passphrase, salt, kdf)
  const data = xchacha20poly1305(key, nonce).encrypt(utf8(JSON.stringify({ v: 1, ...contents })))
  const sealed: Sealed = { afterhours: 'backup', v: 1, kdf: { name: 'scrypt', ...kdf, salt: toBase64url(salt) }, nonce: toBase64url(nonce), data: toBase64url(data) }
  return JSON.stringify(sealed)
}

/** The contents, or an error that says what's wrong (not a backup, the wrong passphrase). */
export async function openBackup(text: string, passphrase: string): Promise<BackupContents> {
  let sealed: Sealed
  try {
    sealed = JSON.parse(text.trim()) as Sealed
  } catch {
    throw new Error('That isn’t an Afterhours backup.')
  }
  if (sealed?.afterhours !== 'backup' || sealed.v !== 1 || sealed.kdf?.name !== 'scrypt') throw new Error('That isn’t an Afterhours backup, or it’s from a newer version.')
  const { N, r, p } = sealed.kdf
  // A file can't ask for more work than a phone can do.
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 17 || r > 16 || p > 4) throw new Error('That backup asks for more than this device can do.')
  const key = await keyFor(passphrase, fromBase64url(sealed.kdf.salt), { N, r, p })
  let plain: Uint8Array
  try {
    plain = xchacha20poly1305(key, fromBase64url(sealed.nonce)).decrypt(fromBase64url(sealed.data))
  } catch {
    throw new Error('Wrong passphrase, or the backup was changed.')
  }
  const contents = JSON.parse(new TextDecoder().decode(plain)) as BackupContents & { v: number }
  if (typeof contents.identity !== 'string' || !Array.isArray(contents.machines)) throw new Error('That backup is incomplete.')
  return { identity: contents.identity, deviceName: contents.deviceName, machines: contents.machines, prefs: contents.prefs, saved: contents.saved ?? [] }
}
