// ── Browse dimensions ─────────────────────────────────────────────────────
// A "dimension" is one way of slicing the library — by genre, by tag, by
// artist. Each is a plain object: what it is called, and two pure functions,
// one that lists its values with track counts and one that returns the tracks
// for a single value. Both are computed from the same predicate, so a value's
// count can never disagree with the list it opens.
//
// Pure and React-free on purpose, like lib/tabs.ts: the data already lives in
// the renderer store (tracks + trackTags), so a dimension is a function over
// that snapshot. Nothing here touches the store, IPC or the database, which
// is also what makes it unit-testable and what keeps the views live — a store
// change is a new snapshot.
//
// Adding a dimension (label, album, year...) is one file that exports a
// BrowseDimension plus one line in registry.ts.

export interface BrowseContext {
  tracks: readonly Track[]
  trackTags: ReadonlyMap<number, Tag[]>
}

export type BrowseIcon = 'music' | 'tag' | 'user'

// How a dimension's page lays out its values: coloured cards (like the
// dashboard's Browse by genre) or a plain list with a jump bar.
export type BrowsePresentation = 'cards' | 'list'

export interface BrowseValue {
  // Stable within a dimension; what tracksFor() is called with.
  key: string
  label: string
  // Tracks carrying this value. A track can carry several (several tags, or
  // several artists), so counts across a dimension do not sum to the library.
  count: number
  // A bucket is "everything without a value" — Untagged, No artist, No genre.
  // Buckets are pinned last and never filtered out by a field chip, so no
  // track is ever unreachable from a dimension.
  kind: 'value' | 'bucket'
  // Present when the value is a real tag, so the page can open it in the
  // existing tag view (which already stacks tags with AND).
  tag?: Tag
  // Sub-grouping for the field filter (a tag's field).
  group?: string
}

export interface BrowseDimension {
  id: string
  label: string
  icon: BrowseIcon
  description: string
  // Plural, lower-case: "genres", "artists". Used in counts and empty states.
  noun: string
  // Shown when the library has tracks but this dimension has no values.
  emptyMessage: string
  presentation: BrowsePresentation
  values: (ctx: BrowseContext) => BrowseValue[]
  tracksFor: (ctx: BrowseContext, key: string) => Track[]
}

export type BrowseSort = 'name' | 'count'
