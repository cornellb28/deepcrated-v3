import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { rmSync } from 'fs'
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
