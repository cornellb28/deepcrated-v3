// ── Artist-name cleanup: the engine ───────────────────────────────────────
// Pure: no database, no electron, no network. Given ONE artist name (already
// split — see cleanArtistString) and what the library already knows, it says
// what the name should be, how sure it is, and why. Deciding what to DO with
// that answer (apply, suggest, ask) is the service's job (service.ts).
//
// Matching, strongest first:
//   0. a "keep" rule: the DJ previously said this exact string stays as is
//   1. an existing artist TAG, identical after normalization      -> high
//   2. a library spelling, identical after normalization          -> medium
//   3. a fuzzy match against existing tags (small edit distance)  -> medium
//   4. a fuzzy match against library spellings                    -> low
//   5. nothing close: unchanged                                   -> low
//
// A keep rule is checked first on purpose. It is a decision the DJ made on
// purpose, so it outranks any inference — otherwise "keep" would stop working
// the moment a tag matched the same string.
//
// "Library spellings" are the spellings artists already have in tracks.artist.
// They are weaker evidence than a tag (nobody blessed them), so a match on one
// is never high, and the most common spelling in a group wins.
//
// This NEVER splits on commas, ampersands, "feat.", "x" or a bare slash:
// "Tyler, The Creator" and "Pete Rock & C.L. Smooth" are one artist each. The
// only split is the library's own " / " delimiter, done before this runs.

import { joinValues, splitValue } from '../tagFields'

export type Confidence = 'high' | 'medium' | 'low'

export type CleanReason =
  | 'empty'
  | 'kept'
  | 'exact-tag'
  | 'normalized-tag'
  | 'normalized-library'
  | 'fuzzy-tag'
  | 'fuzzy-library'
  | 'no-match'

export interface CleanResult {
  // What the name should be. Equal to `raw` (trimmed) when nothing changes.
  canonical: string
  confidence: Confidence
  reason: CleanReason
  // The name exactly as it came in, kept so "keep original" is always possible.
  raw: string
}

export interface ArtistTagEntry {
  value: string
  trackCount: number
}

export interface LibrarySpelling {
  raw: string
  count: number
}

export interface CleanContext {
  tags: readonly ArtistTagEntry[]
  library: readonly LibrarySpelling[]
  // Exact raw strings the DJ chose to keep.
  keepRules: ReadonlySet<string>
}

// ── normalization ─────────────────────────────────────────────────────────

// Lowercase; periods and apostrophes vanish ("B.I.G." -> "big", "Don't" ->
// "dont"); any other punctuation becomes a space ("Jay-Z" -> "jay z");
// whitespace collapses; a leading "the" is dropped. Letters keep their
// accents on purpose: "Beyoncé" and "Beyonce" are a fuzzy match, not an
// identical one, because folding accents silently is exactly the kind of
// confident mistake this engine avoids.
export function normalizeArtistKey(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the (?=\S)/, '')
}

// Damerau-Levenshtein (insert, delete, substitute, swap adjacent).
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const al = a.length
  const bl = b.length
  if (al === 0) return bl
  if (bl === 0) return al
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0))
  for (let i = 0; i <= al; i++) d[i][0] = i
  for (let j = 0; j <= bl; j++) d[0][j] = j
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[al][bl]
}

// How many edits two keys may differ by and still count as "close". Scales
// with length so short names — where one letter is a different artist
// ("Case"/"Cash", "Sade"/"Sage") — never fuzzy-match at all.
export function maxFuzzyDistance(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length)
  if (shorter < 5) return 0
  return shorter <= 8 ? 1 : 2
}

const digitsOf = (s: string): string => s.replace(/\D/g, '')

// Two keys are fuzzy-comparable only if their digits agree: "Blink 182" and
// "Blink 183" are one edit apart and not at all the same band.
function fuzzyClose(a: string, b: string): number | null {
  if (a === b) return null
  const max = maxFuzzyDistance(a, b)
  if (max === 0) return null
  if (digitsOf(a) !== digitsOf(b)) return null
  const dist = editDistance(a, b)
  return dist >= 1 && dist <= max ? dist : null
}

// ── the index ─────────────────────────────────────────────────────────────

interface TagGroup {
  key: string
  // Most-used spelling first, then alphabetical, so the choice is stable.
  best: ArtistTagEntry
}

interface LibraryGroup {
  key: string
  best: string
  bestCount: number
  spellings: number
  // Tracks across every spelling in the group.
  total: number
}

export interface ArtistIndex {
  clean(incoming: string): CleanResult
  // A tag created while a batch is being processed must be visible to the
  // rest of that batch.
  addTag(value: string): void
}

export function createArtistIndex(ctx: CleanContext): ArtistIndex {
  const tagGroups = new Map<string, TagGroup>()
  const exactTags = new Set<string>()

  function addTagEntry(entry: ArtistTagEntry): void {
    exactTags.add(entry.value)
    const key = normalizeArtistKey(entry.value)
    if (key === '') return
    const current = tagGroups.get(key)
    if (
      !current ||
      entry.trackCount > current.best.trackCount ||
      (entry.trackCount === current.best.trackCount && entry.value < current.best.value)
    ) {
      tagGroups.set(key, { key, best: entry })
    }
  }
  for (const t of ctx.tags) addTagEntry(t)

  const libraryGroups = new Map<string, LibraryGroup>()
  // How many tracks use each exact spelling.
  const spellingCounts = new Map<string, number>()
  {
    const byKey = new Map<string, Map<string, number>>()
    for (const s of ctx.library) {
      const key = normalizeArtistKey(s.raw)
      if (key === '') continue
      const spellings = byKey.get(key) ?? new Map<string, number>()
      spellings.set(s.raw, (spellings.get(s.raw) ?? 0) + s.count)
      spellingCounts.set(s.raw, (spellingCounts.get(s.raw) ?? 0) + s.count)
      byKey.set(key, spellings)
    }
    for (const [key, spellings] of byKey) {
      const ranked = [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      libraryGroups.set(key, {
        key,
        best: ranked[0][0],
        bestCount: ranked[0][1],
        spellings: spellings.size,
        total: ranked.reduce((n, [, c]) => n + c, 0)
      })
    }
  }

  // The unique closest key within range, or null when none is — or when two
  // candidates are equally close, because then there is no honest answer.
  function closest<T extends { key: string }>(key: string, groups: Iterable<T>): T | null {
    let best: T | null = null
    let bestDist = Infinity
    let tie = false
    for (const g of groups) {
      const dist = fuzzyClose(key, g.key)
      if (dist === null) continue
      if (dist < bestDist) {
        best = g
        bestDist = dist
        tie = false
      } else if (dist === bestDist) {
        tie = true
      }
    }
    return tie ? null : best
  }

  return {
    addTag(value: string): void {
      addTagEntry({ value, trackCount: 1 })
    },

    clean(incoming: string): CleanResult {
      const raw = incoming
      const trimmed = incoming.trim()
      const done = (
        canonical: string,
        confidence: Confidence,
        reason: CleanReason
      ): CleanResult => ({ canonical, confidence, reason, raw })

      if (trimmed === '') return done('', 'low', 'empty')

      // 0. The DJ already decided this exact string.
      if (ctx.keepRules.has(raw) || ctx.keepRules.has(trimmed)) {
        return done(trimmed, 'high', 'kept')
      }

      // 1. An existing tag: identical, then identical after normalization.
      if (exactTags.has(trimmed)) return done(trimmed, 'high', 'exact-tag')
      const key = normalizeArtistKey(trimmed)
      if (key === '') return done(trimmed, 'low', 'no-match')
      const tag = tagGroups.get(key)
      if (tag) return done(tag.best.value, 'high', 'normalized-tag')

      // 2. A spelling already used in the library — only when it is clearly
      //    the majority one. A tie, or a name that is already the most common
      //    spelling, is not a reason to change anything: with no majority there
      //    is nothing to standardize on. Never high: nobody blessed it.
      const ownCount = spellingCounts.get(trimmed) ?? 0
      const lib = libraryGroups.get(key)
      if (lib && lib.best !== trimmed && lib.bestCount > ownCount) {
        return done(lib.best, 'medium', 'normalized-library')
      }

      // 3. Close to an existing tag.
      const fuzzyTag = closest(key, tagGroups.values())
      if (fuzzyTag) return done(fuzzyTag.best.value, 'medium', 'fuzzy-tag')

      // 4. Close to a library spelling — only towards one that is used at
      //    least twice as much as this name, and at least twice. Two names a
      //    letter apart that are each used a few times are as likely to be two
      //    artists ("Black Rob", "Black Box") as one typo; the rarer one only
      //    ever points at the commoner one, never the other way round.
      const mine = lib?.total ?? 0
      const fuzzyLib = closest(
        key,
        [...libraryGroups.values()].filter((g) => g.key !== key && g.total >= Math.max(2, mine * 2))
      )
      if (fuzzyLib) return done(fuzzyLib.best, 'low', 'fuzzy-library')

      // 5. Nothing close.
      return done(trimmed, 'low', 'no-match')
    }
  }
}

// One-shot convenience for callers and tests with a single name to check.
export function cleanArtist(incoming: string, ctx: CleanContext): CleanResult {
  return createArtistIndex(ctx).clean(incoming)
}

// ── a whole artist string ─────────────────────────────────────────────────

export interface CleanedArtistString {
  raw: string
  // One result per artist, in order, after the library's " / " split.
  parts: CleanResult[]
}

// Splits only on the delimiter the library itself uses, then cleans each
// artist on its own. A comma, ampersand or "feat." is never a split point.
export function cleanArtistString(raw: string, index: ArtistIndex): CleanedArtistString {
  const parts = splitValue('artist', raw)
  return { raw, parts: parts.map((p) => index.clean(p)) }
}

// A part whose answer differs from what came in.
export function isChange(result: CleanResult): boolean {
  return result.canonical !== '' && result.canonical !== result.raw.trim()
}

export function joinArtistParts(values: readonly string[]): string | null {
  return joinValues(values)
}
