// A QR code as runs of dark squares, for drawing with plain views.

import { encode } from 'uqr'

/** Each row's dark runs: [row, first column, length]. */
export function qrRuns(value: string): { size: number; runs: [number, number, number][] } {
  const qr = encode(value, { ecc: 'M', border: 2 })
  const runs: [number, number, number][] = []
  qr.data.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let end = x
      while (end + 1 < row.length && row[end + 1]) end++
      runs.push([y, x, end - x + 1])
      x = end
    }
  })
  return { size: qr.size, runs }
}
