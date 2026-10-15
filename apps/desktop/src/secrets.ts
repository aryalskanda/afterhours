// The device's key, and anything else secret, in a file of its own: each value encrypted by the
// operating system (Electron's safeStorage: the Keychain, DPAPI, or the Linux keyring). Without a
// keyring, values are stored as they are, and `protected` says so.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Cipher {
  /** Values are encrypted with a key the OS keeps (not one anyone could read in Electron's code). */
  protected: boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface SecretFile {
  v: 1
  items: Record<string, { protected: boolean; data: string }>
}

export class SecretStore {
  private items: SecretFile['items'] = {}

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly log: (line: string) => void = () => {},
  ) {
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SecretFile
      if (parsed.v === 1 && parsed.items && typeof parsed.items === 'object') this.items = parsed.items
    } catch {
      this.log(`secrets: ${file} is unreadable; starting empty`)
    }
  }

  get protected(): boolean {
    return this.cipher.protected
  }

  get(key: string): string | null {
    const item = this.items[key]
    if (!item) return null
    const data = Buffer.from(item.data, 'base64')
    if (!item.protected) return data.toString('utf8')
    try {
      return this.cipher.decrypt(data)
    } catch {
      // The OS no longer has the key it was encrypted with (a new keychain, a restored backup).
      this.log(`secrets: can't decrypt ${key}; it will be made again`)
      return null
    }
  }

  set(key: string, value: string): void {
    const encrypted = this.cipher.protected
    const data = encrypted ? this.cipher.encrypt(value) : Buffer.from(value, 'utf8')
    this.items = { ...this.items, [key]: { protected: encrypted, data: data.toString('base64') } }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, items: this.items } satisfies SecretFile), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
