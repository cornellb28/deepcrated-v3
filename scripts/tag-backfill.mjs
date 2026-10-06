/* eslint-disable @typescript-eslint/explicit-function-return-type --
   Plain JavaScript: the TypeScript rule cannot be satisfied in a .mjs file,
   and the repo's flat config applies tseslint's recommended set to every
   file. Same reason as scripts/tag-drift-report.mjs. */

// Backfills ONE tag-backed field from its tracks column into tags/track_tags,
// then re-derives the column from those tags.
//
//   node scripts/tag-backfill.mjs --field genre                  (dry run)
//   node scripts/tag-backfill.mjs --field genre --apply          (writes)
//   node scripts/tag-backfill.mjs --field genre --db <path> --apply
//
// DRY RUN BY DEFAULT. --apply is the only thing that writes, and it copies
// the database file first.
//
// ── Why this does not use findOrCreateTag ────────────────────────────────
// That function routes every value through normalizeTagValue, which Title-
// Cases genre by lowercasing after the first letter of each word. On real
// data that turns "R&B" into "R&b" — and the library already holds a seeded
// "R&B", so the backfill would create a mangled duplicate beside it.
//
// So tags are matched EXACTLY and, when genuinely new, inserted with the
// value as written. That is also precisely the brief's rule: near-duplicates
// ("Hip-Hop" vs "Hip Hop", case variants) are never merged automatically —
// they are counted and reported for the crate health dashboard instead.
//
// The normalizer bug is untouched and still live for values typed in the
// app. It is reported at the end so it is not forgotten.

import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_DB = join(
  homedir(),
  'Library',
  'Application Support',
  'cratecloud-v3',
  'cratecloud',
  'library.db'
)

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const field = value('--field', null)
const dbPath = value('--db', DEFAULT_DB)
const apply = flag('--apply')

if (!field) {
  console.error('Missing --field. One field per run, on purpose.')
  process.exit(1)
}

const decisions = JSON.parse(
  readFileSync(new URL('./tag-migration-decisions.json', import.meta.url))
)

const delimiters = decisions.delimiters[field]
if (!delimiters) {
  console.error(`No delimiters declared for "${field}" in tag-migration-decisions.json.`)
  process.exit(1)
}

// ── Rules, mirroring src/main/tagFields.ts ───────────────────────────────
const DISPLAY = ' / '

function splitValue(raw) {
  const v = raw ?? ''
  if (v.trim() === '') return []
  let parts = [v]
  for (const d of delimiters) parts = parts.flatMap((p) => p.split(d))
  return parts.map((p) => p.trim()).filter(Boolean)
}

function joinValues(values) {
  const c = values.map((v) => v.trim()).filter(Boolean)
  return c.length ? c.join(DISPLAY) : null
}

const RISKY = [
  ['comma', /,/],
  ['ampersand', /&/],
  ['slash-no-spaces', /\S\/\S/],
  ['x-separator', /\s+x\s+/i],
  ['feat', /\b(feat\.?|ft\.?)\b/i],
  ['semicolon', /;/]
]

function riskyIn(value) {
  return RISKY.filter(([, re]) => re.test(value)).map(([name]) => name)
}

function safeToSplit(raw) {
  const parts = splitValue(raw)
  if (!parts.length) return true
  return parts.every((p) => riskyIn(p).length === 0)
}

// ── Refuse to write to a database the app still has open ─────────────────
// SQLite in WAL mode would happily let this write while CrateCloud is
// running, and both halves of that are traps:
//
//   - the running app's Zustand store holds pre-migration tracks and tags,
//     so its next tag edit recomputes a derived column from a stale cache
//     and quietly undoes rows this just fixed;
//   - a file copy of library.db alone misses everything still sitting in
//     the -wal, so the "backup" would be missing the newest commits.
//
// -wal/-shm are removed on a clean close, so their presence is the signal.
const walPath = `${dbPath}-wal`
const shmPath = `${dbPath}-shm`

if (apply && (existsSync(walPath) || existsSync(shmPath))) {
  console.error(
    `Refusing to write: ${dbPath} looks open (a -wal/-shm is present).\n` +
      `Quit CrateCloud (\u2318Q, not just closing the window \u2014 it holds a single-instance\n` +
      `lock) and run this again. Pass --force to override, but read the comment\n` +
      `above this check first.`
  )
  if (!flag('--force')) process.exit(1)
}

const db = new Database(dbPath, { readonly: !apply, fileMustExist: true })
db.pragma('foreign_keys = ON')

// ── Backup ───────────────────────────────────────────────────────────────
// db.backup(), not a file copy: SQLite's own online backup API takes a
// consistent snapshot INCLUDING anything outstanding in the -wal. A
// copyFileSync here would produce a backup missing the newest commits.
if (apply) {
  const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await db.backup(backup)
  console.log(`Backup written: ${backup}`)
  console.log(`  restore with:  cp ${JSON.stringify(backup)} ${JSON.stringify(dbPath)}\n`)
}

// ── Existing tags for this field, matched EXACTLY ────────────────────────
const tagIdByValue = new Map()
for (const row of db.prepare('SELECT id, value FROM tags WHERE field = ?').all(field)) {
  tagIdByValue.set(row.value, row.id)
}

const insertTag = apply ? db.prepare('INSERT INTO tags (field, value) VALUES (?, ?)') : null
const linkTag = apply
  ? db.prepare('INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)')
  : null
const unlinkField = apply
  ? db.prepare(
      'DELETE FROM track_tags WHERE track_id = ? AND tag_id IN (SELECT id FROM tags WHERE field = ?)'
    )
  : null
const setColumn = apply
  ? db.prepare(`UPDATE tracks SET ${field} = @value, updated_at = datetime('now') WHERE id = @id`)
  : null

function tagIdFor(rawValue) {
  const existing = tagIdByValue.get(rawValue)
  if (existing !== undefined) return existing
  if (!apply) return -1
  const info = insertTag.run(field, rawValue)
  const id = Number(info.lastInsertRowid)
  tagIdByValue.set(rawValue, id)
  return id
}

// ── Declared merges ──────────────────────────────────────────────────────
// Applied before the per-track work so the rest of the run sees the merged
// vocabulary. Each one is a decision recorded in the decisions file, never a
// guess — automatic near-duplicate merging stays out of scope and is only
// ever reported.
const declaredMerges = decisions.merges?.[field] ?? []
const mergesApplied = []

// A merge renames a VALUE, so it must also catch values arriving from the
// column — otherwise the backfill re-creates the tag the merge just removed,
// which is exactly what happened the first time this ran.
const mergeMap = new Map(declaredMerges.map((m) => [m.from, m.into]))
const mergeValue = (v) => mergeMap.get(v) ?? v

for (const merge of declaredMerges) {
  const fromId = tagIdByValue.get(merge.from)
  // Already merged, or never existed: nothing to do. This is what makes a
  // re-run a no-op.
  if (fromId === undefined) continue

  if (!apply) {
    mergesApplied.push(`${merge.from} -> ${merge.into} (dry run)`)
    continue
  }

  const intoId = tagIdFor(merge.into)
  if (intoId === fromId) continue

  db.transaction(() => {
    // OR IGNORE: a track carrying both already would break the composite key.
    db.prepare('UPDATE OR IGNORE track_tags SET tag_id = ? WHERE tag_id = ?').run(intoId, fromId)
    db.prepare('DELETE FROM track_tags WHERE tag_id = ?').run(fromId)
    db.prepare('DELETE FROM tags WHERE id = ?').run(fromId)
  })()

  tagIdByValue.delete(merge.from)
  mergesApplied.push(`${merge.from} -> ${merge.into}`)
}

// ── Plan ─────────────────────────────────────────────────────────────────
const tracks = db.prepare(`SELECT id, title, ${field} AS col FROM tracks`).all()

const tagsByTrack = new Map()
for (const row of db
  .prepare(
    `SELECT tt.track_id, g.value FROM track_tags tt
       JOIN tags g ON g.id = tt.tag_id
      WHERE g.field = ? ORDER BY tt.rowid`
  )
  .all(field)) {
  if (!tagsByTrack.has(row.track_id)) tagsByTrack.set(row.track_id, [])
  tagsByTrack.get(row.track_id).push(row.value)
}

const plan = { decided: [], backfill: [], derive: [], alreadyOk: [], review: [], empty: [] }

for (const t of tracks) {
  const col = (t.col ?? '').trim()
  const tags = tagsByTrack.get(t.id) ?? []

  const decided = decisions.tracks[String(t.id)]?.[field]
  if (decided) {
    // A re-run must not keep rewriting rows that already hold the decided
    // value — that would bump updated_at on every pass for no change.
    const target = decided.resolved.map(mergeValue)
    const same =
      tags.length === target.length &&
      tags.every((v, i) => v === target[i]) &&
      (t.col ?? null) === joinValues(target)
    if (same) plan.alreadyOk.push(t)
    else plan.decided.push({ ...t, resolved: decided.resolved, note: decided.review ?? null })
    continue
  }

  if (!col && tags.length === 0) {
    plan.empty.push(t)
    continue
  }

  // Tags already there: the column is simply re-derived from them. Covers
  // every comment/album case, and is what makes a re-run a no-op.
  if (tags.length > 0) {
    const merged = tags.map(mergeValue)
    const derived = joinValues(merged)
    if (derived === (t.col ?? null) && merged.every((v, i) => v === tags[i])) plan.alreadyOk.push(t)
    else plan.derive.push({ ...t, resolved: merged, derived })
    continue
  }

  // Column only. Split it if that is unambiguous; otherwise hand it over.
  if (safeToSplit(col)) plan.backfill.push({ ...t, resolved: splitValue(col).map(mergeValue) })
  else plan.review.push({ ...t, risky: riskyIn(col) })
}

// ── Apply ────────────────────────────────────────────────────────────────
const toWrite = [...plan.decided, ...plan.backfill, ...plan.derive]

if (apply) {
  const run = db.transaction(() => {
    for (const row of toWrite) {
      const resolved = row.resolved.map(mergeValue)
      unlinkField.run(row.id, field)
      for (const v of resolved) linkTag.run(row.id, tagIdFor(v))
      setColumn.run({ id: row.id, value: joinValues(resolved) })
    }
  })
  run()
}

// ── Verify ───────────────────────────────────────────────────────────────
// Re-read from the database rather than trusting the plan: the whole point
// is that what landed matches what was intended.
let verified = 0
const mismatches = []

if (apply) {
  const after = db.prepare(`SELECT id, ${field} AS col FROM tracks`).all()
  const afterTags = new Map()
  for (const row of db
    .prepare(
      `SELECT tt.track_id, g.value FROM track_tags tt
         JOIN tags g ON g.id = tt.tag_id
        WHERE g.field = ? ORDER BY tt.rowid`
    )
    .all(field)) {
    if (!afterTags.has(row.track_id)) afterTags.set(row.track_id, [])
    afterTags.get(row.track_id).push(row.value)
  }
  // Held tracks are EXPECTED to differ: their column still holds a value the
  // split could not be trusted with, and no tags were written. Counting them
  // as mismatches would bury a real failure among five known ones.
  const held = new Set(plan.review.map((r) => r.id))

  for (const row of after) {
    if (held.has(row.id)) continue
    const expected = joinValues(afterTags.get(row.id) ?? [])
    if ((row.col ?? null) === expected) verified++
    else mismatches.push({ id: row.id, column: row.col, derived: expected })
  }
}

// ── Near-duplicates: reported, never merged ──────────────────────────────
const byLoose = new Map()
for (const v of tagIdByValue.keys()) {
  const k = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (!byLoose.has(k)) byLoose.set(k, [])
  byLoose.get(k).push(v)
}
const nearDupes = [...byLoose.values()].filter((g) => g.length > 1)

// ── Report ───────────────────────────────────────────────────────────────
console.log(`Field: ${field}    ${apply ? 'APPLY' : 'DRY RUN (nothing written)'}`)
console.log(`DB: ${dbPath}`)
console.log(`Delimiters: ${delimiters.map((d) => JSON.stringify(d)).join(', ')}\n`)

if (mergesApplied.length) {
  console.log(`  merges applied              : ${mergesApplied.join(', ')}`)
}
console.log(`  per-track decisions applied : ${plan.decided.length}`)
console.log(`  backfilled from column      : ${plan.backfill.length}`)
console.log(`  column re-derived from tags : ${plan.derive.length}`)
console.log(`  already consistent          : ${plan.alreadyOk.length}`)
console.log(`  no value either side        : ${plan.empty.length}`)
console.log(`  HELD for review             : ${plan.review.length}`)

if (plan.review.length) {
  console.log(`\n  Held — ambiguous delimiter, left untouched:`)
  for (const r of plan.review)
    console.log(`    #${r.id} ${JSON.stringify(r.col)}  (${r.risky.join(', ')})`)
}

if (apply) {
  const checked = tracks.length - plan.review.length
  console.log(
    `\n  VERIFY: ${verified}/${checked} rows where column === join(tags)` +
      (plan.review.length ? ` (${plan.review.length} held, excluded)` : '')
  )
  if (mismatches.length) {
    console.log(`  MISMATCHES (${mismatches.length}):`)
    for (const m of mismatches.slice(0, 20))
      console.log(
        `    #${m.id} column=${JSON.stringify(m.column)} derived=${JSON.stringify(m.derived)}`
      )
  }
}

if (nearDupes.length) {
  console.log(`\n  Near-duplicate tags in "${field}" — NOT merged, by design:`)
  for (const g of nearDupes) console.log(`    ${g.map((v) => JSON.stringify(v)).join('  vs  ')}`)
  console.log(`  TODO(crate-health): surface these in the health dashboard for manual merging.`)
}

// normalizeTagValue no longer destroys "R&B" (fixed 2026-09-25, see
// src/main/tagFields.ts). This script still matches exactly and inserts raw,
// which is what keeps it from merging near-duplicates the DJ has not asked
// to merge.
