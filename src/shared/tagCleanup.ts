// ── Metadata Cleanup: split combined tag values ───────────────────────────
// Pure planning, no database: what a library's tag values would become under
// a set of rules. main/tagCleanup.ts feeds it rows and applies the result
// through the tag machinery; the review screen shows the groups.
//
// Three kinds of rule, all confirmed by the DJ before they exist:
//   delimiter  "Hip Hop x Twerk" → Hip Hop, Twerk. Per field. Never a comma
//              or "&" ("Drum & Bass" is one genre), and never " x " on
//              artist or label ("A x B" is a real collaboration credit).
//   rewrite    one value → its chosen spelling: r&b / rnb → RnB. Keyed by
//              tagValueKey, so case, hyphens and brackets fold.
//   exact      one whole value → several: "GOTOS HEADZ" → GOTOS, HEADZ. For
//              space-joined values no delimiter can split safely.
// rewrite and exact share one table (tag_rewrite_rules): both map a key to
// a list of values.
//
// tagFields.ts deliberately never splits on " x ". That stays true: these
// rules run only here, on fields the DJ confirmed, never in splitValue.

import { tagValueKey } from './tagKeys'

export const CANDIDATE_DELIMITERS = [' x ', ' / ', ' | ', ';'] as const
export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number]

// Whitespace around a delimiter is loose ("House  x Dance"); the letter x is
// matched in either case ("Blends X Mash Ups").
const DELIMITER_PATTERNS: Record<Delimiter, RegExp> = {
  ' x ': /\s+x\s+/i,
  ' / ': /\s+\/\s+/,
  ' | ': /\s+\|\s+/,
  ';': /\s*;\s*/
}

// The fields this cleanup looks at.
export const CLEANUP_FIELDS = ['genre', 'grouping', 'comment', 'remixer', 'label'] as const
export type CleanupField = (typeof CLEANUP_FIELDS)[number]

// Credits where " x " joins real names. Enforced here, whatever is stored.
const X_EXCLUDED_FIELDS = new Set(['artist', 'label'])

export function isAllowedDelimiter(field: string, delimiter: string): boolean {
  if (!(CLEANUP_FIELDS as readonly string[]).includes(field)) return false
  if (!(CANDIDATE_DELIMITERS as readonly string[]).includes(delimiter)) return false
  return !(delimiter === ' x ' && X_EXCLUDED_FIELDS.has(field))
}

export interface CleanupRules {
  // field → confirmed delimiters
  delimiters: Partial<Record<string, readonly string[]>>
  // field → tagValueKey(value) → replacement values, exact spellings
  rewrites: Partial<Record<string, Readonly<Record<string, readonly string[]>>>>
}

export const NO_RULES: CleanupRules = { delimiters: {}, rewrites: {} }

function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// One value → its parts on the field's confirmed delimiters.
export function splitOnDelimiters(
  field: string,
  value: string,
  delimiters: readonly string[]
): string[] {
  let parts = [value]
  for (const d of delimiters) {
    if (!isAllowedDelimiter(field, d)) continue
    const re = DELIMITER_PATTERNS[d as Delimiter]
    parts = parts.flatMap((p) => p.split(re))
  }
  return parts.map(tidy).filter((p) => p !== '')
}

// ── One track's field ─────────────────────────────────────────────────────

export interface TrackFieldInput {
  trackId: number
  field: string
  column: string | null // tracks.<field> as stored
  linked: readonly string[] // tag values linked to the track for this field, in order
}

export type ChangeKind = 'split' | 'exact' | 'spelling'

export interface PlannedChange {
  trackId: number
  field: string
  prevColumn: string | null
  prevTags: string[]
  newTags: string[]
  kind: ChangeKind
  // Tracks with the same field and original value (up to case and spacing)
  // form one review group.
  groupKey: string
}

// `split` turns a stored column into values (tagFields' splitValue on
// desktop: " | " and the legacy " / "), passed in so this stays pure.
export type ColumnSplitter = (field: string, column: string | null) => string[]

export function planTrackField(
  input: TrackFieldInput,
  rules: CleanupRules,
  splitColumn: ColumnSplitter
): PlannedChange | null {
  const { field } = input
  // Tags win when the track has any: they are the source of truth, and the
  // column is derived from them. Most tracks have only the column.
  const current = input.linked.length > 0 ? [...input.linked] : splitColumn(field, input.column)
  if (current.length === 0) return null

  const delimiters = rules.delimiters[field] ?? []
  const rewrites = rules.rewrites[field] ?? {}
  let kind: ChangeKind | null = null
  const out: string[] = []
  const seen = new Set<string>()
  // Values a rule produced are tidied and de-duplicated. A value no rule
  // touched is kept exactly as stored, line breaks and all (download-site
  // stamps in comment), and never dropped: tidying it is not this cleanup's
  // business.
  const push = (v: string): void => {
    const t = tidy(v)
    const k = tagValueKey(t)
    if (k === '' || seen.has(k)) return
    seen.add(k)
    out.push(t)
  }
  const keep = (v: string): void => {
    seen.add(tagValueKey(v))
    out.push(v)
  }

  for (const value of current) {
    const whole = rewrites[tagValueKey(value)]
    const parts = splitOnDelimiters(field, value, delimiters)
    if (whole && whole.length > 1) {
      // An exact-value rule for the whole value, e.g. "GOTOS HEADZ".
      kind = 'exact'
      whole.forEach(push)
      continue
    }
    if (parts.length === 1 && !rewrites[tagValueKey(parts[0])]) {
      keep(value)
      continue
    }
    if (parts.length > 1) kind = 'split'
    for (const part of parts) {
      const r = rewrites[tagValueKey(part)]
      if (r && r.length > 0) {
        if (kind === null && (r.length !== 1 || r[0] !== part)) kind = 'spelling'
        r.forEach(push)
      } else {
        push(part)
      }
    }
  }

  // Nothing to do: same values, same order. A column-only track that is
  // already clean is left column-only.
  if (out.length === current.length && out.every((v, i) => v === current[i])) return null

  return {
    trackId: input.trackId,
    field,
    prevColumn: input.column,
    prevTags: [...input.linked],
    newTags: out,
    kind: kind ?? 'spelling',
    // The result is part of the key: "hip hop x r&b" and "Hip Hop x R&B"
    // share a group only once a chosen spelling makes their results equal.
    groupKey: [field, current.map(tagValueKey).join('\u0002'), out.join('\u0002')].join('\u0001')
  }
}

// ── Review groups ─────────────────────────────────────────────────────────

export interface PlanGroup {
  id: string // stable for the same rules and library
  kind: ChangeKind
  field: string
  label: string // the most common original spelling
  spellings: { value: string; count: number }[]
  result: string[]
  trackIds: number[]
}

export function groupChanges(
  changes: readonly PlannedChange[],
  display: (c: PlannedChange) => string
): PlanGroup[] {
  const byKey = new Map<string, { changes: PlannedChange[]; spellings: Map<string, number> }>()
  for (const c of changes) {
    let g = byKey.get(c.groupKey)
    if (!g) byKey.set(c.groupKey, (g = { changes: [], spellings: new Map() }))
    g.changes.push(c)
    const s = display(c)
    g.spellings.set(s, (g.spellings.get(s) ?? 0) + 1)
  }
  const groups: PlanGroup[] = []
  for (const [key, g] of byKey) {
    const spellings = [...g.spellings]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    const first = g.changes[0]
    groups.push({
      id: key,
      kind: first.kind,
      field: first.field,
      label: spellings[0].value,
      spellings,
      result: first.newTags,
      trackIds: g.changes.map((c) => c.trackId)
    })
  }
  const order: Record<ChangeKind, number> = { split: 0, exact: 1, spelling: 2 }
  return groups.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      b.trackIds.length - a.trackIds.length ||
      (a.label < b.label ? -1 : 1)
  )
}

// ── Spelling variants ─────────────────────────────────────────────────────
// Values that are the same tag written differently. tagValueKey already
// folds case, hyphens and brackets; this also ignores spaces and
// punctuation ("Mash Ups" / "Mashups") and treats the ways of writing R&B as
// one, so the DJ can choose a single spelling.

const SAME_TAG: readonly (readonly string[])[] = [['r&b', 'rnb', 'r and b', 'r n b', 'r & b']]

export function variantKey(value: string): string {
  const k = tagValueKey(value)
  for (const group of SAME_TAG) if (group.includes(k)) return group[0]
  return k.replace(/[^\p{L}\p{N}&]/gu, '')
}

export interface SpellingGroup {
  field: string
  key: string // variantKey
  spellings: { value: string; count: number }[] // most used first
}

// values: every value a field holds across the library, after delimiter
// splits, one entry per track occurrence.
export function findSpellingGroups(field: string, values: readonly string[]): SpellingGroup[] {
  const byKey = new Map<string, Map<string, number>>()
  for (const raw of values) {
    const v = tidy(raw)
    if (v === '') continue
    const k = variantKey(v)
    let m = byKey.get(k)
    if (!m) byKey.set(k, (m = new Map()))
    m.set(v, (m.get(v) ?? 0) + 1)
  }
  const out: SpellingGroup[] = []
  for (const [key, m] of byKey) {
    if (m.size < 2) continue
    out.push({
      field,
      key,
      spellings: [...m]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    })
  }
  return out.sort(
    (a, b) =>
      b.spellings.reduce((s, x) => s + x.count, 0) - a.spellings.reduce((s, x) => s + x.count, 0)
  )
}

// ── Likely typos ──────────────────────────────────────────────────────────
// A rare value one letter away from a common one ("Hpuse" → House). Offered,
// never preselected.

function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

export interface TypoSuggestion {
  field: string
  from: string
  fromCount: number
  to: string
  toCount: number
}

export function findTypos(
  field: string,
  values: readonly string[],
  minRatio = 3,
  minLength = 4
): TypoSuggestion[] {
  // Per variant: its total, shown under its most used spelling.
  const counts = new Map<string, { value: string; count: number; spellings: Map<string, number> }>()
  for (const raw of values) {
    const v = tidy(raw)
    const k = variantKey(v)
    if (k.length < minLength) continue
    let e = counts.get(k)
    if (!e) counts.set(k, (e = { value: v, count: 0, spellings: new Map() }))
    e.count++
    const n = (e.spellings.get(v) ?? 0) + 1
    e.spellings.set(v, n)
    if (n > (e.spellings.get(e.value) ?? 0)) e.value = v
  }
  const entries = [...counts]
  const out: TypoSuggestion[] = []
  for (const [k, rare] of entries) {
    let best: { value: string; count: number } | null = null
    for (const [k2, common] of entries) {
      if (common.count < rare.count * minRatio || !oneEditApart(k, k2)) continue
      if (!best || common.count > best.count) best = common
    }
    if (best) {
      out.push({
        field,
        from: rare.value,
        fromCount: rare.count,
        to: best.value,
        toCount: best.count
      })
    }
  }
  return out.sort((a, b) => (a.from < b.from ? -1 : 1))
}

// ── Exact-value proposals ─────────────────────────────────────────────────
// Space-joined badges in comment: "GOTOS HEADZ" is two badges the DJ also
// uses on their own. A value of two or more all-caps words containing at
// least one known badge is proposed as a split into its words; it is
// preselected only when every word is a known badge, so "GOTOS HEADZ
// SENDOFF INTRO" is shown for the DJ to edit rather than assumed.

export interface ExactProposal {
  field: string
  value: string
  count: number
  result: string[]
  preselected: boolean
}

const BADGE_WORD = /^[A-Z][A-Z0-9]*$/

export function findExactProposals(
  field: string,
  values: readonly string[],
  minBadgeCount = 2
): ExactProposal[] {
  const counts = new Map<string, number>()
  for (const raw of values) {
    const v = tidy(raw)
    if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const badges = new Set(
    [...counts].filter(([v, n]) => n >= minBadgeCount && BADGE_WORD.test(v)).map(([v]) => v)
  )
  const out: ExactProposal[] = []
  for (const [value, count] of counts) {
    const words = value.split(' ')
    if (words.length < 2 || !words.every((w) => BADGE_WORD.test(w))) continue
    const known = words.filter((w) => badges.has(w)).length
    if (known === 0) continue
    out.push({ field, value, count, result: words, preselected: known === words.length })
  }
  return out.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
}

// ── Rules from the review screen's choices ────────────────────────────────

export interface CleanupChoices {
  delimiters: { field: string; delimiter: string }[]
  // A chosen spelling for every variant of a tag.
  spellings: { field: string; canonical: string; variants: string[] }[]
  // Accepted typo fixes.
  typos: { field: string; from: string; to: string }[]
  // Accepted exact-value splits, as edited.
  exact: { field: string; value: string; result: string[] }[]
}

export function rulesFromChoices(c: CleanupChoices): CleanupRules {
  const delimiters: Record<string, string[]> = {}
  const rewrites: Record<string, Record<string, string[]>> = {}
  const rewrite = (field: string, from: string, to: string[]): void => {
    const k = tagValueKey(from)
    if (k === '') return
    ;(rewrites[field] ??= {})[k] = to.map(tidy).filter((v) => v !== '')
  }
  for (const { field, delimiter } of c.delimiters) {
    if (!isAllowedDelimiter(field, delimiter)) continue
    const list = (delimiters[field] ??= [])
    if (!list.includes(delimiter)) list.push(delimiter)
  }
  for (const s of c.spellings) {
    for (const v of [...s.variants, s.canonical]) rewrite(s.field, v, [s.canonical])
  }
  // A typo points at the canonical spelling of its target when one is set.
  for (const t of c.typos) {
    const target = rewrites[t.field]?.[tagValueKey(t.to)] ?? [t.to]
    rewrite(t.field, t.from, [...target])
  }
  for (const e of c.exact) rewrite(e.field, e.value, e.result)
  return { delimiters, rewrites }
}

// Saved rules plus this session's, the session winning on a clash.
export function mergeRules(base: CleanupRules, next: CleanupRules): CleanupRules {
  const delimiters: Record<string, string[]> = {}
  for (const src of [base.delimiters, next.delimiters]) {
    for (const [f, ds] of Object.entries(src)) {
      const list = (delimiters[f] ??= [])
      for (const d of ds ?? []) if (!list.includes(d)) list.push(d)
    }
  }
  const rewrites: Record<string, Record<string, readonly string[]>> = {}
  for (const src of [base.rewrites, next.rewrites]) {
    for (const [f, map] of Object.entries(src)) Object.assign((rewrites[f] ??= {}), map)
  }
  return { delimiters, rewrites }
}

// ── The canary ────────────────────────────────────────────────────────────
// The first file write of a batch is a few files the DJ checks in Serato:
// one of each format the batch touches, in this order, so a format that
// Serato reads differently (WAV keeps tags in an ID3 chunk inside RIFF) shows
// up before the rest are written. Topped up to CANARY_SIZE from what is left.

export const CANARY_SIZE = 3
const CANARY_FORMATS = ['.mp3', '.m4a', '.wav']

export function pickCanary<T extends { filepath: string }>(items: readonly T[]): T[] {
  const ext = (p: string): string => (/\.[^./\\]+$/.exec(p)?.[0] ?? '').toLowerCase()
  const picked: T[] = []
  for (const format of CANARY_FORMATS) {
    const hit = items.find((i) => ext(i.filepath) === format && !picked.includes(i))
    if (hit) picked.push(hit)
  }
  for (const i of items) {
    if (picked.length >= CANARY_SIZE) break
    if (!picked.includes(i)) picked.push(i)
  }
  return picked.slice(0, CANARY_SIZE)
}

// ── Shapes passed between main and the review screen ──────────────────────

export interface DelimiterCandidate {
  field: string
  delimiter: string
  tracks: number
  distinct: number
  examples: { value: string; count: number }[]
  allowed: boolean
  confirmed: boolean // a saved rule
  // " | " is the separator DeepCrated already uses: counted for the record,
  // never offered as something to split.
  existing: boolean
}

export interface SpellingChoiceGroup {
  field: string
  key: string
  spellings: { value: string; count: number }[]
  chosen: string | null // the saved canonical spelling, if every variant has one
}

export interface CleanupInventory {
  tracks: number
  delimiters: DelimiterCandidate[]
  spellings: SpellingChoiceGroup[]
  typos: TypoSuggestion[]
  exact: (ExactProposal & { saved: string[] | null })[]
  savedRules: CleanupRules
}

// A value the cleanup would create that ends up on this few tracks across the
// whole library ("Line", "Edit"): probably a mistake or a one-off. Its group
// is shown with the tracks behind it and starts unticked (kept as it is).
export const RARE_VALUE_MAX_TRACKS = 2

export interface ReviewGroup extends PlanGroup {
  examples: { trackId: number; title: string | null; artist: string | null }[]
  rare: { value: string; tracks: number }[]
}

export interface ApplyRequest {
  choices: CleanupChoices
  // The groups to apply, each with its result as edited on the review screen.
  selections: { groupId: string; result: string[] }[]
  source?: 'library' | 'import'
  dryRun?: boolean
}

export interface ApplySummary {
  batchId: string
  dryRun: boolean
  tracks: number
  changes: number
  byField: Record<string, number>
  tagsCreated: string[] // "field:value"
  tagsDeleted: string[]
  files: number // tracks whose file can be written (present, not missing)
}

export interface BatchInfo {
  id: string
  createdAt: number
  source: 'library' | 'import'
  status: 'applied' | 'undone'
  filesStatus: string
  changes: number
  filesWritten: number
  examples: { field: string; before: string | null; after: string[] }[]
}

export interface UndoSummary {
  batchId: string
  dryRun: boolean
  restored: number
  skipped: { trackId: number; title: string | null; reason: string }[]
  filesToRestore: number
}
