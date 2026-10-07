import { test, expect } from '@playwright/test'
import {
  CANONICAL_ID_PATTERN,
  computeCanonicalTrackId,
  fingerprintHash,
  normalizeIsrc,
  normalizeMbid
} from '../../src/main/identity/canonical'

// canonical_track_id is the only track identifier that leaves a device, so
// the priority between its sources and what each one accepts is the contract.

const ISRC = 'USRC17607839'
const MBID = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const FP = 'a'.repeat(40)

// ── priority: ISRC, then MusicBrainz recording id, then fingerprint hash ──

test('ISRC wins over everything', () => {
  expect(
    computeCanonicalTrackId({
      isrc: ISRC,
      musicbrainz_recording_id: MBID,
      fingerprint_hash: FP
    })
  ).toBe(`isrc:${ISRC}`)
})

test('without an ISRC, the MusicBrainz recording id wins over the fingerprint hash', () => {
  expect(
    computeCanonicalTrackId({ isrc: null, musicbrainz_recording_id: MBID, fingerprint_hash: FP })
  ).toBe(`mbid:${MBID}`)
})

test('with only a fingerprint hash, that is the id', () => {
  expect(computeCanonicalTrackId({ fingerprint_hash: FP })).toBe(`fp:${FP}`)
})

test('with nothing, there is no id — never a placeholder, path or local id', () => {
  expect(computeCanonicalTrackId({})).toBeNull()
  expect(
    computeCanonicalTrackId({ isrc: null, musicbrainz_recording_id: null, fingerprint_hash: null })
  ).toBeNull()
})

test('an invalid higher-priority value is skipped, not trusted', () => {
  // A junk ISRC tag must not shadow a good recording id underneath it.
  expect(computeCanonicalTrackId({ isrc: 'not an isrc', musicbrainz_recording_id: MBID })).toBe(
    `mbid:${MBID}`
  )
  expect(
    computeCanonicalTrackId({
      isrc: '',
      musicbrainz_recording_id: 'nope',
      fingerprint_hash: FP
    })
  ).toBe(`fp:${FP}`)
  expect(computeCanonicalTrackId({ fingerprint_hash: 'short' })).toBeNull()
  expect(computeCanonicalTrackId({ fingerprint_hash: '/Users/dj/song.mp3' })).toBeNull()
})

test('adding a better source later changes the id in the expected direction', () => {
  const inputs: Parameters<typeof computeCanonicalTrackId>[0] = { fingerprint_hash: FP }
  expect(computeCanonicalTrackId(inputs)).toBe(`fp:${FP}`)
  inputs.musicbrainz_recording_id = MBID
  expect(computeCanonicalTrackId(inputs)).toBe(`mbid:${MBID}`)
  inputs.isrc = ISRC
  expect(computeCanonicalTrackId(inputs)).toBe(`isrc:${ISRC}`)
})

test('every id it produces matches the pattern the stats allowlist enforces', () => {
  for (const inputs of [
    { isrc: ISRC },
    { musicbrainz_recording_id: MBID },
    { fingerprint_hash: FP }
  ]) {
    const id = computeCanonicalTrackId(inputs)
    expect(id).toMatch(CANONICAL_ID_PATTERN)
  }
})

// ── ISRC normalization ────────────────────────────────────────────────────

test('ISRCs are upper-cased and de-hyphenated', () => {
  expect(normalizeIsrc('us-rc1-76-07839')).toBe(ISRC)
  expect(normalizeIsrc(' usrc17607839 ')).toBe(ISRC)
  expect(normalizeIsrc(ISRC)).toBe(ISRC)
})

test('a multi-valued ISRC tag yields its first valid value', () => {
  expect(normalizeIsrc(`${ISRC}/GBAYE0601498`)).toBe(ISRC)
  expect(normalizeIsrc(`junk;${ISRC}`)).toBe(ISRC)
  expect(normalizeIsrc(`${ISRC}\0GBAYE0601498`)).toBe(ISRC)
  expect(normalizeIsrc('GBAYE0601498, USRC17607839')).toBe('GBAYE0601498')
})

test('malformed ISRCs are rejected', () => {
  for (const bad of [
    '',
    'USRC1760783', // 11 chars
    'USRC176078399', // 13 chars
    '12RC17607839', // country must be letters
    'USRC1760783X', // the last seven are digits
    '/Users/dj/song.mp3',
    null,
    undefined,
    42
  ]) {
    expect(normalizeIsrc(bad), String(bad)).toBeNull()
  }
})

// ── recording id and fingerprint hash ─────────────────────────────────────

test('MusicBrainz ids are lower-cased uuids; anything else is rejected', () => {
  expect(normalizeMbid(MBID.toUpperCase())).toBe(MBID)
  expect(normalizeMbid(`  ${MBID}\n`)).toBe(MBID)
  for (const bad of ['', 'abc', `${MBID}0`, 'g9ad642e-b012-41c7-b72a-42cf4911f9ff', null, 7]) {
    expect(normalizeMbid(bad), String(bad)).toBeNull()
  }
})

test('the fingerprint hash is stable, 40 hex, and differs for different fingerprints', () => {
  const a = fingerprintHash('AQADtEmUaEmSJEEi')
  expect(a).toMatch(/^[0-9a-f]{40}$/)
  expect(fingerprintHash('AQADtEmUaEmSJEEi')).toBe(a)
  expect(fingerprintHash('AQADtEmUaEmSJEEj')).not.toBe(a)
  expect(fingerprintHash('')).toBeNull()
  expect(fingerprintHash(null)).toBeNull()
})

test('the id pattern rejects paths and look-alikes', () => {
  for (const bad of [
    '/Users/dj/Music/a.mp3',
    'isrc:usrc17607839', // wrong case
    `mbid:${MBID.toUpperCase()}`,
    `fp:${'a'.repeat(39)}`,
    `fp:${'g'.repeat(40)}`,
    `isrc:${ISRC}\n`,
    `x isrc:${ISRC}`
  ]) {
    expect(CANONICAL_ID_PATTERN.test(bad), bad).toBe(false)
  }
})
