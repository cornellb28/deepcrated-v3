// ── BPM: formatting and the tempo colour scale ────────────────────────────
// The single source of truth for how a tempo looks, used by <Bpm> everywhere
// BPM is shown. Pure, so it is unit-tested directly.
//
// BPM deliberately breaks from the app's purple-grey palette: each tempo band
// has its own colour, blended across a few BPM at each boundary so 119 and
// 121 do not jump. The number itself always carries the meaning; colour is a
// second cue, never the only one (bpmBandLabel gives the words).

// Upper edges of each band, exclusive: < SLOW_MAX is slow, and so on.
export const BPM_BANDS = {
  SLOW_MAX: 90,
  MID_MAX: 120,
  UPBEAT_MAX: 135,
  FAST_MAX: 150
} as const

// Colours blend across this many BPM either side of each boundary.
export const BPM_BLEND = 3

export type BpmBand = 'slow' | 'mid' | 'upbeat' | 'fast' | 'veryFast'

// One HSL anchor per band. Lightness is kept high enough for WCAG AA (4.5:1)
// against the app's darkest surfaces at every point of the blend; the unit
// tests check that across the whole range.
export const BPM_BAND_COLORS: Record<BpmBand, { h: number; s: number; l: number }> = {
  slow: { h: 214, s: 92, l: 70 }, // cool blue
  mid: { h: 166, s: 72, l: 52 }, // teal-green
  upbeat: { h: 44, s: 96, l: 56 }, // amber-yellow
  fast: { h: 24, s: 98, l: 60 }, // orange
  veryFast: { h: 338, s: 92, l: 68 } // hot magenta-red
}

const BAND_LABEL: Record<BpmBand, string> = {
  slow: 'slow',
  mid: 'mid-tempo',
  upbeat: 'upbeat',
  fast: 'fast',
  veryFast: 'very fast'
}

// Stored BPM → a number, or null when there is no usable tempo. 0, negative,
// NaN and empty all mean "not measured", never a real tempo of 0.
export function bpmNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Whole numbers as they are; one decimal only when the stored value has a
// fractional part (117.5 stays 117.5, 128 never becomes 128.0). Empty: "—".
export function formatBpm(value: number | string | null | undefined): string {
  const n = bpmNumber(value)
  if (n === null) return '—'
  if (Number.isInteger(n)) return String(n)
  const one = Math.round(n * 10) / 10
  return Number.isInteger(one) ? String(one) : one.toFixed(1)
}

export function bpmBand(bpm: number): BpmBand {
  if (bpm < BPM_BANDS.SLOW_MAX) return 'slow'
  if (bpm < BPM_BANDS.MID_MAX) return 'mid'
  if (bpm < BPM_BANDS.UPBEAT_MAX) return 'upbeat'
  if (bpm < BPM_BANDS.FAST_MAX) return 'fast'
  return 'veryFast'
}

export function bpmBandLabel(bpm: number | null): string | null {
  return bpm === null ? null : BAND_LABEL[bpmBand(bpm)]
}

const ORDER: BpmBand[] = ['slow', 'mid', 'upbeat', 'fast', 'veryFast']
const EDGES = [BPM_BANDS.SLOW_MAX, BPM_BANDS.MID_MAX, BPM_BANDS.UPBEAT_MAX, BPM_BANDS.FAST_MAX]

// Hue goes the short way round, so fast → very fast passes through red.
function mixHue(a: number, b: number, t: number): number {
  let d = b - a
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return (((a + d * t) % 360) + 360) % 360
}

function mix(
  a: { h: number; s: number; l: number },
  b: { h: number; s: number; l: number },
  t: number
): { h: number; s: number; l: number } {
  return { h: mixHue(a.h, b.h, t), s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t }
}

export function bpmHsl(bpm: number): { h: number; s: number; l: number } {
  for (let i = 0; i < EDGES.length; i++) {
    const edge = EDGES[i]
    if (Math.abs(bpm - edge) < BPM_BLEND) {
      const t = (bpm - (edge - BPM_BLEND)) / (2 * BPM_BLEND)
      return mix(BPM_BAND_COLORS[ORDER[i]], BPM_BAND_COLORS[ORDER[i + 1]], t)
    }
  }
  return BPM_BAND_COLORS[bpmBand(bpm)]
}

// The colour for a tempo, as a CSS colour. null (no tempo) gets the neutral
// empty-state grey.
export const BPM_EMPTY_COLOR = '#6a6a80'

export function bpmColor(bpm: number | null): string {
  if (bpm === null) return BPM_EMPTY_COLOR
  const { h, s, l } = bpmHsl(bpm)
  return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`
}

// ── Contrast (for the tests, and anyone tuning the anchors) ───────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100
  const L = l / 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number): number => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number): number => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

// WCAG contrast ratio of a tempo's colour against a background hex colour.
export function bpmContrast(bpm: number, backgroundHex: string): number {
  const { h, s, l } = bpmHsl(bpm)
  const a = luminance(hslToRgb(h, s, l))
  const b = luminance(hexToRgb(backgroundHex))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
