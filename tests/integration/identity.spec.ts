import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { freshAudio, hasFfmpeg, makeTempDir } from '../helpers/audio'
import { REPO_ROOT, hasElectron, hasSidecarVenv, SIDECAR_PYTHON } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Track identity against the real SQLite schema: the migration, how the ISRC
// and recording id land in canonical_track_id, and the backfill (real engine,
// real sidecar tag reader) including resuming after an interrupted run.

test.skip(!hasElectron(), 'electron/esbuild not installed')

const ISRC = 'USRC17607839'
const MBID = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const WRITER = join(REPO_ROOT, 'tests', 'helpers', 'write_identity.py')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})

test.afterEach(() => {
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

function track(n: number, extra: Record<string, unknown> = {}): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [{ filepath: `/music/${n}.mp3`, filename: `${n}.mp3`, title: `T${n}`, ...extra }]
  }
}

test('the migration is idempotent: a second launch against the same database is fine', async () => {
  await run([track(1, { isrc: ISRC })])
  const r = await run<unknown>([{ fn: 'identityCanonical', args: [1] }])
  expect(r[0]).toBe(`isrc:${ISRC}`)
})

test('an ISRC passed at import becomes the canonical id, normalized', async () => {
  const [, a, b] = await run<unknown>([
    track(1, { isrc: 'us-rc1-76-07839' }),
    { fn: 'identityCanonical', args: [1] },
    { fn: 'identityProgress' }
  ])
  expect(a).toBe(`isrc:${ISRC}`)
  // Read at import, so the backfill has nothing left to read for it.
  expect(b).toMatchObject({ total: 1, tagsPending: 0 })
})

test('a junk ISRC is ignored rather than becoming an id', async () => {
  const [, id] = await run<unknown>([
    track(1, { isrc: '/Users/dj/Music/song.mp3' }),
    { fn: 'identityCanonical', args: [1] }
  ])
  expect(id).toBeNull()
})

test('a track imported without reading tags is left for the backfill', async () => {
  const [, progress] = await run<unknown>([track(1), { fn: 'identityProgress' }])
  expect(progress).toMatchObject({ total: 1, tagsPending: 1 })
})

test('priority in the database: ISRC, then recording id, then fingerprint hash', async () => {
  const r = await run<unknown>([
    track(1),
    { fn: 'identityTags', args: [1, null, null] },
    { fn: 'identityCanonical', args: [1] }, // nothing yet
    { fn: 'identityFingerprint', args: [1, 'AQADtEmUaEmSJEEi', 200] },
    { fn: 'identityCanonical', args: [1] }, // fp
    { fn: 'identityRecordingId', args: [1, MBID] },
    { fn: 'identityCanonical', args: [1] }, // mbid beats fp
    { fn: 'identityTags', args: [1, ISRC, null] },
    { fn: 'identityCanonical', args: [1] } // isrc beats mbid
  ])
  const ids = [r[2], r[4], r[6], r[8]]
  expect(ids[0]).toBeNull()
  expect(ids[1]).toMatch(/^fp:[0-9a-f]{40}$/)
  expect(ids[2]).toBe(`mbid:${MBID}`)
  expect(ids[3]).toBe(`isrc:${ISRC}`)
})

test('a re-scan that read no tags never blanks an id an earlier scan found', async () => {
  const [, , after] = await run<unknown>([
    track(1, { isrc: ISRC }),
    track(1, { isrc: null }),
    { fn: 'identityCanonical', args: [1] }
  ])
  expect(after).toBe(`isrc:${ISRC}`)
})

test('canonical ids persist across a restart', async () => {
  await run([track(1, { isrc: ISRC })])
  const [id] = await run<unknown>([{ fn: 'identityCanonical', args: [1] }])
  expect(id).toBe(`isrc:${ISRC}`)
})

test('a recording id never overwrites one already set', async () => {
  const [, , id] = await run<unknown>([
    track(1, { musicbrainz_recording_id: MBID }),
    { fn: 'identityRecordingId', args: [1, '11111111-2222-4333-8444-555555555555'] },
    { fn: 'identityCanonical', args: [1] }
  ])
  expect(id).toBe(`mbid:${MBID}`)
})

// ── recording_id_source and the stats id ─────────────────────────────────

const FOUND_MBID = '11111111-2222-4333-8444-555555555555'

test('a recording id from import or tags is marked tag, one from the lookup is marked lookup', async () => {
  const r = await run<unknown>([
    track(1, { musicbrainz_recording_id: MBID }), // read at import
    track(2),
    { fn: 'identityTags', args: [2, null, MBID] }, // read by the backfill
    track(3),
    { fn: 'identityTags', args: [3, null, null] },
    { fn: 'identityFingerprint', args: [3, 'AQADtEmUaEmSJEEi', 200] },
    { fn: 'identityRecordingId', args: [3, FOUND_MBID] }, // the lookup
    { fn: 'identityStatsId', args: [1] },
    { fn: 'identityStatsId', args: [2] },
    { fn: 'identityStatsId', args: [3] },
    { fn: 'identityCanonical', args: [3] }
  ])
  expect(r[7]).toBe(`mbid:${MBID}`)
  expect(r[8]).toBe(`mbid:${MBID}`)
  // Locally the lookup's match is the id; stats keeps the fingerprint id.
  expect(r[9]).toMatch(/^fp:[0-9a-f]{40}$/)
  expect(r[10]).toBe(`mbid:${FOUND_MBID}`)
})

test('a re-scan that reads a recording id tag replaces a looked-up one and marks it tag', async () => {
  const [, , , , , statsId] = await run<unknown>([
    track(1),
    { fn: 'identityTags', args: [1, null, null] },
    { fn: 'identityFingerprint', args: [1, 'AQADtEmUaEmSJEEi', 200] },
    { fn: 'identityRecordingId', args: [1, FOUND_MBID] },
    track(1, { musicbrainz_recording_id: MBID }), // the DJ tagged the file
    { fn: 'identityStatsId', args: [1] }
  ])
  expect(statsId).toBe(`mbid:${MBID}`)
})

test('the recording_id_source migration backfills an existing library once, then leaves it alone', async () => {
  // Build a database, then put it back in the shape it had before the column.
  await run([track(1), track(2), track(3), track(4)])
  const file = join(probe.userDataDir, 'cratecloud', 'library.db')
  const legacy = new Database(file)
  legacy.exec(`ALTER TABLE tracks DROP COLUMN recording_id_source`)
  const set = legacy.prepare(
    `UPDATE tracks SET musicbrainz_recording_id = ?, fingerprint_hash = ? WHERE id = ?`
  )
  set.run(MBID, null, 1) // id, no fingerprint: came from a tag
  set.run(FOUND_MBID, 'f'.repeat(40), 2) // id on a fingerprinted track: the lookup
  set.run(null, 'e'.repeat(40), 3) // fingerprint, no id
  // 4: nothing at all
  legacy.close()

  // Relaunch: the migration adds the column and backfills it.
  await run([])
  const migrated = new Database(file, { readonly: true })
  const sources = migrated
    .prepare(`SELECT id, recording_id_source AS s FROM tracks ORDER BY id`)
    .all() as { id: number; s: string | null }[]
  migrated.close()
  expect(sources).toEqual([
    { id: 1, s: 'tag' },
    { id: 2, s: 'lookup' },
    { id: 3, s: null },
    { id: 4, s: null }
  ])

  const [a, b] = await run<unknown>([
    { fn: 'identityStatsId', args: [1] },
    { fn: 'identityStatsId', args: [2] }
  ])
  expect(a).toBe(`mbid:${MBID}`)
  expect(b).toBe(`fp:${'f'.repeat(40)}`)

  // A later launch does not re-run the backfill over newer writes.
  const again = new Database(file)
  again.prepare(`UPDATE tracks SET recording_id_source = 'tag' WHERE id = 2`).run()
  again.close()
  await run([])
  const after = new Database(file, { readonly: true })
  const row = after.prepare(`SELECT recording_id_source AS s FROM tracks WHERE id = 2`).get() as {
    s: string
  }
  after.close()
  expect(row.s).toBe('tag')
})

// ── the backfill, with real files and the real sidecar ────────────────────

test.describe('backfill', () => {
  test.skip(!hasSidecarVenv() || !hasFfmpeg(), 'needs the sidecar venv and ffmpeg')

  let workDir: string
  test.beforeEach(() => {
    workDir = makeTempDir('deepcrated-backfill-')
  })
  test.afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function files(): { tagged: string; mbid: string; plain: string } {
    const tagged = freshAudio(workDir, 'mp3', 'tagged')
    const mbid = freshAudio(workDir, 'flac', 'mbid')
    const plain = freshAudio(workDir, 'mp3', 'plain')
    execFileSync(SIDECAR_PYTHON, [WRITER, tagged, '--isrc', ISRC])
    execFileSync(SIDECAR_PYTHON, [WRITER, mbid, '--mbid', MBID])
    return { tagged, mbid, plain }
  }

  function insertOps(paths: string[]): ProbeOp[] {
    return paths.map((filepath) => ({
      fn: 'insertTrack',
      args: [{ filepath, filename: filepath.split('/').pop(), title: 't' }]
    }))
  }

  test('reads tags from the files, fingerprints only what has no id, and assigns canonical ids', async () => {
    const f = files()
    const r = await run<unknown>([
      ...insertOps([f.tagged, f.mbid, f.plain]),
      { fn: 'identityBackfill' },
      { fn: 'identityCanonical', args: [1] },
      { fn: 'identityCanonical', args: [2] },
      { fn: 'identityCanonical', args: [3] },
      { fn: 'identityProgress' }
    ])
    expect(r[3]).toMatchObject({ tagsRead: 3, fingerprinted: 1 })
    expect(r[4]).toBe(`isrc:${ISRC}`)
    expect(r[5]).toBe(`mbid:${MBID}`)
    expect(r[6]).toMatch(/^fp:[0-9a-f]{40}$/)
    expect(r[7]).toMatchObject({ tagsPending: 0, fingerprintPending: 0 })
  })

  test('an interrupted backfill resumes where it stopped and does not redo finished work', async () => {
    const f = files()
    const paths = [f.tagged, f.mbid, f.plain]
    // Quit during the very first check: nothing done.
    const interrupted = await run<unknown>([
      ...insertOps(paths),
      { fn: 'identityBackfill', args: [0] },
      { fn: 'identityProgress' }
    ])
    expect(interrupted[3]).toMatchObject({ paused: true, tagsRead: 0 })
    expect(interrupted[4]).toMatchObject({ tagsPending: 3 })

    // A fresh process (a restart) picks it all up from the database alone.
    const resumed = await run<unknown>([
      { fn: 'identityBackfill' },
      { fn: 'identityCanonical', args: [1] },
      { fn: 'identityCanonical', args: [3] },
      { fn: 'identityProgress' }
    ])
    expect(resumed[0]).toMatchObject({ paused: false, tagsRead: 3 })
    expect(resumed[1]).toBe(`isrc:${ISRC}`)
    expect(resumed[2]).toMatch(/^fp:/)

    // And a further run has nothing to do.
    const again = await run<unknown>([{ fn: 'identityBackfill' }])
    expect(again[0]).toMatchObject({ tagsRead: 0, fingerprinted: 0, resolved: 0 })
  })

  // The toggle only gates the lookup, which writes to the database. Neither
  // turning it on or off nor a full run either way may touch the audio: the
  // bytes, the size and the modification time all stay exactly as they were.
  test('toggling the online lookup on or off never writes to or removes anything from the files', async () => {
    const f = files()
    const paths = [f.tagged, f.mbid, f.plain]
    const snapshot = (): { path: string; sha: string; size: number; mtimeMs: number }[] =>
      paths.map((p) => {
        expect(existsSync(p), p).toBe(true)
        const st = statSync(p)
        const sha = createHash('sha256').update(readFileSync(p)).digest('hex')
        return { path: p, sha, size: st.size, mtimeMs: st.mtimeMs }
      })
    const before = snapshot()

    const r = await run<unknown>([
      ...insertOps(paths),
      { fn: 'identityBackfill', args: [null, MBID] }, // toggle never set: OFF
      { fn: 'setSetting', args: ['identity_lookup_enabled', 'true'] },
      { fn: 'identityBackfill', args: [null, MBID] }, // ON: the plain file is matched
      { fn: 'identityCanonical', args: [3] },
      { fn: 'setSetting', args: ['identity_lookup_enabled', 'false'] },
      { fn: 'identityBackfill', args: [null, MBID] }, // OFF again
      { fn: 'identityCanonical', args: [3] }
    ])
    expect(r[3]).toMatchObject({ tagsRead: 3, fingerprinted: 1, resolved: 0 })
    expect(r[5]).toMatchObject({ resolved: 1 })
    expect(r[6]).toBe(`mbid:${MBID}`)
    expect(r[8]).toMatchObject({ resolved: 0 })
    // Turning it off keeps the match already found.
    expect(r[9]).toBe(`mbid:${MBID}`)

    expect(snapshot()).toEqual(before)
  })

  test('files that have gone missing are not read or fingerprinted', async () => {
    const f = files()
    const r = await run<unknown>([
      ...insertOps([f.plain, f.tagged]),
      { fn: 'markTrackMissing', args: [f.plain] },
      { fn: 'identityProgress' },
      { fn: 'identityBackfill' },
      { fn: 'identityCanonical', args: [1] },
      { fn: 'identityCanonical', args: [2] }
    ])
    expect(r[3]).toMatchObject({ total: 1, tagsPending: 1 })
    expect(r[4]).toMatchObject({ tagsRead: 1, fingerprinted: 0 })
    expect(r[5]).toBeNull() // the missing track was left alone
    expect(r[6]).toBe(`isrc:${ISRC}`)
  })
})
