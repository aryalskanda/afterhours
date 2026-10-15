// What React Native's JavaScript engine (Hermes) lacks for the protocol: random bytes for keys
// and nonces, and a zod that doesn't generate code at run time.

import { getRandomValues } from 'expo-crypto'
import { z } from 'zod'

const g = globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(array: T) => T } }
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...g.crypto, getRandomValues: <T extends Uint8Array>(array: T) => getRandomValues(array) }
}

z.config({ jitless: true })
