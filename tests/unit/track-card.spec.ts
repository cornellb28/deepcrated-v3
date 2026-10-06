import { test, expect } from '@playwright/test'
import {
  ANALYSIS_STAGE_LABELS,
  TRACK_CARD_ARTWORK,
  TRACK_CARD_HEIGHT,
  TRACK_CARD_PADDING,
  analysisPercent,
  fileFormat,
  isAnalysed,
  trackDuration,
  trackMetaParts,
  trackStats,
  trackGridColumns
} from '../../src/renderer/src/lib/trackCard'

// Covers the field logic behind the index-card grid. The library these
// cards render is sparse — most rows have no genre, label or energy, and
// the `format` column is populated for none of them — so most of what is
// worth pinning down here is what happens when a field is absent.

// ── Sizing ────────────────────────────────────────────────────────────────

test('the artwork exactly fills the card between its padding', () => {
  expect(TRACK_CARD_ARTWORK).toBe(TRACK_CARD_HEIGHT - TRACK_CARD_PADDING * 2)
})

test('the grid column template uses the shared minimum width', () => {
  expect(trackGridColumns).toBe('repeat(auto-fill, minmax(380px, 1fr))')
})

// ── Format ────────────────────────────────────────────────────────────────

test('the format comes from the extension, not the unpopulated column', () => {
  expect(fileFormat('/Volumes/M/GEK/Track.mp3')).toBe('MP3')
  expect(fileFormat('/Volumes/M/GEK/Track.flac')).toBe('FLAC')
  expect(fileFormat('/Volumes/M/GEK/Track.m4a')).toBe('M4A')
})

test('a dot in a folder name is not mistaken for an extension', () => {
  expect(fileFormat('/Volumes/M/Vol. 2/trackname')).toBeNull()
})

test('a file with no extension or no path has no format', () => {
  expect(fileFormat('/Volumes/M/trackname')).toBeNull()
  expect(fileFormat(null)).toBeNull()
  expect(fileFormat('')).toBeNull()
})

test('something that is not really an extension is rejected', () => {
  expect(fileFormat('/Volumes/M/track.somethinglong')).toBeNull()
})

// ── Duration ──────────────────────────────────────────────────────────────

test('the preformatted duration wins over the seconds column', () => {
  expect(trackDuration({ duration_str: '4:22', duration_sec: 999 })).toBe('4:22')
})

test('seconds are formatted when no string was stored', () => {
  expect(trackDuration({ duration_sec: 262 })).toBe('4:22')
  expect(trackDuration({ duration_sec: 9 })).toBe('0:09')
  expect(trackDuration({ duration_sec: 600 })).toBe('10:00')
})

test('a missing or nonsense duration reads as absent', () => {
  expect(trackDuration({})).toBeNull()
  expect(trackDuration({ duration_sec: 0 })).toBeNull()
  expect(trackDuration({ duration_sec: null, duration_str: null })).toBeNull()
  expect(trackDuration({ duration_sec: Number.NaN })).toBeNull()
})

// ── Meta line ─────────────────────────────────────────────────────────────

test('only the fields that have a value appear on the meta line', () => {
  expect(trackMetaParts({ album: 'Hard Core', year: '1996', genre: null, label: '' })).toEqual([
    'Hard Core',
    '1996'
  ])
})

test('empty strings count as missing, since the schema defaults to them', () => {
  expect(trackMetaParts({ album: '', year: '   ', genre: '', label: '' })).toEqual([])
})

test('the meta line keeps album, year, genre and label in that order', () => {
  expect(trackMetaParts({ album: 'A', year: '2001', genre: 'House', label: 'L' })).toEqual([
    'A',
    '2001',
    'House',
    'L'
  ])
})

// ── Stats ─────────────────────────────────────────────────────────────────

test('stats appear in reading order and skip what is missing', () => {
  const stats = trackStats({
    bpm: 95.7,
    key_camelot: '11A',
    energy: null,
    duration_str: '4:22',
    filepath: '/m/a.mp3'
  })
  expect(stats.map((s) => [s.label, s.value])).toEqual([
    ['BPM', '95.7'],
    ['KEY', '11A'],
    ['TIME', '4:22'],
    ['FILE', 'MP3']
  ])
})

test('energy only takes a slot when it is set', () => {
  const withEnergy = trackStats({ bpm: 120, energy: 7, filepath: '/m/a.mp3' })
  expect(withEnergy.map((s) => s.label)).toEqual(['BPM', 'NRG', 'FILE'])
})

test('a track with nothing analysed still shows its file format', () => {
  expect(trackStats({ filepath: '/m/a.flac' }).map((s) => s.value)).toEqual(['FLAC'])
})

// ── Analysis state ────────────────────────────────────────────────────────

test('either tempo or key counts as analysed', () => {
  expect(isAnalysed({ bpm: 128 })).toBe(true)
  expect(isAnalysed({ key_camelot: '8A' })).toBe(true)
})

test('neither tempo nor key is the state the card calls out', () => {
  expect(isAnalysed({})).toBe(false)
  expect(isAnalysed({ bpm: null, key_camelot: null })).toBe(false)
  // 0 BPM is a failed analysis, not a tempo.
  expect(isAnalysed({ bpm: 0, key_camelot: '' })).toBe(false)
})

// ── Re-analysis progress bar ──────────────────────────────────────────────
// analyze.py's stage events drive the bar along the bottom of a card, so what
// matters here is that a width can never come back nonsensical: the events
// arrive over IPC from a separate process whose stage count can change
// independently of this code.

test('the bar tracks stages finished, not stages started', () => {
  // 'decode' arrives with one stage behind it, and it is the long one — the
  // bar sits at 20% for most of a real analysis.
  expect(analysisPercent({ step: 0, steps: 5 })).toBe(0)
  expect(analysisPercent({ step: 1, steps: 5 })).toBe(20)
  expect(analysisPercent({ step: 5, steps: 5 })).toBe(100)
})

test('a width is always a percentage of the card, whatever the payload says', () => {
  expect(analysisPercent({ step: 9, steps: 5 })).toBe(100)
  expect(analysisPercent({ step: -3, steps: 5 })).toBe(0)
  expect(analysisPercent({ step: 1, steps: 3 })).toBe(33)
})

test('a payload that cannot describe progress reads as no progress', () => {
  expect(analysisPercent({ step: 0, steps: 0 })).toBe(0)
  expect(analysisPercent({ step: 1, steps: Number.NaN })).toBe(0)
  expect(analysisPercent({ step: Number.POSITIVE_INFINITY, steps: 5 })).toBe(0)
})

test('every stage the sidecar can report has something to call it', () => {
  // Mirrors _emit_progress's stages in sidecar/analyze.py plus the renderer's
  // own 'queued'. A stage with no label would render as "undefined" on the card.
  expect(Object.keys(ANALYSIS_STAGE_LABELS)).toEqual([
    'queued',
    'tags',
    'decode',
    'bpm',
    'key',
    'artwork',
    'done'
  ])
  for (const label of Object.values(ANALYSIS_STAGE_LABELS)) {
    expect(label.length).toBeGreaterThan(0)
  }
})
