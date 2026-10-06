import { test, expect } from '@playwright/test'
import {
  ALL_MUSIC_TAB_ID,
  BUILTIN_TABS,
  TAGGED_TAB_ID,
  UNTAGGED_TAB_ID,
  MAX_CUSTOM_TABS,
  MAX_FILTER_DEPTH,
  buildTabs,
  customTabId,
  filterTracksForTab,
  hasAnyTags,
  isTrackFilter,
  matchesFilter,
  parseCustomTab,
  parseCustomTabs,
  serializeCustomTabs,
  sortTracks,
  statusTabId,
  tabCounts,
  type TabDefinition,
  type TagIndex,
  type TrackFilter
} from '../../src/renderer/src/lib/tabs'

// Covers the tab definitions: which tabs exist for a given set of board
// columns, and what each one's declarative filter actually selects. The
// interesting cases are the collisions — the seeded board columns are named
// Untagged and Tagged, which is also what two of the built-in tabs are
// called, and the two meanings are not the same thing.

// ── Fixtures ──────────────────────────────────────────────────────────────

function board(id: number, name: string, position: number, color = '#888888'): Board {
  return { id, name, color, position, created_at: 0 }
}

function tag(id: number, field = 'comment', value = 'FTW'): Tag {
  return { id, field, value, color: '#7f77dd', created_at: 0 }
}

// Only id and board_id are read by any filter; the rest of a Track row is
// irrelevant here, so the cast keeps the fixtures to what matters.
function track(id: number, boardId: number, extra: Partial<Track> = {}): Track {
  return { id, board_id: boardId, ...extra } as Track
}

const SEEDED_BOARDS = [
  board(1, 'Untagged', 0, '#888780'),
  board(2, 'Tagged', 1, '#378ADD'),
  board(3, 'Crate ready', 2, '#1D9E75'),
  board(4, 'Gig ready', 3, '#7F77DD')
]

const NO_TAGS: TagIndex = new Map()

// ── Tab construction ──────────────────────────────────────────────────────

test('the three built-in tabs come first, in order', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  expect(tabs.slice(0, 3).map((t) => t.id)).toEqual([
    ALL_MUSIC_TAB_ID,
    UNTAGGED_TAB_ID,
    TAGGED_TAB_ID
  ])
  expect(tabs.slice(0, 3).map((t) => t.label)).toEqual(['All Music', 'Untagged', 'Tagged'])
})

test('a board whose name already names a built-in does not get its own tab', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  // Untagged and Tagged are seeded board columns AND built-in tabs. Only
  // the two remaining columns become status tabs.
  expect(tabs.map((t) => t.label)).toEqual([
    'All Music',
    'Untagged',
    'Tagged',
    'Crate ready',
    'Gig ready'
  ])
  expect(tabs.filter((t) => t.label === 'Untagged')).toHaveLength(1)
})

test('the collision is matched on case and whitespace, not on exact text', () => {
  const tabs = buildTabs([board(1, '  uNtAgGeD  ', 0), board(2, 'Gig ready', 1)])
  expect(tabs.map((t) => t.label)).toEqual(['All Music', 'Untagged', 'Tagged', 'Gig ready'])
})

test('status tabs follow board column order, not the order they arrive in', () => {
  const shuffled = [board(4, 'Gig ready', 3), board(3, 'Crate ready', 2), board(9, 'Promos', 1)]
  const statuses = buildTabs(shuffled).filter((t) => t.kind === 'status')
  expect(statuses.map((t) => t.label)).toEqual(['Promos', 'Crate ready', 'Gig ready'])
})

test('a status tab keys off the board id so it survives a rename', () => {
  const before = buildTabs([board(7, 'Promos', 0)]).find((t) => t.kind === 'status')
  const after = buildTabs([board(7, 'New Promos', 0)]).find((t) => t.kind === 'status')
  expect(before?.id).toBe(statusTabId(7))
  expect(after?.id).toBe(before?.id)
  expect(after?.label).toBe('New Promos')
})

test('a status tab carries its board colour and a built-in does not', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  expect(tabs.find((t) => t.id === statusTabId(4))?.color).toBe('#7F77DD')
  expect(tabs.find((t) => t.id === ALL_MUSIC_TAB_ID)?.color).toBeUndefined()
})

test('with no boards at all there are still the three built-in tabs', () => {
  expect(buildTabs([])).toHaveLength(3)
})

test('every tab definition is JSON-serializable — no functions anywhere', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  expect(JSON.parse(JSON.stringify(tabs))).toEqual(tabs)
})

test('no two tabs share an id', () => {
  const ids = buildTabs(SEEDED_BOARDS).map((t) => t.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// ── Filters ───────────────────────────────────────────────────────────────

test('a track is untagged when it has no rows in track_tags', () => {
  const tags: TagIndex = new Map([[1, [tag(10)]]])
  expect(hasAnyTags(1, tags)).toBe(true)
  expect(hasAnyTags(2, tags)).toBe(false)
})

test('an empty tag array counts as untagged, not as missing data', () => {
  // getTrackTagsForTracks pre-seeds every requested id with [], so an
  // untagged track arrives as a present-but-empty entry rather than a gap.
  const tags: TagIndex = new Map([[1, []]])
  expect(hasAnyTags(1, tags)).toBe(false)
})

test('untagged and tagged partition the library exactly', () => {
  const tracks = [track(1, 1), track(2, 1), track(3, 2)]
  const tags: TagIndex = new Map([
    [1, [tag(10)]],
    [2, []]
  ])
  const untagged = tracks.filter((t) => matchesFilter(t, { type: 'untagged' }, tags))
  const tagged = tracks.filter((t) => matchesFilter(t, { type: 'tagged' }, tags))
  expect(untagged.map((t) => t.id)).toEqual([2, 3])
  expect(tagged.map((t) => t.id)).toEqual([1])
  expect(untagged.length + tagged.length).toBe(tracks.length)
})

test('a tag of any field counts — untagged is about rows, not about which field', () => {
  const tags: TagIndex = new Map([[1, [tag(10, 'genre', 'Afro House')]]])
  expect(matchesFilter(track(1, 1), { type: 'untagged' }, tags)).toBe(false)
})

test('a status filter selects on board_id alone', () => {
  const tracks = [track(1, 3), track(2, 4), track(3, 3)]
  const matched = tracks.filter((t) => matchesFilter(t, { type: 'status', boardId: 3 }, NO_TAGS))
  expect(matched.map((t) => t.id)).toEqual([1, 3])
})

test('the built-in Untagged is not the same set as the Untagged board', () => {
  // A fully tagged track dragged onto the Untagged column: a status filter
  // would claim it, the tag-based built-in correctly does not.
  const dragged = track(1, 1)
  const tags: TagIndex = new Map([[1, [tag(10)]]])
  expect(matchesFilter(dragged, { type: 'status', boardId: 1 }, tags)).toBe(true)
  expect(matchesFilter(dragged, { type: 'untagged' }, tags)).toBe(false)
})

test('All Music matches everything, including a track with no tags', () => {
  expect(matchesFilter(track(1, 1), { type: 'all' }, NO_TAGS)).toBe(true)
})

// ── Sorting ───────────────────────────────────────────────────────────────

test('the default sort is newest first, matching what getAllTracks returns', () => {
  for (const tab of BUILTIN_TABS) {
    expect(tab.sort).toEqual({ field: 'added_at', direction: 'desc' })
  }
})

test('nulls sort last in both directions', () => {
  const tracks = [track(1, 1, { bpm: 128 }), track(2, 1, { bpm: null }), track(3, 1, { bpm: 90 })]
  expect(sortTracks(tracks, { field: 'bpm', direction: 'asc' }).map((t) => t.id)).toEqual([3, 1, 2])
  expect(sortTracks(tracks, { field: 'bpm', direction: 'desc' }).map((t) => t.id)).toEqual([
    1, 3, 2
  ])
})

test('a track with no title sorts by the filename the row actually shows', () => {
  const tracks = [
    track(1, 1, { title: null, filename: 'aaa.mp3' }),
    track(2, 1, { title: 'zzz', filename: 'zzz.mp3' })
  ]
  expect(sortTracks(tracks, { field: 'title', direction: 'asc' }).map((t) => t.id)).toEqual([1, 2])
})

test('sorting does not mutate the array it was given', () => {
  const tracks = [track(2, 1, { bpm: 90 }), track(1, 1, { bpm: 128 })]
  sortTracks(tracks, { field: 'bpm', direction: 'asc' })
  expect(tracks.map((t) => t.id)).toEqual([2, 1])
})

// ── Filter + sort together ────────────────────────────────────────────────

test('a tab yields its filtered result in its own sort order', () => {
  const tab: TabDefinition = {
    id: 'x',
    label: 'X',
    kind: 'builtin',
    filter: { type: 'untagged' },
    sort: { field: 'bpm', direction: 'asc' },
    defaultViewMode: 'list'
  }
  const tracks = [track(1, 1, { bpm: 130 }), track(2, 1, { bpm: 100 }), track(3, 1, { bpm: 120 })]
  const tags: TagIndex = new Map([[3, [tag(10)]]])
  expect(filterTracksForTab(tracks, tab, tags).map((t) => t.id)).toEqual([2, 1])
})

// ── Counts ────────────────────────────────────────────────────────────────

test('counts are reported per tab, and a track can be counted by several', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  const tracks = [track(1, 3), track(2, 3), track(3, 4)]
  const tags: TagIndex = new Map([[1, [tag(10)]]])

  const counts = tabCounts(tabs, tracks, tags)
  expect(counts[ALL_MUSIC_TAB_ID]).toBe(3)
  expect(counts[TAGGED_TAB_ID]).toBe(1)
  expect(counts[UNTAGGED_TAB_ID]).toBe(2)
  expect(counts[statusTabId(3)]).toBe(2)
  expect(counts[statusTabId(4)]).toBe(1)
})

test('a tab with nothing in it still reports a count of zero', () => {
  const tabs = buildTabs(SEEDED_BOARDS)
  const counts = tabCounts(tabs, [], NO_TAGS)
  for (const tab of tabs) expect(counts[tab.id]).toBe(0)
})

// ── Composite filters ─────────────────────────────────────────────────────
// The shape a rule engine builds rules out of. Nothing in the app produces
// one yet — they arrive through custom tabs.

test('all_of matches only tracks that satisfy every clause', () => {
  const tracks = [track(1, 3), track(2, 3), track(3, 4)]
  const tags: TagIndex = new Map([[1, [tag(10)]]])
  // Crate ready AND tagged.
  const filter: TrackFilter = {
    type: 'all_of',
    filters: [{ type: 'status', boardId: 3 }, { type: 'tagged' }]
  }
  expect(tracks.filter((t) => matchesFilter(t, filter, tags)).map((t) => t.id)).toEqual([1])
})

test('any_of matches a track that satisfies at least one clause', () => {
  const tracks = [track(1, 3), track(2, 4), track(3, 9)]
  const filter: TrackFilter = {
    type: 'any_of',
    filters: [
      { type: 'status', boardId: 3 },
      { type: 'status', boardId: 4 }
    ]
  }
  expect(tracks.filter((t) => matchesFilter(t, filter, NO_TAGS)).map((t) => t.id)).toEqual([1, 2])
})

test('not inverts its inner filter', () => {
  const tracks = [track(1, 3), track(2, 4)]
  const filter: TrackFilter = { type: 'not', filter: { type: 'status', boardId: 3 } }
  expect(tracks.filter((t) => matchesFilter(t, filter, NO_TAGS)).map((t) => t.id)).toEqual([2])
})

test('composites nest — untagged AND NOT (crate ready OR gig ready)', () => {
  const filter: TrackFilter = {
    type: 'all_of',
    filters: [
      { type: 'untagged' },
      {
        type: 'not',
        filter: {
          type: 'any_of',
          filters: [
            { type: 'status', boardId: 3 },
            { type: 'status', boardId: 4 }
          ]
        }
      }
    ]
  }
  const tracks = [track(1, 1), track(2, 3), track(3, 4), track(4, 1)]
  const tags: TagIndex = new Map([[4, [tag(10)]]])
  // 1 is untagged and on neither board; 2 and 3 are excluded by board; 4 is tagged.
  expect(tracks.filter((t) => matchesFilter(t, filter, tags)).map((t) => t.id)).toEqual([1])
})

test('the empty composites are the identities, not special cases', () => {
  // An all_of with nothing to fail matches; an any_of with nothing to match
  // does not. This is what lets a half-built rule narrow as clauses are
  // added instead of matching nothing until it is complete.
  expect(matchesFilter(track(1, 1), { type: 'all_of', filters: [] }, NO_TAGS)).toBe(true)
  expect(matchesFilter(track(1, 1), { type: 'any_of', filters: [] }, NO_TAGS)).toBe(false)
})

test('double negation is the original filter', () => {
  const inner: TrackFilter = { type: 'status', boardId: 3 }
  const doubled: TrackFilter = { type: 'not', filter: { type: 'not', filter: inner } }
  for (const t of [track(1, 3), track(2, 4)]) {
    expect(matchesFilter(t, doubled, NO_TAGS)).toBe(matchesFilter(t, inner, NO_TAGS))
  }
})

test('a composite tab still sorts and filters through the normal path', () => {
  const tab: TabDefinition = {
    id: 'x',
    label: 'X',
    kind: 'custom',
    filter: { type: 'any_of', filters: [{ type: 'status', boardId: 3 }, { type: 'tagged' }] },
    sort: { field: 'bpm', direction: 'asc' },
    defaultViewMode: 'grid'
  }
  const tracks = [track(1, 3, { bpm: 130 }), track(2, 9, { bpm: 100 }), track(3, 9, { bpm: 120 })]
  const tags: TagIndex = new Map([[2, [tag(10)]]])
  expect(filterTracksForTab(tracks, tab, tags).map((t) => t.id)).toEqual([2, 1])
})

// ── Filter validation ─────────────────────────────────────────────────────

test('valid leaf and composite filters are recognised', () => {
  expect(isTrackFilter({ type: 'all' })).toBe(true)
  expect(isTrackFilter({ type: 'status', boardId: 3 })).toBe(true)
  expect(isTrackFilter({ type: 'not', filter: { type: 'tagged' } })).toBe(true)
  expect(isTrackFilter({ type: 'all_of', filters: [{ type: 'untagged' }] })).toBe(true)
  expect(isTrackFilter({ type: 'any_of', filters: [] })).toBe(true)
})

test('junk is rejected rather than trusted', () => {
  for (const bad of [
    null,
    undefined,
    'all',
    42,
    [],
    {},
    { type: 'nonsense' },
    { type: 'status' },
    { type: 'status', boardId: '3' },
    { type: 'status', boardId: 1.5 },
    { type: 'all_of' },
    { type: 'all_of', filters: {} },
    { type: 'all_of', filters: [{ type: 'nope' }] },
    { type: 'not' },
    { type: 'not', filter: 'tagged' }
  ]) {
    expect(isTrackFilter(bad)).toBe(false)
  }
})

test('nesting deeper than the cap is refused instead of overflowing the stack', () => {
  let deep: TrackFilter = { type: 'all' }
  for (let i = 0; i < MAX_FILTER_DEPTH + 2; i++) deep = { type: 'not', filter: deep }
  expect(isTrackFilter(deep)).toBe(false)

  let shallow: TrackFilter = { type: 'all' }
  for (let i = 0; i < MAX_FILTER_DEPTH - 1; i++) shallow = { type: 'not', filter: shallow }
  expect(isTrackFilter(shallow)).toBe(true)
})

// ── Custom tabs ───────────────────────────────────────────────────────────

const CUSTOM = {
  id: 'late-night',
  label: 'Late Night',
  filter: { type: 'all_of', filters: [{ type: 'tagged' }, { type: 'status', boardId: 4 }] },
  sort: { field: 'bpm', direction: 'asc' },
  defaultViewMode: 'grid',
  color: '#d4537e'
}

test('a stored custom tab parses into a usable definition', () => {
  const tab = parseCustomTab(CUSTOM)
  expect(tab).not.toBeNull()
  expect(tab?.id).toBe('custom:late-night')
  expect(tab?.kind).toBe('custom')
  expect(tab?.label).toBe('Late Night')
  expect(tab?.defaultViewMode).toBe('grid')
  expect(tab?.color).toBe('#d4537e')
})

test('the id is namespaced so a custom tab can never collide with a built-in', () => {
  // Even a custom tab that calls itself "all" gets its own id, and so its
  // own view_mode:tab:<id> setting.
  expect(parseCustomTab({ ...CUSTOM, id: 'all' })?.id).toBe('custom:all')
  expect(customTabId('x')).toBe('custom:x')
  // Already-prefixed ids are left alone rather than doubled up.
  expect(customTabId('custom:x')).toBe('custom:x')
})

test('sort and view mode fall back to the defaults when absent or junk', () => {
  const tab = parseCustomTab({ id: 'a', label: 'A', filter: { type: 'all' } })
  expect(tab?.sort).toEqual({ field: 'added_at', direction: 'desc' })
  expect(tab?.defaultViewMode).toBe('list')

  const junk = parseCustomTab({
    id: 'b',
    label: 'B',
    filter: { type: 'all' },
    sort: { field: 'nope', direction: 'sideways' },
    defaultViewMode: 'carousel'
  })
  expect(junk?.sort).toEqual({ field: 'added_at', direction: 'desc' })
  expect(junk?.defaultViewMode).toBe('list')
})

test('what cannot be invented is refused — no id, no label, no readable rule', () => {
  expect(parseCustomTab({ label: 'A', filter: { type: 'all' } })).toBeNull()
  expect(parseCustomTab({ id: '  ', label: 'A', filter: { type: 'all' } })).toBeNull()
  expect(parseCustomTab({ id: 'custom:', label: 'A', filter: { type: 'all' } })).toBeNull()
  expect(parseCustomTab({ id: 'a', label: '   ', filter: { type: 'all' } })).toBeNull()
  // An unreadable rule must NOT degrade into "matches everything".
  expect(parseCustomTab({ id: 'a', label: 'A', filter: { type: 'nope' } })).toBeNull()
  expect(parseCustomTab({ id: 'a', label: 'A' })).toBeNull()
})

test('one malformed entry is dropped without taking the rest down', () => {
  const raw = JSON.stringify([CUSTOM, { id: 'broken' }, { ...CUSTOM, id: 'second' }])
  expect(parseCustomTabs(raw).map((t) => t.id)).toEqual(['custom:late-night', 'custom:second'])
})

test('a duplicate id keeps the first definition only', () => {
  const raw = JSON.stringify([CUSTOM, { ...CUSTOM, label: 'Impostor' }])
  const tabs = parseCustomTabs(raw)
  expect(tabs).toHaveLength(1)
  expect(tabs[0].label).toBe('Late Night')
})

test('unreadable storage means no custom tabs, never a crash', () => {
  for (const raw of [null, undefined, '', '   ', 'not json', '{}', '"a string"', '42']) {
    expect(parseCustomTabs(raw)).toEqual([])
  }
})

test('more custom tabs than the cap are truncated', () => {
  const many = Array.from({ length: MAX_CUSTOM_TABS + 10 }, (_, i) => ({ ...CUSTOM, id: `t${i}` }))
  expect(parseCustomTabs(JSON.stringify(many))).toHaveLength(MAX_CUSTOM_TABS)
})

test('custom tabs round-trip through serialize and parse unchanged', () => {
  const tabs = parseCustomTabs(JSON.stringify([CUSTOM]))
  expect(parseCustomTabs(serializeCustomTabs(tabs))).toEqual(tabs)
})

test('serializing skips anything that is not a custom tab', () => {
  const mixed = [...buildTabs(SEEDED_BOARDS), ...parseCustomTabs(JSON.stringify([CUSTOM]))]
  const written = JSON.parse(serializeCustomTabs(mixed))
  expect(written).toHaveLength(1)
  expect(written[0].id).toBe('custom:late-night')
})

// ── Custom tabs in the tab strip ──────────────────────────────────────────

test('custom tabs come after the built-ins and the status tabs', () => {
  const custom = parseCustomTabs(JSON.stringify([CUSTOM]))
  expect(buildTabs(SEEDED_BOARDS, custom).map((t) => t.label)).toEqual([
    'All Music',
    'Untagged',
    'Tagged',
    'Crate ready',
    'Gig ready',
    'Late Night'
  ])
})

test('with no custom tabs stored the strip is exactly what it was before', () => {
  expect(buildTabs(SEEDED_BOARDS, [])).toEqual(buildTabs(SEEDED_BOARDS))
})

test('a custom tab may reuse a built-in label — it is a different tab', () => {
  // Unlike a status tab, this one was named on purpose. Only ids must be
  // unique, and the custom: prefix guarantees that.
  const custom = parseCustomTabs(JSON.stringify([{ ...CUSTOM, id: 'mine', label: 'Untagged' }]))
  const tabs = buildTabs(SEEDED_BOARDS, custom)
  expect(tabs.filter((t) => t.label === 'Untagged')).toHaveLength(2)
  const ids = tabs.map((t) => t.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('a custom tab is counted alongside the rest', () => {
  const custom = parseCustomTabs(
    JSON.stringify([{ id: 'gig-tagged', label: 'Gig + Tagged', filter: CUSTOM.filter }])
  )
  const tabs = buildTabs(SEEDED_BOARDS, custom)
  const tracks = [track(1, 4), track(2, 4), track(3, 3)]
  const tags: TagIndex = new Map([[1, [tag(10)]]])
  const counts = tabCounts(tabs, tracks, tags)
  // Only track 1 is both tagged and on the Gig ready board.
  expect(counts['custom:gig-tagged']).toBe(1)
  expect(counts[statusTabId(4)]).toBe(2)
})

test('buildTabs refuses a custom tab that would shadow an existing id', () => {
  const clash: TabDefinition = {
    id: statusTabId(4),
    label: 'Clash',
    kind: 'custom',
    filter: { type: 'all' },
    sort: { field: 'added_at', direction: 'desc' },
    defaultViewMode: 'list'
  }
  // Namespaced to custom:status:4 rather than colliding, so both survive.
  const tabs = buildTabs(SEEDED_BOARDS, [clash])
  expect(tabs.filter((t) => t.id === statusTabId(4))).toHaveLength(1)
  expect(tabs.find((t) => t.label === 'Clash')?.id).toBe('custom:status:4')
})

test('every tab is still JSON-serializable once custom tabs are in the mix', () => {
  const tabs = buildTabs(SEEDED_BOARDS, parseCustomTabs(JSON.stringify([CUSTOM])))
  expect(JSON.parse(JSON.stringify(tabs))).toEqual(tabs)
})
