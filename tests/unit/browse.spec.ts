import { test, expect } from '@playwright/test'
import { splitValue } from '../../src/main/tagFields'
import {
  normalizeArtistKey,
  pickDisplayName,
  splitArtists,
  trackArtists
} from '../../src/renderer/src/lib/browse/artist'
import {
  BROWSE_DIMENSIONS,
  distinctValueCount,
  getDimension
} from '../../src/renderer/src/lib/browse/registry'
import {
  indexOfLetter,
  jumpLetter,
  lettersPresent,
  listValues
} from '../../src/renderer/src/lib/browse/listing'
import {
  browseCrumbs,
  DEFAULT_PAGE,
  INITIAL_NAV,
  currentLocation,
  navReducer,
  pageFor,
  type BrowseNavState
} from '../../src/renderer/src/lib/browse/nav'
import type { BrowseContext, BrowseValue } from '../../src/renderer/src/lib/browse/types'

// ── Fixture ─────────────────────────────────────────────────────────────
// A small library with KNOWN contents, so every expected set is stated by
// hand rather than derived from the code under test.

function track(id: number, artist: string | null, extra: Partial<Track> = {}): Track {
  return { id, artist, title: `T${id}`, missing: 0, ...extra } as Track
}

function tag(id: number, field: string, value: string): Tag {
  return { id, field, value, color: '#fff', created_at: 0 }
}

const HOUSE = tag(1, 'genre', 'House')
const TECHNO = tag(2, 'genre', 'Techno')
const DARK = tag(3, 'comment', 'DARK')
const UNUSED = tag(4, 'genre', 'Never Used')

function fixture(): BrowseContext {
  const tracks = [
    track(1, 'Aaliyah'),
    track(2, 'aaliyah'), // case variant
    track(3, '  AALIYAH  '), // case + whitespace variant
    track(4, 'Foxy Brown / Dru Hill'), // two artists
    track(5, 'Dru Hill'),
    track(6, 'Heather  B'), // inner double space
    track(7, 'heather b'),
    track(8, ''), // no artist
    track(9, '   '), // whitespace only: no artist
    track(10, null), // no artist
    track(11, 'AC/DC'), // bare slash: one artist
    track(12, 'Tyler, The Creator'), // comma: one artist
    track(13, 'Pete Rock & C.L. Smooth', { missing: 1 }), // missing file
    track(14, 'Same / same') // duplicate inside one track
  ]
  const trackTags = new Map<number, Tag[]>([
    [1, [HOUSE, DARK]],
    [2, [HOUSE]],
    [3, [TECHNO]],
    [4, [HOUSE, TECHNO]],
    [5, [DARK]]
    // 6..14 untagged
  ])
  return { tracks, trackTags }
}

const ids = (tracks: readonly Track[]): number[] => tracks.map((t) => t.id)

function value(values: BrowseValue[], label: string): BrowseValue {
  const found = values.find((v) => v.label === label)
  if (!found) throw new Error(`no value "${label}" in ${values.map((v) => v.label).join(', ')}`)
  return found
}

// ── Artist grouping ─────────────────────────────────────────────────────

test('case and whitespace variants collapse into one artist', () => {
  const values = getDimension('artist')!.values(fixture())
  const aaliyah = values.filter((v) => v.label.toLowerCase().trim() === 'aaliyah')
  expect(aaliyah).toHaveLength(1)
  expect(aaliyah[0].count).toBe(3)
  const heather = values.filter((v) => v.label.toLowerCase().replace(/\s+/g, ' ') === 'heather b')
  expect(heather).toHaveLength(1)
  expect(heather[0].count).toBe(2)
})

test('normalising trims, collapses inner spaces, lowercases, and unifies Unicode forms', () => {
  expect(normalizeArtistKey('  Heather   B ')).toBe('heather b')
  expect(normalizeArtistKey('JAŸ-Z')).toBe(normalizeArtistKey('jaÿ-z'))
  // Composed and decomposed é are the same artist.
  expect(normalizeArtistKey('Beyoncé')).toBe(normalizeArtistKey('Beyoncé'))
  // Accents are NOT stripped for grouping.
  expect(normalizeArtistKey('Beyoncé')).not.toBe(normalizeArtistKey('Beyonce'))
})

test('the displayed spelling is the most common one', () => {
  const values = getDimension('artist')!.values(fixture())
  // 'Aaliyah' (1), 'aaliyah' (1), 'AALIYAH' (1): a three-way tie prefers the
  // mixed-case spelling.
  const labels = values.filter((v) => normalizeArtistKey(v.label) === 'aaliyah').map((v) => v.label)
  expect(labels).toEqual(['Aaliyah'])
  // And a clear majority wins outright.
  expect(
    pickDisplayName(
      new Map([
        ['AALIYAH', 3],
        ['Aaliyah', 1]
      ])
    )
  ).toBe('AALIYAH')
})

// ── Splitting on " / " only ─────────────────────────────────────────────

test('a multi-artist string counts under each artist it names', () => {
  const ctx = fixture()
  const artist = getDimension('artist')!
  const values = artist.values(ctx)
  expect(value(values, 'Foxy Brown').count).toBe(1)
  // Dru Hill: track 4 (as part of the pair) and track 5 on its own.
  expect(value(values, 'Dru Hill').count).toBe(2)
  expect(ids(artist.tracksFor(ctx, value(values, 'Dru Hill').key))).toEqual([4, 5])
})

test('only " / " splits: commas, ampersands and bare slashes stay whole', () => {
  const values = getDimension('artist')!.values(fixture())
  for (const whole of ['AC/DC', 'Tyler, The Creator', 'Pete Rock & C.L. Smooth']) {
    expect(value(values, whole).count).toBe(1)
  }
  expect(values.some((v) => v.label === 'Tyler')).toBe(false)
  expect(values.some((v) => v.label === 'AC')).toBe(false)
})

test('the same artist twice on one track counts once', () => {
  const ctx = fixture()
  expect(value(getDimension('artist')!.values(ctx), 'Same').count).toBe(1)
  expect(trackArtists({ artist: 'Same / same' } as Track)).toHaveLength(1)
})

test('splitting agrees with the real splitValue in main', () => {
  // The renderer cannot import main's module at runtime, so it carries its
  // own copy of the rule; this is what stops the two drifting.
  const samples = [
    'Foxy Brown / Dru Hill',
    'A / B / C',
    ' A /  B ',
    'Hip Hop / ',
    'AC/DC',
    'Tyler, The Creator',
    'A & B',
    'A feat. B',
    '',
    '   ',
    ' / ',
    'Solo'
  ]
  for (const sample of samples) {
    expect(splitArtists(sample), JSON.stringify(sample)).toEqual(splitValue('artist', sample))
  }
  expect(splitArtists(null)).toEqual([])
})

// ── Registry ────────────────────────────────────────────────────────────

test('the hub lists genre, tags and artist, each with what a card needs', () => {
  expect(BROWSE_DIMENSIONS.map((d) => d.id)).toEqual(['genre', 'tags', 'artist'])
  for (const d of BROWSE_DIMENSIONS) {
    expect(d.label).toBeTruthy()
    expect(d.description).toBeTruthy()
    expect(['cards', 'list']).toContain(d.presentation)
    expect(getDimension(d.id)).toBe(d)
  }
  expect(getDimension('nope')).toBeUndefined()
})

test('genre lists genre tags with counts, and nothing from other fields', () => {
  const values = getDimension('genre')!.values(fixture())
  expect(value(values, 'House').count).toBe(3)
  expect(value(values, 'Techno').count).toBe(2)
  expect(values.some((v) => v.label === 'DARK')).toBe(false)
  // A tag on no track would open an empty page, so it is not listed.
  expect(values.some((v) => v.label === UNUSED.value)).toBe(false)
})

test('tags lists every field, with the tag itself and its field attached', () => {
  const values = getDimension('tags')!.values(fixture())
  expect(value(values, 'DARK')).toMatchObject({ count: 2, group: 'comment', kind: 'value' })
  expect(value(values, 'DARK').tag?.id).toBe(DARK.id)
  expect(value(values, 'House').group).toBe('genre')
})

test('the distinct-value count a card shows excludes buckets', () => {
  const ctx = fixture()
  for (const d of BROWSE_DIMENSIONS) {
    const values = d.values(ctx)
    expect(distinctValueCount(values)).toBe(values.filter((v) => v.kind === 'value').length)
    expect(distinctValueCount(values)).toBeLessThan(values.length) // each has a bucket here
  }
})

// ── Counts equal list lengths ───────────────────────────────────────────

test('for every value in every dimension, the count equals the list it opens', () => {
  const ctx = fixture()
  let checked = 0
  for (const d of BROWSE_DIMENSIONS) {
    for (const v of d.values(ctx)) {
      expect(d.tracksFor(ctx, v.key), `${d.id}/${v.label}`).toHaveLength(v.count)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(10)
})

test('a list never repeats a track, however many artists or tags it carries', () => {
  const ctx = fixture()
  for (const d of BROWSE_DIMENSIONS) {
    for (const v of d.values(ctx)) {
      const list = ids(d.tracksFor(ctx, v.key))
      expect(new Set(list).size, `${d.id}/${v.label}`).toBe(list.length)
    }
  }
})

test('an unknown key opens nothing rather than everything', () => {
  const ctx = fixture()
  for (const d of BROWSE_DIMENSIONS) {
    expect(d.tracksFor(ctx, 'bogus')).toEqual([])
    expect(d.tracksFor(ctx, 'tag:notanumber')).toEqual([])
  }
})

// ── Buckets ─────────────────────────────────────────────────────────────

test('"No artist" holds exactly the tracks with no artist at all', () => {
  const ctx = fixture()
  const artist = getDimension('artist')!
  const bucket = artist.values(ctx).find((v) => v.kind === 'bucket')!
  expect(bucket.label).toBe('No artist')
  // '', whitespace only, and null — and not 'AC/DC' or anyone else.
  expect(ids(artist.tracksFor(ctx, bucket.key))).toEqual([8, 9, 10])
})

test('"Untagged" holds exactly the tracks with no tags', () => {
  const ctx = fixture()
  const tags = getDimension('tags')!
  const bucket = tags.values(ctx).find((v) => v.kind === 'bucket')!
  expect(ids(tags.tracksFor(ctx, bucket.key))).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14])
})

test('"No genre" holds the tracks with no genre TAG, even if they carry a comment tag', () => {
  const ctx = fixture()
  const genre = getDimension('genre')!
  const bucket = genre.values(ctx).find((v) => v.kind === 'bucket')!
  // Track 5 has only a comment tag, so it has no genre.
  expect(ids(genre.tracksFor(ctx, bucket.key))).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
})

test('a dimension with no gaps has no bucket', () => {
  const ctx: BrowseContext = {
    tracks: [track(1, 'A')],
    trackTags: new Map([[1, [HOUSE]]])
  }
  for (const d of BROWSE_DIMENSIONS) {
    expect(
      d.values(ctx).some((v) => v.kind === 'bucket'),
      d.id
    ).toBe(false)
  }
})

test('missing-file tracks are counted and listed, as the genre and tag views do', () => {
  const ctx = fixture()
  const artist = getDimension('artist')!
  const v = value(artist.values(ctx), 'Pete Rock & C.L. Smooth')
  expect(ids(artist.tracksFor(ctx, v.key))).toEqual([13])
})

// ── Empty states ────────────────────────────────────────────────────────

test('an empty library gives every dimension no values and no buckets', () => {
  const empty: BrowseContext = { tracks: [], trackTags: new Map() }
  for (const d of BROWSE_DIMENSIONS) expect(d.values(empty), d.id).toEqual([])
})

test('a library with no tags: tags and genre are empty but everything is Untagged / No genre', () => {
  const ctx: BrowseContext = { tracks: [track(1, 'A'), track(2, 'B')], trackTags: new Map() }
  expect(
    getDimension('tags')!
      .values(ctx)
      .map((v) => [v.label, v.count, v.kind])
  ).toEqual([['Untagged', 2, 'bucket']])
  expect(distinctValueCount(getDimension('genre')!.values(ctx))).toBe(0)
})

// ── Live updates ────────────────────────────────────────────────────────
// The views are functions of the store snapshot, so "updates after an edit"
// is "recomputing after the store changes". These apply the same changes the
// store's setters make.

test('a tag edit moves a track between lists and counts', () => {
  const ctx = fixture()
  const tags = getDimension('tags')!
  const before = value(tags.values(ctx), 'DARK').count

  const edited = new Map(ctx.trackTags)
  edited.set(6, [DARK]) // Inspector: tag an untagged track
  const next = { tracks: ctx.tracks, trackTags: edited }

  expect(value(tags.values(next), 'DARK').count).toBe(before + 1)
  const untagged = tags.values(next).find((v) => v.kind === 'bucket')!
  expect(untagged.count).toBe(value(tags.values(ctx), 'Untagged').count - 1)
  expect(ids(tags.tracksFor(next, untagged.key))).not.toContain(6)
})

test('an import adds the track to its artist; a rename moves it between artists', () => {
  const ctx = fixture()
  const artist = getDimension('artist')!
  const imported = [...ctx.tracks, track(99, 'Brand New')]
  expect(value(artist.values({ ...ctx, tracks: imported }), 'Brand New').count).toBe(1)

  const renamed = ctx.tracks.map((t) => (t.id === 5 ? { ...t, artist: 'Foxy Brown' } : t))
  const after = artist.values({ ...ctx, tracks: renamed })
  expect(value(after, 'Dru Hill').count).toBe(1)
  expect(value(after, 'Foxy Brown').count).toBe(2)
})

test('a file move changes nothing the dimensions see', () => {
  // A move changes filepath/folder_id; no browse dimension reads those.
  const ctx = fixture()
  const moved = ctx.tracks.map((t) => ({ ...t, filepath: `/elsewhere/${t.id}.mp3`, folder_id: 7 }))
  for (const d of BROWSE_DIMENSIONS) {
    expect(d.values({ ...ctx, tracks: moved as Track[] }), d.id).toEqual(d.values(ctx))
  }
})

test('a file going missing keeps the track in its lists', () => {
  const ctx = fixture()
  const gone = ctx.tracks.map((t) => (t.id === 1 ? { ...t, missing: 1 } : t))
  const artist = getDimension('artist')!
  const key = value(artist.values({ ...ctx, tracks: gone }), 'Aaliyah').key
  expect(artist.tracksFor({ ...ctx, tracks: gone }, key)).toHaveLength(3)
})

// ── Listing: search, sort, buckets last, jump bar ───────────────────────

function sample(): BrowseValue[] {
  return getDimension('artist')!.values(fixture())
}

test('search is case- and accent-insensitive and filters by label', () => {
  const values: BrowseValue[] = [
    { key: 'a', label: 'Beyoncé', count: 1, kind: 'value' },
    { key: 'b', label: 'Bob', count: 1, kind: 'value' }
  ]
  const none = { sort: 'name' as const, group: null }
  expect(listValues(values, { ...none, search: 'beyonce' }).map((v) => v.label)).toEqual([
    'Beyoncé'
  ])
  expect(listValues(values, { ...none, search: 'BO' }).map((v) => v.label)).toEqual(['Bob'])
  expect(listValues(values, { ...none, search: 'zzz' })).toEqual([])
  expect(listValues(values, { ...none, search: '   ' })).toHaveLength(2)
})

test('sort by name and by count; buckets stay last either way', () => {
  const values = sample()
  for (const sort of ['name', 'count'] as const) {
    const listed = listValues(values, { search: '', sort, group: null })
    expect(listed.at(-1)?.kind).toBe('bucket')
    expect(listed.slice(0, -1).every((v) => v.kind === 'value')).toBe(true)
  }
  const byCount = listValues(values, { search: '', sort: 'count', group: null })
  const counts = byCount.filter((v) => v.kind === 'value').map((v) => v.count)
  expect(counts).toEqual([...counts].sort((a, b) => b - a))
  const byName = listValues(values, { search: '', sort: 'name', group: null })
    .filter((v) => v.kind === 'value')
    .map((v) => v.label)
  expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)))
})

test('a field filter hides other fields but never the bucket', () => {
  const values = getDimension('tags')!.values(fixture())
  const listed = listValues(values, { search: '', sort: 'name', group: 'comment' })
  expect(listed.filter((v) => v.kind === 'value').map((v) => v.label)).toEqual(['DARK'])
  expect(listed.some((v) => v.kind === 'bucket')).toBe(true)
})

test('jump letters: folded first letter, # for the rest', () => {
  expect(jumpLetter('Aaliyah')).toBe('A')
  expect(jumpLetter('élan')).toBe('E')
  expect(jumpLetter('2Pac')).toBe('#')
  expect(jumpLetter('!!!')).toBe('#')
  expect(jumpLetter('')).toBe('#')
})

test('the jump bar lands on the first entry for a letter and knows which are empty', () => {
  const values = listValues(sample(), { search: '', sort: 'name', group: null })
  const d = indexOfLetter(values, 'D')
  expect(values[d].label).toBe('Dru Hill')
  expect(indexOfLetter(values, 'Q')).toBe(-1)
  const present = lettersPresent(values)
  expect(present.has('A')).toBe(true)
  expect(present.has('Q')).toBe(false)
})

// ── Navigation ──────────────────────────────────────────────────────────

function results(): BrowseNavState {
  let s = navReducer(INITIAL_NAV, {
    type: 'open',
    location: { kind: 'dimension', dimensionId: 'artist' }
  })
  s = navReducer(s, {
    type: 'open',
    location: {
      kind: 'results',
      dimensionId: 'artist',
      valueKey: 'artist:aaliyah',
      label: 'Aaliyah',
      tagIds: []
    }
  })
  return s
}

test('the hub is the root and Back from it does nothing', () => {
  expect(currentLocation(INITIAL_NAV)).toEqual({ kind: 'hub' })
  expect(navReducer(INITIAL_NAV, { type: 'back' })).toBe(INITIAL_NAV)
})

test('Back returns to the previous page with its search, sort and scroll intact', () => {
  let s = navReducer(INITIAL_NAV, {
    type: 'open',
    location: { kind: 'dimension', dimensionId: 'artist' }
  })
  s = navReducer(s, {
    type: 'setPage',
    dimensionId: 'artist',
    patch: { search: 'aal', sort: 'count', scrollTop: 640 }
  })
  s = navReducer(s, {
    type: 'open',
    location: {
      kind: 'results',
      dimensionId: 'artist',
      valueKey: 'artist:aaliyah',
      label: 'Aaliyah',
      tagIds: []
    }
  })
  s = navReducer(s, { type: 'back' })

  expect(currentLocation(s)).toEqual({ kind: 'dimension', dimensionId: 'artist' })
  expect(pageFor(s, 'artist')).toEqual({
    ...DEFAULT_PAGE,
    search: 'aal',
    sort: 'count',
    scrollTop: 640
  })
})

test('page state is per dimension and starts from the defaults', () => {
  let s = navReducer(INITIAL_NAV, {
    type: 'setPage',
    dimensionId: 'artist',
    patch: { search: 'x' }
  })
  expect(pageFor(s, 'artist').search).toBe('x')
  expect(pageFor(s, 'tags')).toEqual(DEFAULT_PAGE)
  s = navReducer(s, { type: 'setPage', dimensionId: 'artist', patch: { scrollTop: 10 } })
  expect(pageFor(s, 'artist')).toMatchObject({ search: 'x', scrollTop: 10 })
})

test('toHub and popTo (breadcrumb) keep remembered page state', () => {
  let s = results()
  s = navReducer(s, { type: 'setPage', dimensionId: 'artist', patch: { search: 'aal' } })
  expect(currentLocation(navReducer(s, { type: 'toHub' }))).toEqual({ kind: 'hub' })
  expect(currentLocation(navReducer(s, { type: 'popTo', depth: 1 }))).toEqual({
    kind: 'dimension',
    dimensionId: 'artist'
  })
  expect(pageFor(navReducer(s, { type: 'toHub' }), 'artist').search).toBe('aal')
  // Out-of-range depths clamp rather than corrupt the stack.
  expect(navReducer(s, { type: 'popTo', depth: 99 }).stack).toHaveLength(3)
  expect(navReducer(s, { type: 'popTo', depth: -5 }).stack).toHaveLength(1)
})

test('stacking tags on a results page updates only that page', () => {
  const s = navReducer(results(), { type: 'setResultTags', tagIds: [1, 2] })
  const top = currentLocation(s)
  expect(top.kind === 'results' && top.tagIds).toEqual([1, 2])
  expect(s.stack).toHaveLength(3)
  // Not on a results page: no-op.
  expect(navReducer(INITIAL_NAV, { type: 'setResultTags', tagIds: [1] })).toBe(INITIAL_NAV)
})

test('the breadcrumb trail follows the stack, and clicking a crumb pops to it', () => {
  const label = (id: string): string | undefined => getDimension(id)?.label
  expect(browseCrumbs(INITIAL_NAV, label)).toEqual([{ label: 'Browse all', depth: 0 }])

  const s = results()
  const crumbs = browseCrumbs(s, label)
  expect(crumbs).toEqual([
    { label: 'Browse all', depth: 0 },
    { label: 'Artist', depth: 1 },
    { label: 'Aaliyah', depth: 2 }
  ])
  // Clicking "Artist" returns to the artist page.
  expect(currentLocation(navReducer(s, { type: 'popTo', depth: crumbs[1].depth }))).toEqual({
    kind: 'dimension',
    dimensionId: 'artist'
  })
  // A dimension the registry no longer has still shows something.
  expect(browseCrumbs(s, () => undefined)[1].label).toBe('Browse')
})
