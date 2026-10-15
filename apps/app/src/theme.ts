// Colours, spacing and type, light and dark: the palette of the Afterhours site (amber on warm paper,
// amber on night blue).

import { Platform, useColorScheme } from 'react-native'

const light = {
  bg: '#faf8f4',
  card: '#ffffff',
  raised: '#f2efe8',
  ink: '#16181d',
  soft: '#5b606b',
  faint: '#8a8f99',
  line: '#e5e0d6',
  accent: '#b45309',
  accentInk: '#ffffff',
  accentSoft: '#fdf1e1',
  ok: '#1a7f37',
  okSoft: '#e6f4ea',
  danger: '#b42318',
  dangerSoft: '#fdecea',
  code: '#f2efe8',
  terminal: '#0e1320',
  terminalInk: '#e7eaf0',
}

export type Colors = typeof light

const dark: Colors = {
  bg: '#0e1320',
  card: '#161e31',
  raised: '#1c2539',
  ink: '#eef0f4',
  soft: '#a9b0bf',
  faint: '#7c8496',
  line: '#26304a',
  accent: '#f5a524',
  accentInk: '#1a1204',
  accentSoft: '#2a2213',
  ok: '#4ade80',
  okSoft: '#12301f',
  danger: '#f97066',
  dangerSoft: '#3a1a18',
  code: '#1c2539',
  terminal: '#05080f',
  terminalInk: '#e7eaf0',
}

export const palette = { light, dark }

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 }
export const radius = { s: 8, m: 12, l: 16, pill: 999 }

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' })

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  tiny: { fontSize: 11, lineHeight: 14, letterSpacing: 0.3 },
}

/** Content stays readable on a wide window (the web, a tablet, the desktop app). */
export const MAX_WIDTH = 760
