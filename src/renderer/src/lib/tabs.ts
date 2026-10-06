// ── Saved views ("tabs") over the track list ──────────────────────────────
// A tab is a filter + a sort + a default list/grid mode, and nothing else.
// Everything here is a plain serializable object: no functions, no closures,
// no React. That is deliberate — the same definition has to survive being
// written to app_settings, sent over IPC, or compiled into a SQL WHERE
// clause the day the library stops fitting in memory. See matchesFilter for
// the in-memory interpreter, which is the only thing that knows how to
// *run* one of these.
//
// Three kinds of tab:
//   builtin  All Music / Untagged / Tagged — fixed, defined below.
//   status   one per board column, generated from the boards table.
//   custom   DJ-authored, persisted as JSON in app_settings. The model,
//            the validation and the merge are all here and wired up; what
//            is deliberately NOT built is the "+" button and the editor
//            behind it, so nothing in the app creates one yet.
//
// TODO: the "+" affordance and the custom-tab editor. Everything below the
// UI is ready for it: an editor only has to produce a TabDefinition with
// `kind: 'custom'`, hand it to serializeCustomTabs, and write the result to
// CUSTOM_TABS_SETTINGS_KEY via window.api.settings.set. TrackTabBar renders
// no "+" button until that exists.

// Structurally identical to hooks/useViewMode's ViewMode. Redeclared rather
// than imported because this module must stay free of React and of the
// store (which touches localStorage at import time, and so cannot be
// imported by the pure Node unit tests).
export type TabViewMode = 'list' | 'grid'

// ── Filters ───────────────────────────────────────────────────────────────

// Leaf filters — each one asks a single question about a track.
export type TrackLeafFilter =
  | { type: 'all' }
  // "Untagged" means zero rows in track_tags — see hasAnyTags. Confirmed
  // definition: track_tags rows are only ever written by explicit user
  // action (the inspector's TagInput, BulkEditModal, and the confirmed
  // pending_tag_imports flow), so an empty set really does mean "never
  // labelled" rather than "not imported yet".
  | { type: 'untagged' }
  // The exact complement of 'untagged' — together they partition the
  // library, which is what makes them worth having as a pair.
  | { type: 'tagged' }
  // A status is a board: tracks.board_id references boards(id). There is no
  // separate status table.
  | { type: 'status'; boardId: number }

// Composite filters — the shape a rule engine builds its rules out of.
// Boolean algebra and nothing else: all_of is AND, any_of is OR, not is
// negation, and between them any rule over the leaves above is expressible.
// They nest, so "untagged AND NOT (gig ready OR crate ready)" is one value.
//
// Nothing in the app produces one of these yet — built-in and status tabs
// are all leaves. They become reachable through custom tabs, which is the
// seam a rule engine would arrive through. Adding a new *leaf* later (a
// genre match, a BPM window, crate membership) means extending
// TrackLeafFilter and matchesFilter's switch; none of the composite logic,
// the validator or the interpreter's recursion has to change.
export type TrackCompositeFilter =
  | { type: 'all_of'; filters: TrackFilter[] }
  | { type: 'any_of'; filters: TrackFilter[] }
  | { type: 'not'; filter: TrackFilter }

export type TrackFilter = TrackLeafFilter | TrackCompositeFilter

export interface TrackSort {
  field: 'added_at' | 'title' | 'artist' | 'bpm'
  direction: 'asc' | 'desc'
}

export type TabKind = 'builtin' | 'status' | 'custom'

export interface TabDefinition {
  // Stable across renames — a status tab keys off the board id, not its
  // name, so persisted per-tab state survives the DJ renaming a column.
  id: string
  label: string
  kind: TabKind
  filter: TrackFilter
  sort: TrackSort
  // Only the *default*. The live mode is whatever useViewMode has stored
  // for this tab under `view_mode:tab:<id>`; this is the fallback for a tab
  // the DJ has never toggled.
  defaultViewMode: TabViewMode
  // Status tabs carry their board's colour so the tab bar can show the same
  // dot the board column header does. Undefined for built-ins; a custom tab
  // may set one.
  color?: string
}

// Only the presence or absence of tags matters to the filters above, but
// the full Tag is carried so a future value-aware rule engine has it.
export type TagIndex = ReadonlyMap<number, readonly Tag[]>

// The subset of a Track any filter here actually reads. Keeping it narrow
// means the unit tests can build a two-field object instead of a full row.
export type FilterableTrack = Pick<Track, 'id' | 'board_id'>

// ── Built-in tabs ─────────────────────────────────────────────────────────

export const ALL_MUSIC_TAB_ID = 'all'
export const UNTAGGED_TAB_ID = 'untagged'
export const TAGGED_TAB_ID = 'tagged'

// added_at DESC is the order getAllTracks already returns, so the default
// sort is a no-op on the store's array rather than a re-shuffle.
const DEFAULT_SORT: TrackSort = { field: 'added_at', direction: 'desc' }

export const BUILTIN_TABS: readonly TabDefinition[] = [
  {
    id: ALL_MUSIC_TAB_ID,
    label: 'All Music',
    kind: 'builtin',
    filter: { type: 'all' },
    sort: DEFAULT_SORT,
    defaultViewMode: 'list'
  },
  {
    id: UNTAGGED_TAB_ID,
    label: 'Untagged',
    kind: 'builtin',
    filter: { type: 'untagged' },
    sort: DEFAULT_SORT,
    defaultViewMode: 'list'
  },
  {
    id: TAGGED_TAB_ID,
    label: 'Tagged',
    kind: 'builtin',
    filter: { type: 'tagged' },
    sort: DEFAULT_SORT,
    defaultViewMode: 'list'
  }
]

export function statusTabId(boardId: number): string {
  return `status:${boardId}`
}

// ── Custom tabs ───────────────────────────────────────────────────────────
// Persisted as one JSON array under a single app_settings key, through the
// existing settings:get/settings:set IPC — the same mechanism per-tab view
// modes use. No schema change, no migration, no new handler.

export const CUSTOM_TABS_SETTINGS_KEY = 'track_tabs:custom'

export const CUSTOM_TAB_ID_PREFIX = 'custom:'

// Namespaced so a custom tab can never collide with 'all', 'untagged',
// 'tagged' or 'status:<n>' — which matters because the id is also the
// app_settings key its view mode is stored under (view_mode:tab:<id>).
export function customTabId(key: string): string {
  const trimmed = key.trim()
  return trimmed.startsWith(CUSTOM_TAB_ID_PREFIX) ? trimmed : `${CUSTOM_TAB_ID_PREFIX}${trimmed}`
}

// How deep a filter may nest. Guards the recursion in isTrackFilter and
// matchesFilter against a pathological (or hand-written) stored rule; far
// deeper than any rule a person would build.
export const MAX_FILTER_DEPTH = 8

// tabCounts runs every tab's filter over every track on each render, so the
// tab strip's cost is linear in this. A DJ with more than a few dozen saved
// views has a different problem, and the bar would not fit them anyway.
export const MAX_CUSTOM_TABS = 64

const SORT_FIELDS: readonly TrackSort['field'][] = ['added_at', 'title', 'artist', 'bpm']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Everything below validates data read back from app_settings, which is
// outside the type system: hand-edited, written by an older build, or
// truncated. It never throws — a bad value is reported false and dropped by
// the caller, because one malformed tab must not take the tab bar down.
export function isTrackFilter(value: unknown, depth = 0): value is TrackFilter {
  if (depth > MAX_FILTER_DEPTH) return false
  if (!isRecord(value)) return false

  switch (value.type) {
    case 'all':
    case 'untagged':
    case 'tagged':
      return true
    case 'status':
      return typeof value.boardId === 'number' && Number.isInteger(value.boardId)
    case 'all_of':
    case 'any_of':
      return Array.isArray(value.filters) && value.filters.every((f) => isTrackFilter(f, depth + 1))
    case 'not':
      return isTrackFilter(value.filter, depth + 1)
    default:
      return false
  }
}

function isTrackSort(value: unknown): value is TrackSort {
  if (!isRecord(value)) return false
  return (
    SORT_FIELDS.includes(value.field as TrackSort['field']) &&
    (value.direction === 'asc' || value.direction === 'desc')
  )
}

// One stored entry to a TabDefinition, or null if it cannot be trusted.
// Forgiving about what it can default (sort, view mode, colour) and strict
// about what it cannot invent (the id, the label, the filter) — a tab whose
// rule is unreadable must not silently become a tab that matches
// everything.
export function parseCustomTab(value: unknown): TabDefinition | null {
  if (!isRecord(value)) return null

  const rawId = typeof value.id === 'string' ? value.id.trim() : ''
  // A bare prefix is not an id.
  if (rawId === '' || rawId === CUSTOM_TAB_ID_PREFIX) return null

  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (label === '') return null

  if (!isTrackFilter(value.filter)) return null

  return {
    id: customTabId(rawId),
    label,
    kind: 'custom',
    filter: value.filter,
    sort: isTrackSort(value.sort) ? value.sort : DEFAULT_SORT,
    defaultViewMode: value.defaultViewMode === 'grid' ? 'grid' : 'list',
    ...(typeof value.color === 'string' && value.color.trim() !== ''
      ? { color: value.color.trim() }
      : {})
  }
}

// Reads what window.api.settings.get returns. Absent, empty, unparseable or
// not-an-array all mean "no custom tabs" rather than an error: this runs on
// the way to painting the library, and there is nothing useful to do with a
// failure except carry on without them.
export function parseCustomTabs(raw: string | null | undefined): TabDefinition[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const tabs: TabDefinition[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (tabs.length >= MAX_CUSTOM_TABS) break
    const tab = parseCustomTab(entry)
    // First definition of an id wins; a duplicate would otherwise give two
    // tabs one shared view-mode setting.
    if (!tab || seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
  }
  return tabs
}

// The symmetric write, for whatever eventually edits these. Round-trips
// through parseCustomTabs unchanged.
export function serializeCustomTabs(tabs: readonly TabDefinition[]): string {
  return JSON.stringify(tabs.filter((t) => t.kind === 'custom'))
}

// Compared case- and whitespace-insensitively so a board renamed to
// "untagged " still reads as the same concept as the built-in.
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase()
}

// One tab per board, in board-column order, minus any board whose name
// already names a built-in. The seeded columns are Untagged / Tagged /
// Crate ready / Gig ready, so out of the box the first two collapse into
// the built-in tabs and only the last two become status tabs — a single
// row with no repeated labels.
//
// Note the two meanings genuinely differ: the built-in Untagged is a fact
// about track_tags, the board is a place a track can be dragged to. Where
// they collide the tag-based reading wins, because that is the one a DJ
// cannot get wrong by dragging.
//
// Custom tabs go last, in the order they were stored. They are NOT subject
// to the built-in name collision rule the way status tabs are: a status tab
// is generated behind the DJ's back and a duplicate would be a bug, whereas
// a custom tab named "Untagged" was typed on purpose and is a different tab
// with a different id. Only the ids have to be unique, and they are — the
// custom: prefix guarantees it.
export function buildTabs(
  boards: readonly Board[],
  customTabs: readonly TabDefinition[] = []
): TabDefinition[] {
  const taken = new Set(BUILTIN_TABS.map((t) => normalizeLabel(t.label)))

  // Sorted defensively: getAllBoards is already ORDER BY position ASC, so
  // this is a no-op on real data and a guarantee for any other caller.
  const statusTabs = [...boards]
    .sort((a, b) => a.position - b.position)
    .filter((board) => !taken.has(normalizeLabel(board.name)))
    .map<TabDefinition>((board) => ({
      id: statusTabId(board.id),
      label: board.name,
      kind: 'status',
      filter: { type: 'status', boardId: board.id },
      sort: DEFAULT_SORT,
      // Grid by default, matching how the board columns these replace
      // used to default.
      defaultViewMode: 'grid',
      color: board.color
    }))

  // Defence in depth: parseCustomTabs already namespaces and de-dupes, but
  // buildTabs is also reachable with hand-built definitions (the tests do
  // exactly that), and a duplicate id would give two tabs one shared view
  // mode and make the active-tab lookup ambiguous.
  const used = new Set([...BUILTIN_TABS, ...statusTabs].map((t) => t.id))
  const custom: TabDefinition[] = []
  for (const tab of customTabs) {
    const id = customTabId(tab.id)
    if (used.has(id)) continue
    used.add(id)
    custom.push({ ...tab, id, kind: 'custom' })
  }

  return [...BUILTIN_TABS, ...statusTabs, ...custom]
}

// ── Running a filter ──────────────────────────────────────────────────────

export function hasAnyTags(trackId: number, trackTags: TagIndex): boolean {
  return (trackTags.get(trackId)?.length ?? 0) > 0
}

export function matchesFilter(
  track: FilterableTrack,
  filter: TrackFilter,
  trackTags: TagIndex
): boolean {
  switch (filter.type) {
    case 'all':
      return true
    case 'untagged':
      return !hasAnyTags(track.id, trackTags)
    case 'tagged':
      return hasAnyTags(track.id, trackTags)
    case 'status':
      return track.board_id === filter.boardId

    // Both short-circuit, so a cheap leaf placed first in the array keeps
    // an expensive one from running at all.
    //
    // The empty cases are the identities, not special cases: an empty
    // all_of is true (nothing failed) and an empty any_of is false
    // (nothing matched). That is what makes an incrementally built rule
    // behave — a half-written all_of matches everything and narrows as
    // clauses are added, rather than matching nothing until it is finished.
    case 'all_of':
      return filter.filters.every((f) => matchesFilter(track, f, trackTags))
    case 'any_of':
      return filter.filters.some((f) => matchesFilter(track, f, trackTags))
    case 'not':
      return !matchesFilter(track, filter.filter, trackTags)

    default: {
      // Exhaustive over TrackFilter, so adding a variant without handling
      // it here is a compile error. At runtime this is only reachable from
      // a filter that got past isTrackFilter — hand-edited settings JSON
      // written by a newer version of the app — and matching nothing is
      // the safe reading of a rule this build cannot understand.
      const unhandled: never = filter
      void unhandled
      return false
    }
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────

// Nulls always sort last, in both directions — an unanalysed track with no
// bpm belongs at the bottom of a bpm sort, not at the top of the descending
// one.
function compareValues(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0
  if (a === null || a === '') return 1
  if (b === null || b === '') return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function sortValue(track: Track, field: TrackSort['field']): string | number | null {
  switch (field) {
    case 'added_at':
      return track.added_at ?? null
    case 'title':
      // Falling back to the filename matches what every card and row
      // actually displays when the title column is empty.
      return track.title ?? track.filename ?? null
    case 'artist':
      return track.artist ?? null
    case 'bpm':
      return track.bpm ?? null
  }
}

export function sortTracks(tracks: readonly Track[], sort: TrackSort): Track[] {
  const nullsLast = (a: Track, b: Track): number =>
    compareValues(sortValue(a, sort.field), sortValue(b, sort.field))

  return [...tracks].sort((a, b) => {
    const cmp = nullsLast(a, b)
    if (cmp === 0) return 0
    // A null has already been pushed to the bottom by compareValues;
    // reversing for `desc` must not drag it back to the top.
    const aNull = sortValue(a, sort.field) === null
    const bNull = sortValue(b, sort.field) === null
    if (aNull || bNull) return cmp
    return sort.direction === 'desc' ? -cmp : cmp
  })
}

// The one call a view needs: filter, then sort. Both modes render exactly
// this array, in exactly this order, which is what lets a shift-click range
// mean the same thing in a list and in a grid.
export function filterTracksForTab(
  tracks: readonly Track[],
  tab: TabDefinition,
  trackTags: TagIndex
): Track[] {
  const filtered = tracks.filter((t) => matchesFilter(t, tab.filter, trackTags))
  return sortTracks(filtered, tab.sort)
}

// ── Counts ────────────────────────────────────────────────────────────────

// Cheap enough to show: the whole library is already in the store (App.tsx
// loads allTracks() at boot) and trackTags is hydrated for every track in
// one bulk call, so this is a single in-memory pass with no IPC and no
// query. Callers pass the already search/BPM-filtered array, so the counts
// describe what clicking the tab would actually show.
export function tabCounts(
  tabs: readonly TabDefinition[],
  tracks: readonly FilterableTrack[],
  trackTags: TagIndex
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const tab of tabs) counts[tab.id] = 0
  for (const track of tracks) {
    for (const tab of tabs) {
      if (matchesFilter(track, tab.filter, trackTags)) counts[tab.id]++
    }
  }
  return counts
}
