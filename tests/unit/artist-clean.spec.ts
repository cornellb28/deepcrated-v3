import { test, expect } from '@playwright/test'
import {
  cleanArtist,
  cleanArtistString,
  createArtistIndex,
  editDistance,
  maxFuzzyDistance,
  normalizeArtistKey,
  type CleanContext
} from '../../src/main/artist/clean'

// The matching rules, with names taken from a real library. The failure that
// matters most is a confident WRONG answer — a different artist merged into
// one — so most of these are about what must NOT match.

const ctx = (over: Partial<CleanContext> = {}): CleanContext => ({
  tags: [
    { value: 'NOTORIOUS B.I.G', trackCount: 3 },
    { value: 'JAY Z', trackCount: 12 },
    { value: 'AALIYAH', trackCount: 4 },
    { value: 'R KELLY', trackCount: 4 },
    { value: 'SADE', trackCount: 3 },
    { value: 'LIL KIM', trackCount: 5 },
    { value: 'CASE', trackCount: 1 }
  ],
  library: [],
  keepRules: new Set(),
  ...over
})

// ── normalization ─────────────────────────────────────────────────────────

test('case, punctuation, periods and a leading "The" all normalize away', () => {
  const key = normalizeArtistKey('NOTORIOUS B.I.G')
  for (const variant of [
    'Notorious BIG',
    'The Notorious B.I.G.',
    'notorious b.i.g',
    '  The   Notorious  B.I.G.  '
  ]) {
    expect(normalizeArtistKey(variant), variant).toBe(key)
  }
})

test('a hyphen or an apostrophe is punctuation', () => {
  expect(normalizeArtistKey('Jay-Z')).toBe(normalizeArtistKey('JAY Z'))
  expect(normalizeArtistKey("Lil' Kim")).toBe(normalizeArtistKey('LIL KIM'))
  expect(normalizeArtistKey('R. Kelly')).toBe(normalizeArtistKey('R KELLY'))
})

test('only a LEADING "the" is dropped, and only as a whole word', () => {
  expect(normalizeArtistKey('The Roots')).toBe('roots')
  expect(normalizeArtistKey('Theory of a Deadman')).toBe('theory of a deadman')
  expect(normalizeArtistKey('Tyler, The Creator')).toBe('tyler the creator')
  expect(normalizeArtistKey('The The')).toBe('the')
})

test('accents are kept: folding them would be a silent guess', () => {
  expect(normalizeArtistKey('Beyoncé')).not.toBe(normalizeArtistKey('Beyonce'))
})

// ── the tiers ─────────────────────────────────────────────────────────────

test('identical after normalization is HIGH and takes the existing tag spelling', () => {
  const r = cleanArtist('Notorious BIG', ctx())
  expect(r).toEqual({
    canonical: 'NOTORIOUS B.I.G',
    confidence: 'high',
    reason: 'normalized-tag',
    raw: 'Notorious BIG'
  })
  expect(cleanArtist('The Notorious B.I.G.', ctx()).canonical).toBe('NOTORIOUS B.I.G')
  expect(cleanArtist("Lil' Kim", ctx()).canonical).toBe('LIL KIM')
})

test('a name that already is a tag is high and unchanged', () => {
  expect(cleanArtist('JAY Z', ctx())).toMatchObject({
    canonical: 'JAY Z',
    confidence: 'high',
    reason: 'exact-tag'
  })
})

test('a small edit distance from a tag is MEDIUM', () => {
  expect(cleanArtist('Aliyah', ctx())).toMatchObject({
    canonical: 'AALIYAH',
    confidence: 'medium',
    reason: 'fuzzy-tag'
  })
})

test('nothing close is LOW and unchanged', () => {
  expect(cleanArtist('Somebody Brand New', ctx())).toMatchObject({
    canonical: 'Somebody Brand New',
    confidence: 'low',
    reason: 'no-match'
  })
})

test('the raw string is always carried through untouched', () => {
  expect(cleanArtist('  The Notorious B.I.G.  ', ctx()).raw).toBe('  The Notorious B.I.G.  ')
})

// ── what must NOT match ───────────────────────────────────────────────────

test('short names never fuzzy-match: one letter is a different artist', () => {
  // "Cash" is one edit from the tag "CASE" and is not the same artist.
  expect(cleanArtist('Cash', ctx())).toMatchObject({ canonical: 'Cash', reason: 'no-match' })
  expect(cleanArtist('Sage', ctx())).toMatchObject({ canonical: 'Sage', reason: 'no-match' })
  expect(maxFuzzyDistance('cash', 'case')).toBe(0)
})

test('names that differ in a number are different artists', () => {
  const c = ctx({ tags: [{ value: 'Blink 182', trackCount: 5 }] })
  expect(cleanArtist('Blink 183', c)).toMatchObject({ canonical: 'Blink 183', reason: 'no-match' })
})

test('two equally close tags is no answer, not a coin flip', () => {
  const c = ctx({
    tags: [
      { value: 'Janet Jackson', trackCount: 5 },
      { value: 'Janet Jackspn', trackCount: 5 }
    ]
  })
  expect(cleanArtist('Janet Jacksan', c).reason).toBe('no-match')
})

test('fuzzy distance scales with length', () => {
  expect(maxFuzzyDistance('abcd', 'abce')).toBe(0)
  expect(maxFuzzyDistance('abcde', 'abcdf')).toBe(1)
  expect(maxFuzzyDistance('abcdefghij', 'abcdefghik')).toBe(2)
  expect(editDistance('kitten', 'sitting')).toBe(3)
  expect(editDistance('ab', 'ba')).toBe(1) // a swap is one edit
})

// ── never split on commas or ampersands ───────────────────────────────────

test('Tyler, The Creator stays ONE artist', () => {
  const parts = cleanArtistString('Tyler, The Creator', createArtistIndex(ctx())).parts
  expect(parts).toHaveLength(1)
  expect(parts[0].raw).toBe('Tyler, The Creator')
})

test('ampersands, feat., x and a bare slash do not split', () => {
  const index = createArtistIndex(ctx())
  for (const name of [
    'Pete Rock & C.L. Smooth',
    'Diddy ft. Mase',
    'Bonobo x Cyril Hahn',
    'Afrobeat/R&B/Pop',
    'Foxy Brown, JAŸ-Z'
  ]) {
    expect(cleanArtistString(name, index).parts, name).toHaveLength(1)
  }
})

test('the library delimiter " | " is the one split, and each artist is cleaned on its own', () => {
  const parts = cleanArtistString('Notorious BIG | Jay-Z', createArtistIndex(ctx())).parts
  expect(parts.map((p) => p.canonical)).toEqual(['NOTORIOUS B.I.G', 'JAY Z'])
  expect(parts.every((p) => p.confidence === 'high')).toBe(true)
})

test('the legacy " / " still splits when read', () => {
  expect(cleanArtistString('A / B', createArtistIndex(ctx())).parts).toHaveLength(2)
})

// ── keep rules ────────────────────────────────────────────────────────────

test('a kept raw string comes back unchanged, even when a tag would match it', () => {
  const r = cleanArtist('Notorious BIG', ctx({ keepRules: new Set(['Notorious BIG']) }))
  expect(r).toMatchObject({ canonical: 'Notorious BIG', reason: 'kept' })
})

test('a keep rule is for that exact string only', () => {
  const c = ctx({ keepRules: new Set(['Notorious BIG']) })
  expect(cleanArtist('Notorious B.I.G.', c).canonical).toBe('NOTORIOUS B.I.G')
})

// ── library spellings ─────────────────────────────────────────────────────

test('with no tag, the clearly most common library spelling wins — as MEDIUM, never high', () => {
  const c = ctx({
    tags: [],
    library: [
      { raw: 'OutKast', count: 1 },
      { raw: 'Outkast', count: 6 }
    ]
  })
  expect(cleanArtist('OutKast', c)).toMatchObject({
    canonical: 'Outkast',
    confidence: 'medium',
    reason: 'normalized-library'
  })
})

test('a tie between library spellings changes nothing', () => {
  const c = ctx({
    tags: [],
    library: [
      { raw: 'Ciara', count: 2 },
      { raw: 'CIARA', count: 2 }
    ]
  })
  expect(cleanArtist('Ciara', c).canonical).toBe('Ciara')
  expect(cleanArtist('CIARA', c).canonical).toBe('CIARA')
})

test('the commonest spelling is never changed to a rarer one', () => {
  const c = ctx({
    tags: [],
    library: [
      { raw: 'Janet Jackson', count: 7 },
      { raw: 'Jared Jackson', count: 2 }
    ]
  })
  expect(cleanArtist('Janet Jackson', c).canonical).toBe('Janet Jackson')
  // the rarer one may point at the commoner one, as the weakest tier
  expect(cleanArtist('Jared Jackson', c)).toMatchObject({
    canonical: 'Janet Jackson',
    confidence: 'low',
    reason: 'fuzzy-library'
  })
})

test('the more common of two near names never points at the rarer one', () => {
  const c = ctx({
    tags: [],
    library: [
      { raw: 'Black Rob', count: 3 },
      { raw: 'Black Box', count: 1 }
    ]
  })
  expect(cleanArtist('Black Rob', c).canonical).toBe('Black Rob')
})

test('empty and punctuation-only names are left alone', () => {
  expect(cleanArtist('', ctx()).reason).toBe('empty')
  expect(cleanArtist('   ', ctx()).reason).toBe('empty')
  expect(cleanArtist('...', ctx())).toMatchObject({ canonical: '...', reason: 'no-match' })
})

test('a tag added mid-batch is seen by the rest of the batch', () => {
  const index = createArtistIndex(ctx({ tags: [] }))
  expect(index.clean('New Artist').reason).toBe('no-match')
  index.addTag('NEW ARTIST')
  expect(index.clean('New Artist')).toMatchObject({ canonical: 'NEW ARTIST', confidence: 'high' })
})
