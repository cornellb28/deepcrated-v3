import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import {
  HEALTH_CHECKS,
  getHealthQueue,
  getHealthSummary,
  isHealthCheckId,
  type HealthCheckId
} from '../../src/main/health/checks'

// Every check against a fixture library with KNOWN gaps. The schema below is
// the subset of db.ts the checks read; the integration spec
// (tests/integration/health.spec.ts) runs the same checks through the real
// db.ts schema, so a column drift between the two cannot hide.

interface Row {
  id: number
  title?: string
  artist?: string
  genre?: string
  key?: string | null
  bpm?: number | null
  art?: string | null
  size?: number
  dur?: number
  missing?: number
  analysisError?: string | null
  // tags to apply as [field, value]
  tags?: [string, string][]
}

function makeLibrary(rows: Row[], dismissed: [number, number][] = []): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY, filepath TEXT, title TEXT, artist TEXT, genre TEXT,
      key_camelot TEXT, artwork_hash TEXT, bpm REAL, file_size_bytes INTEGER,
      duration_sec REAL, analysis_error TEXT, missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tags (id INTEGER PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(field, value));
    CREATE TABLE track_tags (track_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (track_id, tag_id));
    CREATE TABLE artist_suggestions (
      id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL, raw TEXT NOT NULL, suggested TEXT NOT NULL,
      confidence TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE dismissed_duplicate_pairs (track_id_a INTEGER NOT NULL, track_id_b INTEGER NOT NULL, PRIMARY KEY (track_id_a, track_id_b));
  `)
  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, filepath, title, artist, genre, key_camelot, artwork_hash, bpm,
       file_size_bytes, duration_sec, missing, analysis_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const findTag = db.prepare(`SELECT id FROM tags WHERE field = ? AND value = ?`)
  const insertTag = db.prepare(`INSERT INTO tags (field, value) VALUES (?, ?)`)
  const applyTag = db.prepare(`INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)`)
  for (const r of rows) {
    // Defaults describe a fully healthy, unique track, so a row only
    // overrides what its case is about.
    insertTrack.run(
      r.id,
      `/music/${r.id}.mp3`,
      r.title ?? `Title ${r.id}`,
      r.artist ?? `Artist ${r.id}`,
      r.genre ?? 'House',
      r.key === undefined ? '8A' : r.key,
      r.art === undefined ? `art-${r.id}` : r.art,
      r.bpm === undefined ? 120 : r.bpm,
      r.size ?? 1000 + r.id,
      r.dur ?? 100 + r.id * 7,
      r.missing ?? 0,
      r.analysisError ?? null
    )
    for (const [field, value] of r.tags ?? [['vibe', 'DARK']]) {
      const existing = findTag.get(field, value) as { id: number } | undefined
      const tagId = existing?.id ?? Number(insertTag.run(field, value).lastInsertRowid)
      applyTag.run(r.id, tagId)
    }
  }
  const dismiss = db.prepare(`INSERT INTO dismissed_duplicate_pairs VALUES (?, ?)`)
  for (const [a, b] of dismissed) dismiss.run(a, b)
  return db
}

// Case 1 is healthy. Each other case has exactly the gap its name says, so
// the expected set for every check is known by construction.
function fixture(): Database.Database {
  const db = makeLibrary(
    [
      { id: 1 },
      { id: 2, art: null },
      { id: 3, key: '' },
      { id: 4, bpm: 0 },
      { id: 5, genre: '', tags: [['vibe', 'DARK']] },
      // genre column empty but a genre TAG exists: not "missing genre".
      { id: 6, genre: '', tags: [['genre', 'House']] },
      { id: 7, artist: '', tags: [['vibe', 'DARK']] },
      // artist column empty but an artist TAG exists: not "missing artist".
      { id: 8, artist: '', tags: [['artist', 'Somebody']] },
      { id: 9, tags: [] },
      // Same artist + title, different case/whitespace, different files.
      { id: 10, artist: 'Foo Bar', title: 'Same Song' },
      { id: 11, artist: '  foo bar ', title: 'same song' },
      // Same size and length, nothing else alike.
      { id: 12, size: 5_000_000, dur: 241.2 },
      { id: 13, size: 5_000_000, dur: 241.4 },
      // A duplicate pair the DJ already dismissed — in reversed order.
      { id: 14, artist: 'Dismissed', title: 'Pair' },
      { id: 15, artist: 'Dismissed', title: 'Pair' },
      // Analysis found the file bad, but it is otherwise healthy.
      { id: 17, analysisError: 'truncated' },
      // Otherwise healthy, with an artist-name suggestion waiting for review.
      { id: 18 },
      // Gone from disk, with every other gap, and a name matching track 1.
      {
        id: 16,
        missing: 1,
        artist: 'Artist 1',
        title: 'Title 1',
        genre: '',
        key: null,
        bpm: null,
        art: null,
        analysisError: 'decode_failed',
        tags: []
      }
    ],
    [[15, 14]]
  )
  const suggest = db.prepare(
    `INSERT INTO artist_suggestions (track_id, raw, suggested, confidence, reason, status)
     VALUES (?, ?, ?, 'medium', 'fuzzy-tag', ?)`
  )
  suggest.run(18, 'Notorious BIG', 'NOTORIOUS B.I.G', 'pending')
  // A resolved suggestion no longer counts, and neither does one on a track
  // whose file is gone.
  suggest.run(17, 'Kept Name', 'Other Name', 'kept')
  suggest.run(16, 'Gone Name', 'Other Name', 'pending')
  return db
}

const EXPECTED: Record<HealthCheckId, number[]> = {
  missing_artwork: [2],
  missing_key: [3],
  missing_bpm: [4],
  missing_genre: [5],
  missing_artist: [7],
  no_tags: [9],
  duplicates: [10, 11, 12, 13],
  inconsistent_artist: [18],
  unreadable_audio: [17],
  missing_file: [16]
}

const sorted = (ids: number[]): number[] => [...ids].sort((a, b) => a - b)

for (const check of HEALTH_CHECKS) {
  test(`${check.id} returns exactly the tracks with that gap`, () => {
    const db = fixture()
    expect(sorted(getHealthQueue(db, check.id))).toEqual(EXPECTED[check.id])
  })
}

test('every check is covered by the fixture', () => {
  expect(HEALTH_CHECKS.map((c) => c.id).sort()).toEqual(Object.keys(EXPECTED).sort())
})

test('each count equals the length of its fix queue', () => {
  const db = fixture()
  const summary = getHealthSummary(db)
  for (const result of summary.checks) {
    expect(result.count, result.id).toBe(getHealthQueue(db, result.id).length)
    expect(result.count, result.id).toBe(EXPECTED[result.id].length)
  }
})

test('a missing file is excluded from every other check', () => {
  const db = fixture()
  for (const check of HEALTH_CHECKS) {
    if (check.id === 'missing_file') continue
    expect(getHealthQueue(db, check.id), check.id).not.toContain(16)
  }
})

test('a dismissed pair is not surfaced, in either stored order', () => {
  const db = fixture()
  const queue = getHealthQueue(db, 'duplicates')
  expect(queue).not.toContain(14)
  expect(queue).not.toContain(15)
})

test('a track in two checks is counted once in the overall indicator', () => {
  const db = fixture()
  const summary = getHealthSummary(db)
  // 17 tracks have a file; 12 fail at least one check.
  expect(summary.liveTracks).toBe(17)
  expect(summary.flaggedTracks).toBe(12)

  db.prepare(`UPDATE tracks SET key_camelot = '', bpm = NULL WHERE id = 2`).run()
  const after = getHealthSummary(db)
  // Track 2 now fails three checks but is still one flagged track.
  expect(after.flaggedTracks).toBe(12)
  expect(after.checks.find((c) => c.id === 'missing_key')?.count).toBe(2)
})

test('a duplicate is only flagged against another live track', () => {
  const db = makeLibrary([
    { id: 1, artist: 'A', title: 'T' },
    { id: 2, artist: 'A', title: 'T', missing: 1 }
  ])
  expect(getHealthQueue(db, 'duplicates')).toEqual([])
})

test('tracks with no artist or title are not all lumped together as duplicates', () => {
  const db = makeLibrary([
    { id: 1, artist: '', title: '' },
    { id: 2, artist: '', title: '' },
    { id: 3, artist: 'A', title: '' },
    { id: 4, artist: 'A', title: '' }
  ])
  expect(getHealthQueue(db, 'duplicates')).toEqual([])
})

test('three copies are all listed, and the queue groups them together', () => {
  const db = makeLibrary([
    { id: 1, artist: 'B', title: 'Other' },
    { id: 2, artist: 'A', title: 'Song' },
    { id: 3, artist: 'A', title: 'Song' },
    { id: 4, artist: 'A', title: 'Song' }
  ])
  expect(getHealthQueue(db, 'duplicates')).toEqual([2, 3, 4])
})

test('dismissing some pairs in a group keeps the tracks that still have a partner', () => {
  const copies = [
    { id: 1, artist: 'A', title: 'Song' },
    { id: 2, artist: 'A', title: 'Song' },
    { id: 3, artist: 'A', title: 'Song' }
  ]
  // 1 is dismissed against 2 only: it still has 3, so all three stay.
  expect(getHealthQueue(makeLibrary(copies, [[1, 2]]), 'duplicates')).toEqual([1, 2, 3])
  // 1 is dismissed against both: it has no partner left, 2 and 3 still pair.
  expect(
    getHealthQueue(
      makeLibrary(copies, [
        [1, 2],
        [3, 1]
      ]),
      'duplicates'
    )
  ).toEqual([2, 3])
  // Every pair dismissed: nothing to review.
  expect(
    getHealthQueue(
      makeLibrary(copies, [
        [1, 2],
        [2, 3],
        [1, 3]
      ]),
      'duplicates'
    )
  ).toEqual([])
})

test('a dismissed pair stays dismissed however many keys group it', () => {
  const db = makeLibrary(
    [
      { id: 1, artist: 'A', title: 'Song', size: 9000, dur: 200 },
      { id: 2, artist: 'A', title: 'Song', size: 9000, dur: 200 }
    ],
    [[1, 2]]
  )
  // Both keys group them; the dismissal covers the pair under each.
  expect(getHealthQueue(db, 'duplicates')).toEqual([])
})

test('an empty library has zero for everything and no division to do', () => {
  const summary = getHealthSummary(makeLibrary([]))
  expect(summary.liveTracks).toBe(0)
  expect(summary.flaggedTracks).toBe(0)
  expect(summary.checks.every((c) => c.count === 0)).toBe(true)
})

test('counts follow edits: fixing a gap moves the track out of its queue', () => {
  const db = fixture()
  db.prepare(`UPDATE tracks SET bpm = 128 WHERE id = 4`).run()
  expect(getHealthQueue(db, 'missing_bpm')).toEqual([])
  expect(getHealthSummary(db).checks.find((c) => c.id === 'missing_bpm')?.count).toBe(0)

  // Tagging track 9 clears "no tags"; adding a genre tag clears track 5.
  db.prepare(`INSERT INTO tags (field, value) VALUES ('genre', 'Techno')`).run()
  const tagId = (db.prepare(`SELECT id FROM tags WHERE value = 'Techno'`).get() as { id: number })
    .id
  db.prepare(`INSERT INTO track_tags VALUES (9, ?)`).run(tagId)
  db.prepare(`INSERT INTO track_tags VALUES (5, ?)`).run(tagId)
  expect(getHealthQueue(db, 'no_tags')).toEqual([])
  expect(getHealthQueue(db, 'missing_genre')).toEqual([])
})

test('only known check ids are accepted from the outside', () => {
  expect(isHealthCheckId('duplicates')).toBe(true)
  expect(isHealthCheckId('missing_bpm; DROP TABLE tracks')).toBe(false)
  expect(isHealthCheckId(undefined)).toBe(false)
  expect(isHealthCheckId(42)).toBe(false)
  expect(() => getHealthQueue(fixture(), 'bogus' as HealthCheckId)).toThrow()
})
