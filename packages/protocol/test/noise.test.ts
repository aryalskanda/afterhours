import { describe, expect, test } from 'bun:test'
import { x25519 } from '@noble/curves/ed25519.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromHex, toHex } from '../src/bytes'
import { Handshake, type PatternName } from '../src/noise'

interface Vector {
  protocol_name: string
  init_prologue: string
  init_psks?: string[]
  init_static?: string
  init_ephemeral: string
  init_remote_static?: string
  resp_prologue: string
  resp_psks?: string[]
  resp_static?: string
  resp_ephemeral?: string
  resp_remote_static?: string
  handshake_hash?: string
  messages: { payload: string; ciphertext: string }[]
}

const vectors = (JSON.parse(readFileSync(join(import.meta.dir, 'noise-vectors.json'), 'utf8')) as { vectors: Vector[] }).vectors
const pair = (hex?: string) => {
  if (!hex) return undefined
  const secretKey = fromHex(hex)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

describe('Noise against the cacophony test vectors', () => {
  test('the fixture has the patterns Afterhours uses', () => {
    const names = vectors.map(v => v.protocol_name)
    expect(names).toContain('Noise_IK_25519_ChaChaPoly_SHA256')
    expect(names).toContain('Noise_IKpsk2_25519_ChaChaPoly_SHA256')
  })

  for (const v of vectors) {
    test(v.protocol_name, () => {
      const pattern = /^Noise_([A-Za-z0-9]+)_/.exec(v.protocol_name)![1] as PatternName
      const init = new Handshake({
        pattern,
        initiator: true,
        prologue: fromHex(v.init_prologue),
        s: pair(v.init_static),
        e: pair(v.init_ephemeral),
        rs: v.init_remote_static ? fromHex(v.init_remote_static) : undefined,
        psk: v.init_psks?.[0] ? fromHex(v.init_psks[0]) : undefined,
      })
      const resp = new Handshake({
        pattern,
        initiator: false,
        prologue: fromHex(v.resp_prologue),
        s: pair(v.resp_static),
        e: pair(v.resp_ephemeral),
        rs: v.resp_remote_static ? fromHex(v.resp_remote_static) : undefined,
        psk: v.resp_psks?.[0] ? fromHex(v.resp_psks[0]) : undefined,
      })
      let initTransport: ReturnType<Handshake['transport']> | null = null
      let respTransport: ReturnType<Handshake['transport']> | null = null
      v.messages.forEach((m, i) => {
        const fromInitiator = i % 2 === 0
        const payload = fromHex(m.payload)
        let ciphertext: Uint8Array
        let received: Uint8Array
        if (!init.finished) {
          const [writer, reader] = fromInitiator ? [init, resp] : [resp, init]
          ciphertext = writer.writeMessage(payload)
          received = reader.readMessage(ciphertext)
          if (init.finished && resp.finished) {
            if (v.handshake_hash) {
              expect(toHex(init.handshakeHash)).toBe(v.handshake_hash)
              expect(toHex(resp.handshakeHash)).toBe(v.handshake_hash)
            }
            initTransport = init.transport()
            respTransport = resp.transport()
          }
        } else {
          const [writer, reader] = fromInitiator ? [initTransport!, respTransport!] : [respTransport!, initTransport!]
          ciphertext = writer.encrypt(payload)
          received = reader.decrypt(ciphertext)
        }
        expect(toHex(ciphertext)).toBe(m.ciphertext)
        expect(toHex(received)).toBe(m.payload)
      })
    })
  }
})

describe('Noise failures', () => {
  const keys = () => {
    const s = x25519.utils.randomSecretKey()
    return { secretKey: s, publicKey: x25519.getPublicKey(s) }
  }

  test('a changed byte fails authentication', () => {
    const responder = keys()
    const init = new Handshake({ pattern: 'IK', initiator: true, s: keys(), rs: responder.publicKey })
    const resp = new Handshake({ pattern: 'IK', initiator: false, s: responder })
    const m1 = init.writeMessage(new Uint8Array([1, 2, 3]))
    m1[m1.length - 1]! ^= 1
    expect(() => resp.readMessage(m1)).toThrow()
  })

  test('a wrong pre-shared key fails', () => {
    const responder = keys()
    const psk = new Uint8Array(32).fill(7)
    const init = new Handshake({ pattern: 'IKpsk2', initiator: true, s: keys(), rs: responder.publicKey, psk: new Uint8Array(32).fill(8) })
    const resp = new Handshake({ pattern: 'IKpsk2', initiator: false, s: responder, psk })
    // The first message doesn't involve the psk; the reply does.
    resp.readMessage(init.writeMessage())
    expect(() => init.readMessage(resp.writeMessage())).toThrow()
  })

  test('the wrong responder key fails', () => {
    const init = new Handshake({ pattern: 'IK', initiator: true, s: keys(), rs: keys().publicKey })
    const resp = new Handshake({ pattern: 'IK', initiator: false, s: keys() })
    expect(() => resp.readMessage(init.writeMessage())).toThrow()
  })

  test('a replayed or reordered transport message fails', () => {
    const responder = keys()
    const init = new Handshake({ pattern: 'IK', initiator: true, s: keys(), rs: responder.publicKey })
    const resp = new Handshake({ pattern: 'IK', initiator: false, s: responder })
    resp.readMessage(init.writeMessage())
    init.readMessage(resp.writeMessage())
    const a = init.transport()
    const b = resp.transport()
    const first = a.encrypt(new Uint8Array([1]))
    const second = a.encrypt(new Uint8Array([2]))
    expect(() => b.decrypt(second)).toThrow()
    expect(b.decrypt(first)).toEqual(new Uint8Array([1]))
    expect(() => b.decrypt(first)).toThrow()
  })
})
