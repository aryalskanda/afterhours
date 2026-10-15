// Colours, type and sizes. Light: grouped lists on a grey page, as in the iPhone's own apps. Dark:
// the brand's night navy. One accent, amber, for what needs you and a screen's main action.
// On a wide window (the desktop app, a browser) the type and rows are as dense as desktop apps'.

import { Platform, useColorScheme, useWindowDimensions, type TextStyle } from 'react-native'

const light = {
  page: '#f2f2f7',
  group: '#ffffff',
  /** Segmented-control tracks, code, fields' fill; the selected segment. */
  fill: '#e9e9ee',
  thumb: '#ffffff',
  pressed: '#e5e5ea',
  hover: '#f7f7fa',
  /** The sidebar's selected item. */
  selected: 'rgba(0, 0, 0, 0.07)',
  ink: '#111214',
  soft: '#6c6c72',
  faint: '#a3a3a8',
  line: '#d8d8dc',
  accent: '#b45309',
  accentInk: '#ffffff',
  accentSoft: 'rgba(180, 83, 9, 0.11)',
  ok: '#248a3d',
  okDot: '#34c759',
  danger: '#d70015',
  dangerSoft: 'rgba(215, 0, 21, 0.08)',
  terminal: '#0e1320',
  terminalInk: '#e4e7ee',
  shadow: '#000000',
}

export type Colors = typeof light

const dark: Colors = {
  page: '#0e1320',
  group: '#161e31',
  fill: '#222b42',
  thumb: '#3b4562',
  pressed: '#232d47',
  hover: '#1a2339',
  selected: 'rgba(255, 255, 255, 0.08)',
  ink: '#f2f2f7',
  soft: '#a2a9b9',
  faint: '#69728a',
  line: '#29334d',
  accent: '#f5a524',
  accentInk: '#1a1204',
  accentSoft: 'rgba(245, 165, 36, 0.14)',
  ok: '#4cd964',
  okDot: '#30d158',
  danger: '#ff6961',
  dangerSoft: 'rgba(255, 105, 97, 0.12)',
  terminal: '#05080f',
  terminalInk: '#e4e7ee',
  shadow: '#000000',
}

export const palette = { light, dark }

type Style = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'>

export type TypeScale = Record<'largeTitle' | 'title' | 'headline' | 'body' | 'subhead' | 'footnote' | 'caption', Style>

const phone: TypeScale = {
  largeTitle: { fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400', letterSpacing: -0.2 },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.1 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: 0 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0 },
}

const desktop: TypeScale = {
  largeTitle: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.4 },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  headline: { fontSize: 14, lineHeight: 19, fontWeight: '600', letterSpacing: -0.1 },
  body: { fontSize: 14, lineHeight: 19, fontWeight: '400', letterSpacing: -0.1 },
  subhead: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: 0 },
  footnote: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0 },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '400', letterSpacing: 0 },
}

export interface Metrics {
  /** Rows' least height, and their padding. */
  row: number
  rowX: number
  rowY: number
  /** Groups' corners, and the page's side margin. */
  radius: number
  pageX: number
  /** Space between groups. */
  gap: number
  /** Buttons' heights. */
  button: number
  buttonSmall: number
  /** A readable column on a wide window. */
  maxWidth: number
}

const phoneMetrics: Metrics = { row: 44, rowX: 16, rowY: 11, radius: 10, pageX: 16, gap: 28, button: 50, buttonSmall: 34, maxWidth: 680 }
const desktopMetrics: Metrics = { row: 34, rowX: 12, rowY: 7, radius: 8, pageX: 32, gap: 22, button: 32, buttonSmall: 26, maxWidth: 720 }

/** At least this wide (the desktop app, a browser on a computer): the denser scale and a sidebar. */
export const WIDE = 760

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' })

export interface Theme {
  c: Colors
  t: TypeScale
  m: Metrics
  dark: boolean
  /** A wide window: sidebar navigation, desktop density. */
  wide: boolean
}

export function useTheme(): Theme {
  const scheme = useColorScheme()
  const { width } = useWindowDimensions()
  const wide = Platform.OS === 'web' && width >= WIDE
  const isDark = scheme === 'dark'
  return { c: isDark ? dark : light, t: wide ? desktop : phone, m: wide ? desktopMetrics : phoneMetrics, dark: isDark, wide }
}

/** Numbers that line up (counts, times, percentages). */
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] }
