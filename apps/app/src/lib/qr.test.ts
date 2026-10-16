import { describe, expect, test } from 'bun:test'
import { encode } from 'uqr'
import { qrRuns } from './qr'

describe('QR code', () => {
  test('the runs cover exactly the dark squares', () => {
    const link = 'afterhours://pair?r=wss%3A%2F%2Frelay.example.com&m=AbCdEf0123456789&s=ZYXWVUTSRQPONMLK&n=build-box'
    const { size, runs } = qrRuns(link)
    const qr = encode(link, { ecc: 'M', border: 2 })
    const drawn = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
    for (const [y, x, n] of runs) for (let i = 0; i < n; i++) drawn[y]![x + i] = true
    expect(size).toBe(qr.size)
    expect(drawn).toEqual(qr.data)
    // A run per stretch of dark squares: far fewer views than squares.
    expect(runs.length).toBeLessThan(qr.data.flat().filter(Boolean).length * 0.6)
  })
})
