import { test, expect } from '@playwright/test'
import {
  DISPLAY_DELIMITER,
  FIELD_DELIMITERS,
  isSafeToAutoSplit,
  isTagBackedField,
  joinValues,
  riskyDelimitersIn,
  splitValue,
  normalizeTagValue
} from '../../src/main/tagFields'

// The splitting rules for the five fields moving onto the tags model. Every
// case here is a real value from the reference library — the risk this covers
// is not abstract: splitting "Pete Rock & C.L. Smooth" on the ampersand
// invents an artist who does not exist, and failing to split
// "90s | HOUSE | HEADS | DANCE" loses three badges the DJ actually applied.

test('the display delimiter is what the app already writes', () => {
  // TagInput and BulkEditModal both join with this; changing it would strand
  // every existing derived column value.
  expect(DISPLAY_DELIMITER).toBe(' / ')
})

test('splits on the approved delimiter', () => {
  expect(splitValue('genre', 'Hip Hop / R&B / Soul')).toEqual(['Hip Hop', 'R&B', 'Soul'])
  expect(splitValue('artist', 'ATCQ / RASTA')).toEqual(['ATCQ', 'RASTA'])
})

test('grouping also splits on " | ", because the files themselves use it', () => {
  // Verified on disk: an MP3 whose TIT1 frame reads "90s | CLASSIC".
  expect(splitValue('grouping', '90s | HOUSE | HEADS | DANCE')).toEqual([
    '90s',
    'HOUSE',
    'HEADS',
    'DANCE'
  ])
  expect(splitValue('grouping', 'CLASSIC / CURRENT')).toEqual(['CLASSIC', 'CURRENT'])
  // Mixed conventions in one value — both halves are real.
  expect(splitValue('grouping', 'CLASSIC / CURRENT | 90s')).toEqual(['CLASSIC', 'CURRENT', '90s'])
})

test('no OTHER field splits on " | "', () => {
  // Only grouping's source data uses it. A genre containing a pipe is one
  // genre until someone says otherwise.
  expect(splitValue('genre', 'Hip Hop | Soul')).toEqual(['Hip Hop | Soul'])
  expect(FIELD_DELIMITERS.genre).toEqual([' / '])
})

test('never splits on a comma, ampersand, bare slash, " x " or "feat."', () => {
  // The whole point. Each of these is ONE value in the reference library.
  expect(splitValue('artist', 'Tyler, The Creator')).toEqual(['Tyler, The Creator'])
  expect(splitValue('artist', 'Pete Rock & C.L. Smooth')).toEqual(['Pete Rock & C.L. Smooth'])
  expect(splitValue('genre', 'Drum & Bass')).toEqual(['Drum & Bass'])
  expect(splitValue('genre', 'Afrobeat/R&B/Pop')).toEqual(['Afrobeat/R&B/Pop'])
  expect(splitValue('genre', 'R&B x Soul x Hip Hop')).toEqual(['R&B x Soul x Hip Hop'])
  expect(splitValue('artist', 'Chris Brown ft. Davido & Lojay')).toEqual([
    'Chris Brown ft. Davido & Lojay'
  ])
})

test('an ampersand inside an approved split survives', () => {
  // "R&B" must come out whole; splitting on "&" would produce "R" and "B".
  expect(splitValue('genre', 'Dance / R&B / SOUL')).toEqual(['Dance', 'R&B', 'SOUL'])
})

test('empty and whitespace values produce no tags, not an empty tag', () => {
  expect(splitValue('genre', '')).toEqual([])
  expect(splitValue('genre', '   ')).toEqual([])
  expect(splitValue('genre', null)).toEqual([])
  expect(splitValue('genre', undefined)).toEqual([])
  // A trailing delimiter must not yield a blank tag.
  expect(splitValue('genre', 'Hip Hop / ')).toEqual(['Hip Hop'])
  expect(splitValue('grouping', ' | CLASSIC | ')).toEqual(['CLASSIC'])
})

test('an unknown field is never split', () => {
  expect(isTagBackedField('title')).toBe(false)
  expect(splitValue('title', 'Some / Title')).toEqual(['Some / Title'])
})

test('joining is the inverse of splitting for approved delimiters', () => {
  const raw = 'Hip Hop / R&B / Soul'
  expect(joinValues(splitValue('genre', raw))).toBe(raw)
})

test('joining nothing gives null, not an empty string', () => {
  // The column's "no value" is null everywhere else in the schema.
  expect(joinValues([])).toBeNull()
  expect(joinValues(['', '   '])).toBeNull()
})

test('risky delimiters are named, so a review list can say why', () => {
  expect(riskyDelimitersIn('Foxy Brown, JAŸ-Z')).toContain('comma')
  expect(riskyDelimitersIn('Pete Rock & C.L. Smooth')).toContain('ampersand')
  expect(riskyDelimitersIn('Afrobeat/R&B/Pop')).toContain('slash-no-spaces')
  expect(riskyDelimitersIn('R&B x Soul x Hip Hop')).toContain('x-separator')
  expect(riskyDelimitersIn('Sade ft. Rema')).toContain('feat')
  expect(riskyDelimitersIn('Hip Hop')).toEqual([])
})

test('" / " is not itself flagged as risky', () => {
  // slash-no-spaces must not match the approved delimiter, or every
  // multi-value column would land in review.
  expect(riskyDelimitersIn('Hip Hop / Soul')).toEqual([])
})

test('auto-split safety is conservative where it has to be', () => {
  expect(isSafeToAutoSplit('genre', 'Hip Hop / Soul')).toBe(true)
  expect(isSafeToAutoSplit('grouping', '90s | CLASSIC')).toBe(true)
  expect(isSafeToAutoSplit('genre', '')).toBe(true)

  // One part, one ampersand: "R&B" and "Pete Rock & C.L. Smooth" are the same
  // shape from here. Both go to review rather than guessing either way.
  expect(isSafeToAutoSplit('artist', 'Pete Rock & C.L. Smooth')).toBe(false)
  expect(isSafeToAutoSplit('genre', 'Dance / R&B / SOUL')).toBe(false)
  expect(isSafeToAutoSplit('artist', 'Foxy Brown, Dru Hill')).toBe(false)
})

// ── normalizeTagValue ─────────────────────────────────────────────────────
// The bug this pins: the old genre rule lowercased everything after the first
// letter of each word, so "R&B" became "R&b" — creating a mangled duplicate
// beside the seeded "R&B" every time a genre was saved.

test('R&B survives normalization', () => {
  // The whole reason this function moved and changed.
  expect(normalizeTagValue('genre', 'R&B')).toBe('R&B')
  expect(normalizeTagValue('genre', 'Drum & Bass')).toBe('Drum & Bass')
})

test('a hyphenated genre keeps its hyphen and its capitals', () => {
  expect(normalizeTagValue('genre', 'Hip-Hop')).toBe('Hip-Hop')
})

test('plain words still fold, so casing variants converge', () => {
  // "SOUL" and "soul" both have to reach the seeded "Soul", or every shouty
  // import creates a second tag.
  expect(normalizeTagValue('genre', 'SOUL')).toBe('Soul')
  expect(normalizeTagValue('genre', 'soul')).toBe('Soul')
  expect(normalizeTagValue('genre', 'HIP HOP')).toBe('Hip Hop')
  expect(normalizeTagValue('genre', 'Afro House')).toBe('Afro House')
})

test('badge fields still uppercase', () => {
  expect(normalizeTagValue('custom', 'ftw')).toBe('FTW')
  expect(normalizeTagValue('vibe', 'dark')).toBe('DARK')
  expect(normalizeTagValue('venue', 'warehouse')).toBe('WAREHOUSE')
})

test('a record label keeps its capitalisation', () => {
  // Serato has a Label column and reads it from the file's publisher frame,
  // so this holds real label names. Uppercasing them would mean a DJ could
  // never type one correctly.
  expect(normalizeTagValue('label', 'Def Jam')).toBe('Def Jam')
  expect(normalizeTagValue('label', 'Ninja Tune')).toBe('Ninja Tune')
  expect(normalizeTagValue('label', '  Blue Note  ')).toBe('Blue Note')
  // And the value already in the library is untouched by the change.
  expect(normalizeTagValue('label', 'SERATOCOLLECTION')).toBe('SERATOCOLLECTION')
})

test('artist is preserved exactly as typed', () => {
  // Names are not ours to reformat: "JAŸ-Z", "Lil' Kim", "3rd Eye".
  expect(normalizeTagValue('artist', 'JAŸ-Z')).toBe('JAŸ-Z')
  expect(normalizeTagValue('artist', "Lil' Kim")).toBe("Lil' Kim")
  expect(normalizeTagValue('artist', '  Foxy Brown  ')).toBe('Foxy Brown')
})
