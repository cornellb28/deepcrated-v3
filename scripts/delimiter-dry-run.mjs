// Delimiter dry run — READ ONLY. Compares each track's artist string in the
// database with the raw artist tag on disk and classifies the difference.
// Writes nothing to the database or to any audio file; its only outputs are
// delimiter-dry-run.json and delimiter-dry-run.csv in the repo root.
//
//   node scripts/delimiter-dry-run.mjs [path/to/library.db]
//
// Schema notes (there is no artists table and no position column):
//   - tracks.artist is the derived display string most of the library has.
//   - Where a track has artist TAGS (tags.field='artist' joined by track_tags),
//     those are the source of truth and are joined in track_tags rowid order,
//     which is how the app derives the string.
//   - The "DB string" is that value with the legacy " / " normalised to " | ",
//     exactly as the user_version 2 migration does, so the result is the same
//     whether or not the app has migrated this database yet.
//
// Tags are read with scripts/delimiter-read-tags.py (mutagen, the same library
// the sidecar uses). No new dependency.

import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE_DB = join(homedir(), 'Library/Application Support/DeepCrated/cratecloud/library.db')
const dbArg = process.argv[2] ?? LIVE_DB
const PY = existsSync(join(ROOT, 'sidecar/.venv/bin/python3'))
  ? join(ROOT, 'sidecar/.venv/bin/python3')
  : 'python3'

const NEW = ' | '
const LEGACY = ' / '
const normalise = (s) => s.split(LEGACY).join(NEW)

// ── Read-only snapshot of the database ──────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'delimiter-dry-run-'))
const copy = join(tmp, 'library.db')
copyFileSync(dbArg, copy)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(dbArg + ext)) copyFileSync(dbArg + ext, copy + ext)
}
function query(sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', copy, sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  return out.trim() ? JSON.parse(out) : []
}

const tracks = query(
  `SELECT id, filepath, artist FROM tracks
    WHERE artist IS NOT NULL AND TRIM(artist) <> '' ORDER BY id`
)
const tagRows = query(
  `SELECT tt.track_id AS track_id, g.value AS value
     FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
    WHERE g.field = 'artist' ORDER BY tt.track_id, tt.rowid`
)
const tagsByTrack = new Map()
for (const r of tagRows) {
  if (!tagsByTrack.has(r.track_id)) tagsByTrack.set(r.track_id, [])
  tagsByTrack.get(r.track_id).push(r.value)
}
// Any artist TAG whose own value contains the legacy delimiter: that name was
// entered with a slash in it and the join would be ambiguous.
const slashTagValues = query(
  `SELECT value FROM tags WHERE field='artist' AND value LIKE '%/%'`
).map((r) => r.value)

// ── Read the files ──────────────────────────────────────────────────────
const reads = new Map()
const CHUNK = 400
for (let i = 0; i < tracks.length; i += CHUNK) {
  const chunk = tracks.slice(i, i + CHUNK).map((t) => t.filepath)
  const out = execFileSync(PY, [join(ROOT, 'scripts/delimiter-read-tags.py')], {
    input: JSON.stringify(chunk),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  for (const r of JSON.parse(out)) reads.set(r.path, r)
}

// ── Classify ────────────────────────────────────────────────────────────
const counts = { match: 0, delimiter_only: 0, other_mismatch: 0, unreadable: 0 }
const rows = []
let multiValueFiles = 0

for (const t of tracks) {
  const tagValues = tagsByTrack.get(t.id)
  const dbString = tagValues && tagValues.length > 0 ? tagValues.join(NEW) : normalise(t.artist)
  const dbSource = tagValues && tagValues.length > 0 ? 'tags' : 'tracks.artist'
  const r = reads.get(t.filepath)

  let status
  let fileValue = null
  let multiValue = false
  let note = ''

  if (!r || !r.ok) {
    status = 'unreadable'
    note = r?.error ?? 'no result'
  } else {
    multiValue = r.values.length > 1
    if (multiValue) multiValueFiles++
    // A true multi-value tag is read as its values joined with the canonical
    // delimiter: that is what the app would show for it.
    fileValue = multiValue ? r.values.join(NEW) : (r.values[0] ?? '')
    if (fileValue === dbString) status = 'match'
    else if (normalise(fileValue) === dbString) status = 'delimiter_only'
    else status = 'other_mismatch'
    if (multiValue) note = 'true multi-value tag (' + r.kind + ')'
  }
  counts[status]++
  if (status !== 'match') {
    rows.push({
      id: t.id,
      path: t.filepath,
      status,
      current_file_value: fileValue,
      proposed_value: status === 'unreadable' ? null : dbString,
      db_raw: t.artist,
      db_source: dbSource,
      multi_value: multiValue,
      note
    })
  }
}

// ── Reports ─────────────────────────────────────────────────────────────
const stamp = new Date().toISOString()
const delimOnly = rows.filter((r) => r.status === 'delimiter_only')
const report = {
  generated_at: stamp,
  database: dbArg,
  tracks_compared: tracks.length,
  counts,
  multi_value_files: multiValueFiles,
  delimiter_only_equals_93: counts.delimiter_only === 93,
  artist_tags_containing_slash: slashTagValues,
  rows
}
writeFileSync(join(ROOT, 'delimiter-dry-run.json'), JSON.stringify(report, null, 2))

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const cols = [
  'id',
  'path',
  'status',
  'current_file_value',
  'proposed_value',
  'db_raw',
  'db_source',
  'multi_value',
  'note'
]
writeFileSync(
  join(ROOT, 'delimiter-dry-run.csv'),
  [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n'
)

rmSync(tmp, { recursive: true, force: true })

console.log(`Tracks compared: ${tracks.length}`)
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`)
console.log(`True multi-value tags: ${multiValueFiles}`)
console.log(
  `delimiter_only = ${counts.delimiter_only}; equals 93? ${counts.delimiter_only === 93 ? 'YES' : 'NO'}`
)
console.log('Wrote delimiter-dry-run.json and delimiter-dry-run.csv')
