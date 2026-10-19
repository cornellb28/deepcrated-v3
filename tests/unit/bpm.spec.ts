import { test, expect } from '@playwright/test'
import {
  BPM_BANDS,
  BPM_BLEND,
  BPM_EMPTY_COLOR,
  bpmBand,
  bpmBandLabel,
  bpmColor,
  bpmContrast,
  bpmHsl,
  bpmNumber,
  formatBpm
} from '../../src/renderer/src/lib/bpm'

// BPM display helpers (src/renderer/src/lib/bpm.ts): formatting, the empty
// state, the tempo bands and their colours.

test('formatting: always a whole number, rounded to the nearest, never a dot', () => {
  expect(formatBpm(128)).toBe('128')
  expect(formatBpm(117.5)).toBe('118')
  expect(formatBpm(129.2)).toBe('129')
  expect(formatBpm(143.6)).toBe('144')
  expect(formatBpm(99.96)).toBe('100')
  expect(formatBpm('123.4')).toBe('123')
  for (let bpm = 60; bpm <= 200; bpm += 0.1) expect(formatBpm(bpm)).not.toContain('.')
})

test('empty state: null, 0, negative, NaN and junk all read "—", never 0', () => {
  for (const v of [null, undefined, 0, -5, NaN, '', 'abc', Infinity]) {
    expect(formatBpm(v as number | string | null | undefined)).toBe('—')
    expect(bpmNumber(v as number | string | null | undefined)).toBeNull()
  }
  expect(bpmColor(null)).toBe(BPM_EMPTY_COLOR)
  expect(bpmBandLabel(null)).toBeNull()
})

test('band boundaries are exclusive upper edges', () => {
  expect(bpmBand(BPM_BANDS.SLOW_MAX - 0.1)).toBe('slow')
  expect(bpmBand(BPM_BANDS.SLOW_MAX)).toBe('mid')
  expect(bpmBand(BPM_BANDS.MID_MAX - 0.1)).toBe('mid')
  expect(bpmBand(BPM_BANDS.MID_MAX)).toBe('upbeat')
  expect(bpmBand(BPM_BANDS.UPBEAT_MAX - 0.1)).toBe('upbeat')
  expect(bpmBand(BPM_BANDS.UPBEAT_MAX)).toBe('fast')
  expect(bpmBand(BPM_BANDS.FAST_MAX - 0.1)).toBe('fast')
  expect(bpmBand(BPM_BANDS.FAST_MAX)).toBe('veryFast')
  expect(bpmBandLabel(70)).toBe('slow')
  expect(bpmBandLabel(174)).toBe('very fast')
})

test('colours: steady inside a band, blended across each boundary', () => {
  // Well inside a band: the anchor colour, the same at both ends.
  expect(bpmColor(100)).toBe(bpmColor(110))
  expect(bpmColor(70)).not.toBe(bpmColor(100))
  // At a boundary the colour is halfway, so neither side jumps.
  for (const edge of Object.values(BPM_BANDS)) {
    const below = bpmHsl(edge - BPM_BLEND)
    const at = bpmHsl(edge)
    const above = bpmHsl(edge + BPM_BLEND)
    expect(at.l).toBeCloseTo((below.l + above.l) / 2, 5)
    // One BPM never moves the hue by more than a slice of the gap.
    const d = Math.abs(bpmHsl(edge + 1).h - bpmHsl(edge).h) % 360
    expect(Math.min(d, 360 - d)).toBeLessThan(40) // hue is a circle
  }
  // fast → very fast blends through red, not back through green.
  const h = bpmHsl(BPM_BANDS.FAST_MAX).h
  expect(h < 30 || h > 330).toBe(true)
})

test('every tempo meets WCAG AA (4.5:1) on the app’s dark surfaces', () => {
  for (const bg of ['#12121a', '#13131b', '#1a1a26']) {
    for (let bpm = 40; bpm <= 220; bpm += 0.5) {
      expect(bpmContrast(bpm, bg), `${bpm} BPM on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
