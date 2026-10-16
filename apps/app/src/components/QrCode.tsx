// A QR code drawn with plain views (a run of dark squares is one view), dark on white in both
// themes so any camera reads it.

import { useMemo } from 'react'
import { View } from 'react-native'
import { qrRuns } from '../lib/qr'

export function QrCode(props: { value: string; size: number; label: string; testID?: string }) {
  const { size, runs } = useMemo(() => qrRuns(props.value), [props.value])
  // Whole pixels per square, so rows meet without hairlines.
  const cell = Math.max(1, Math.floor(props.size / size))
  const side = cell * size
  return (
    <View role="img" aria-label={props.label} testID={props.testID} style={{ width: side, height: side, backgroundColor: '#ffffff', borderRadius: 8, overflow: 'hidden', alignSelf: 'center' }}>
      {runs.map(([y, x, n]) => (
        <View key={`${y}:${x}`} style={{ position: 'absolute', top: y * cell, left: x * cell, width: n * cell, height: cell, backgroundColor: '#000000' }} />
      ))}
    </View>
  )
}
