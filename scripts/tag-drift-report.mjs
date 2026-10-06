/* eslint-disable @typescript-eslint/explicit-function-return-type --
   Plain JavaScript: the TypeScript rule cannot be satisfied in a .mjs file,
   and the repo's flat config applies tseslint's recommended set to every
   file rather than only to .ts. scripts/serato-dump.ts is TypeScript and so
   passes it naturally. */

// Standalone, READ-ONLY drift report — no writes, no schema changes, no
// project imports. Run with:
//   node scripts/tag-drift-report.mjs [path/to/library.db] [out.json]
//
// Plain .mjs rather than the .ts of serato-dump.ts because there is no local
// tsx and this needs no network fetch to run; better-sqlite3 loads fine under
// plain node against the current build.
//
// ── What this answers ─────────────────────────────────────────────────────
// Five fields are being migrated onto the tags model (genre, grouping, label,
// remixer, composer), with artist as the reference. The tracks columns and
// the tags/track_tags tables have ALREADY drifted, so before anything is
// written one question has to be settled per track: which side is right?
//
// Nothing here decides that. It classifies every disagreement so the choice
// can be made on evidence rather than on a rule that would be wrong ~40
// times.
//
// The delimiter is " / " (settled 2026-09-25): it is what TagInput and
// BulkEditModal already join with, and what the existing column values
// already round-trip through. Splitting on it leaves "R&B" intact.

import Database from 'better-sqlite3'
import { writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DELIM = ' / '
// Per field, matching FIELD_DELIMITERS in src/main/tagFields.ts. grouping also
// takes ' | ' because the files' own TIT1 frame uses it.
const FIELD_DELIMS = { grouping: [' / ', ' | '] }
const delimsFor = (f) => FIELD_DELIMS[f] ?? [DELIM]

// artist is the reference implementation; the rest are being migrated onto
// it. comment and album joined the set on 2026-09-25 — both are TagInput
// fields with derived columns, so they carry the same drift risk.
const FIELDS = ['artist', 'genre', 'grouping', 'label', 'remixer', 'composer', 'comment', 'album']

const DEFAULT_DB = join(
  homedir(),
  'Library',
  'Application Support',
  'cratecloud-v3',
  'cratecloud',
  'library.db'
)

const dbPath = process.argv[2] ?? DEFAULT_DB
const outPath = process.argv[3] ?? null

// readonly is not a suggestion here: this script must never be the thing
// that changed the data it is reporting on.
const db = new Database(dbPath, { readonly: true, fileMustExist: true })

// ── Classification ────────────────────────────────────────────────────────
// The point is to separate "these are the same thing written differently"
// from "these are different data", because only the second needs a human.

const norm = (s) => s.trim().toLowerCase()
// Case AND punctuation/spacing folded: "Hip-Hop" vs "Hip Hop".
const loose = (s) => norm(s).replace(/[^a-z0-9]/g, '')

function splitBy(value, delims) {
  let parts = [value]
  for (const d of delims) parts = parts.flatMap((p) => p.split(d))
  return parts.map((p) => p.trim()).filter(Boolean)
}

function classify(columnValue, tagValues, delims) {
  const colParts = splitBy(columnValue, delims)
  const tagParts = [...tagValues]

  if (tagParts.length === 0) return 'unbacked'
  if (colParts.length === 0) return 'tags-only'

  const sameExact = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  const setOf = (a, f) => new Set(a.map(f))
  const sameSet = (a, b, f) => {
    const x = setOf(a, f)
    const y = setOf(b, f)
    return x.size === y.size && [...x].every((v) => y.has(v))
  }

  if (sameExact(colParts, tagParts)) return 'match'
  if (sameSet(colParts, tagParts, (v) => v)) return 'order-only'
  if (sameSet(colParts, tagParts, norm)) return 'case-only'
  if (sameSet(colParts, tagParts, loose)) return 'punctuation-only'
  return 'content'
}

// Delimiters the migration must NOT split on without confirmation. Listed so
// the report can say which unbacked values need review rather than a
// straight one-tag backfill.
const RISKY = [
  { name: 'comma', re: /,/ },
  { name: 'ampersand', re: /&/ },
  { name: 'slash-no-spaces', re: /\S\/\S/ },
  { name: 'x-separator', re: /\s+x\s+/i },
  { name: 'feat', re: /\b(feat\.?|ft\.?)\b/i },
  { name: 'semicolon', re: /;/ },
  { name: 'pipe', re: /\|/ }
]

// Judged on the parts AFTER an approved split, so an approved delimiter is
// never itself a reason for review: grouping takes " | ", so "90s | CLASSIC"
// splits cleanly and neither part is risky.
function riskyDelimiters(value, delims) {
  const parts = splitBy(value, delims)
  const names = new Set()
  for (const part of parts) for (const { name, re } of RISKY) if (re.test(part)) names.add(name)
  return [...names]
}

// ── Gather ────────────────────────────────────────────────────────────────

const tagsByTrackField = new Map()
for (const row of db
  .prepare(
    `SELECT tt.track_id, g.field, g.value
       FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
      ORDER BY tt.track_id, g.field, tt.rowid`
  )
  .all()) {
  const key = `${row.track_id}\u0000${row.field}`
  if (!tagsByTrackField.has(key)) tagsByTrackField.set(key, [])
  tagsByTrackField.get(key).push(row.value)
}

const tracks = db
  .prepare(`SELECT id, title, artist, genre, grouping, label, remixer, composer FROM tracks`)
  .all()

const report = { db: dbPath, delimiter: DELIM, generated: new Date().toISOString(), fields: {} }

for (const field of FIELDS) {
  const buckets = {
    match: [],
    'order-only': [],
    'case-only': [],
    'punctuation-only': [],
    content: [],
    unbacked: [],
    'tags-only': []
  }

  for (const t of tracks) {
    const columnValue = (t[field] ?? '').trim()
    const tagValues = tagsByTrackField.get(`${t.id}\u0000${field}`) ?? []
    if (!columnValue && tagValues.length === 0) continue

    const kind = classify(columnValue, tagValues, delimsFor(field))
    buckets[kind].push({
      id: t.id,
      title: t.title,
      column: columnValue || null,
      tags: tagValues,
      wouldSplitInto: columnValue
        ? columnValue
            .split(DELIM)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      risky: columnValue ? riskyDelimiters(columnValue, delimsFor(field)) : []
    })
  }

  report.fields[field] = buckets
}

// ── Print ─────────────────────────────────────────────────────────────────

const ORDER = [
  'content',
  'punctuation-only',
  'case-only',
  'order-only',
  'unbacked',
  'tags-only',
  'match'
]
const NEEDS_DECISION = new Set(['content', 'punctuation-only', 'case-only', 'order-only'])

console.log(`\nTag drift report — ${dbPath}`)
console.log(`Delimiter: "${DELIM}"   Tracks: ${tracks.length}\n`)

let decisionsTotal = 0
let reviewTotal = 0

for (const field of FIELDS) {
  const b = report.fields[field]
  const counts = ORDER.map((k) => `${k}=${b[k].length}`).join('  ')
  console.log(`── ${field} ───────────────────────────────────────`)
  console.log(`   ${counts}`)

  for (const kind of ORDER) {
    if (!NEEDS_DECISION.has(kind) || b[kind].length === 0) continue
    console.log(`\n   [${kind}] needs a decision:`)
    for (const row of b[kind]) {
      decisionsTotal++
      console.log(`     #${row.id} ${JSON.stringify(row.title ?? '')}`)
      console.log(`        column: ${JSON.stringify(row.column)}`)
      console.log(`        tags  : ${JSON.stringify(row.tags.join(DELIM))}`)
    }
  }

  const risky = b.unbacked.filter((r) => r.risky.length > 0)
  if (risky.length > 0) {
    console.log(`\n   [unbacked, risky delimiter] backfill as ONE tag unless confirmed:`)
    for (const row of risky) {
      reviewTotal++
      console.log(`     #${row.id} ${JSON.stringify(row.column)}  (${row.risky.join(', ')})`)
    }
  }

  const clean = b.unbacked.length - risky.length
  if (clean > 0) console.log(`\n   ${clean} unbacked value(s) safe to backfill on "${DELIM}" alone`)
  console.log()
}

console.log(`TOTAL needing a per-track decision: ${decisionsTotal}`)
console.log(`TOTAL unbacked with a risky delimiter: ${reviewTotal}`)

if (outPath) {
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nJSON written to ${outPath}`)
}
