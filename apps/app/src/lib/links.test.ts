import { describe, expect, test } from 'bun:test'
import { newIdentity, pairingLink, parsePairingLink, peerId } from '@afterhours/protocol'
import { pairingLinkFrom } from './links'

const link = pairingLink({
  relay: 'wss://relay.example.com/v1',
  machine: peerId(newIdentity().publicKey),
  name: 'Studio & lab',
  secret: new Uint8Array(16).fill(7),
  expires: 1_900_000_000_000,
})
const fields = Object.fromEntries(new URLSearchParams(link.slice(link.indexOf('?') + 1)))

describe('pairing links that open the app', () => {
  test('the fields of afterhours://pair?…, as the router hands them over', () => {
    expect(parsePairingLink(pairingLinkFrom(fields)!)).toEqual(parsePairingLink(link))
  })

  test('?link=… whole', () => {
    expect(pairingLinkFrom({ link })).toBe(link)
  })

  test('?link=… whose fields the router split off into the address', () => {
    const [first, ...rest] = link.split('&')
    const split = { link: first!, ...Object.fromEntries(new URLSearchParams(rest.join('&'))) }
    expect(parsePairingLink(pairingLinkFrom(split)!)).toEqual(parsePairingLink(link))
  })

  test('nothing to pair with', () => {
    expect(pairingLinkFrom({})).toBeNull()
    expect(pairingLinkFrom({ other: 'x' })).toBeNull()
  })
})
