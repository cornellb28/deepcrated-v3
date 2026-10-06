import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { makeTempDir } from '../helpers/audio'
import { hasElectron, REPO_ROOT } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// The shared move engine, against real files on a real filesystem. Every
// claim in moveEngine.ts's header is load-bearing for a DJ's library, so
// none of it is asserted by reading the code:
//
//   - same-volume rename and cross-volume copy+verify both land the file
//   - a crate keeps its membership across a move
//   - a rescan AFTER a move does not report the track missing
//   - a name collision renames instead of overwriting
//   - a failed copy leaves the original intact and no partial behind

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-move-')
  probe = createProbeSession()
})

test.afterEach(() => {
  // chmod back, or a 0o500 directory from the failure test cannot be removed.
  try {
    for (const entry of readdirSync(workDir)) {
      const full = join(workDir, entry)
      if (statSync(full).isDirectory()) chmodSync(full, 0o700)
    }
  } catch {
    // best effort
  }
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

function at<T>(results: unknown[], indexFromEnd: number): T {
  return results[results.length - indexFromEnd] as T
}

interface Outcome {
  trackId: number
  status: 'moved' | 'skipped' | 'failed'
  from: string
  to?: string
  renamedTo?: string
  crossVolume?: boolean
  error?: string
  warning?: string
}

// Not real audio: the engine never decodes, it renames and copies bytes.
// A known byte pattern makes the size/contents assertions exact.
function writeFixture(path: string, bytes = 4096): string {
  writeFileSync(path, Buffer.alloc(bytes, 7))
  return path
}

function seedTrack(filepath: string, folderId: number | null = null): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [
      {
        filepath,
        filename: filepath.split('/').pop(),
        title: 'Fixture',
        artist: 'Tester',
        folder_id: folderId,
        file_size_bytes: statSync(filepath).size,
        duration_sec: 120
      }
    ]
  }
}

test('same-volume move renames the file and repoints the row', async () => {
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const from = writeFixture(join(src, 'Track.mp3'))

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'moveTrackToFolder', args: [1, dest] },
    { fn: 'getTrackById', args: [1] }
  ])

  const outcome = at<Outcome>(results, 2)
  const track = at<{ filepath: string; filename: string }>(results, 1)

  expect(outcome.status).toBe('moved')
  // Same volume, so no copy path was taken.
  expect(outcome.crossVolume).toBeFalsy()
  expect(outcome.renamedTo).toBeUndefined()

  expect(existsSync(from)).toBe(false)
  expect(existsSync(join(dest, 'Track.mp3'))).toBe(true)

  // The DB moved with the file, in the same operation.
  expect(track.filepath).toBe(join(dest, 'Track.mp3'))
  expect(track.filename).toBe('Track.mp3')
})

test('cross-volume move copies, verifies, then removes the original', async () => {
  // A genuine EXDEV pair: the repo volume against the system temp volume.
  const other = REPO_ROOT
  const sameDevice = statSync(tmpdir()).dev === statSync(other).dev
  test.skip(sameDevice, 'no second volume available on this machine')

  const src = join(workDir, 'src')
  mkdirSync(src)
  const from = writeFixture(join(src, 'Track.mp3'), 8192)

  // Destination on the OTHER volume.
  const dest = join(other, 'tests', '.probe', `move-xdev-${Date.now()}`)
  mkdirSync(dest, { recursive: true })

  try {
    const results = await run([
      { fn: 'addRoot', args: ['Library', workDir] },
      seedTrack(from),
      { fn: 'moveTrackToFolder', args: [1, dest] },
      { fn: 'getTrackById', args: [1] }
    ])

    const outcome = at<Outcome>(results, 2)
    const track = at<{ filepath: string }>(results, 1)

    expect(outcome.status).toBe('moved')
    // This is the assertion that proves the EXDEV branch actually ran.
    expect(outcome.crossVolume).toBe(true)

    const landed = join(dest, 'Track.mp3')
    expect(existsSync(landed)).toBe(true)
    expect(statSync(landed).size).toBe(8192)
    // Copy, then delete — never the other way round.
    expect(existsSync(from)).toBe(false)
    expect(track.filepath).toBe(landed)

    // No partial left behind on a success.
    expect(readdirSync(dest).filter((f) => f.startsWith('.cratecloud-partial'))).toEqual([])
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('a name collision renames rather than overwriting', async () => {
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const from = writeFixture(join(src, 'Track.mp3'), 4096)
  // A DIFFERENT file already sitting at the destination name.
  writeFixture(join(dest, 'Track.mp3'), 1234)

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'moveTrackToFolder', args: [1, dest] },
    { fn: 'getTrackById', args: [1] }
  ])

  const outcome = at<Outcome>(results, 2)
  const track = at<{ filepath: string }>(results, 1)

  expect(outcome.status).toBe('moved')
  // Surfaced, so the UI can tell the DJ their file is now called something else.
  expect(outcome.renamedTo).toBe('Track (2).mp3')

  // The incumbent was not touched.
  expect(statSync(join(dest, 'Track.mp3')).size).toBe(1234)
  // And ours landed beside it, intact.
  expect(statSync(join(dest, 'Track (2).mp3')).size).toBe(4096)
  expect(track.filepath).toBe(join(dest, 'Track (2).mp3'))
})

test('a failed move leaves the original intact and no partial behind', async () => {
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const from = writeFixture(join(src, 'Track.mp3'))

  // Read+execute only: entries can be listed, nothing can be created.
  chmodSync(dest, 0o500)

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'moveTrackToFolder', args: [1, dest] },
    { fn: 'getTrackById', args: [1] }
  ])

  const outcome = at<Outcome>(results, 2)
  const track = at<{ filepath: string }>(results, 1)

  expect(outcome.status).toBe('failed')
  expect(outcome.error).toBeTruthy()

  // The three things that must be true after any failed move.
  expect(existsSync(from)).toBe(true)
  expect(statSync(from).size).toBe(4096)
  expect(track.filepath).toBe(from)

  chmodSync(dest, 0o700)
  expect(readdirSync(dest)).toEqual([])
})

test('a batch reports per track — one failure does not roll back the rest', async () => {
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const a = writeFixture(join(src, 'A.mp3'))
  const b = writeFixture(join(src, 'B.mp3'))
  const gone = join(src, 'Gone.mp3')
  writeFixture(gone)

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(a),
    seedTrack(b),
    seedTrack(gone),
    // Remove the third file behind the engine's back, so its move must fail
    // while the other two succeed.
    { fn: 'getAllTracks', args: [] }
  ])
  expect(at<unknown[]>(results, 1).length).toBe(3)

  rmSync(gone)

  const moveResults = await run([
    { fn: 'moveTracksToFolder', args: [[1, 2, 3], dest] },
    { fn: 'getAllTracks', args: [] }
  ])

  const batch = at<{
    outcomes: Outcome[]
    moved: number
    failed: number
    renamed: number
  }>(moveResults, 2)

  expect(batch.moved).toBe(2)
  expect(batch.failed).toBe(1)
  expect(batch.outcomes.length).toBe(3)

  // The eleven-of-twelve guarantee, at small scale.
  expect(existsSync(join(dest, 'A.mp3'))).toBe(true)
  expect(existsSync(join(dest, 'B.mp3'))).toBe(true)

  const failed = batch.outcomes.find((o) => o.status === 'failed')
  expect(failed?.error).toContain('not on disk')
})

test('a crate keeps its membership across a move', async () => {
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const from = writeFixture(join(src, 'Track.mp3'))

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'findOrCreateTag', args: ['genre', 'Deep House'] },
    { fn: 'applyTag', args: [1, 1] },
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [1]] },
    { fn: 'moveTrackToFolder', args: [1, dest] },
    { fn: 'getCrateTracks', args: [1] },
    { fn: 'getTrackTags', args: [1] }
  ])

  const outcome = at<Outcome>(results, 3)
  const crateTracks = at<{ id: number; filepath: string }[]>(results, 2)
  const tags = at<unknown[]>(results, 1)

  expect(outcome.status).toBe('moved')

  // crate_tracks keys on tracks(id), so the membership is untouched — and
  // the crate now reports the NEW path, because it joins through the row.
  expect(crateTracks.length).toBe(1)
  expect(crateTracks[0].id).toBe(1)
  expect(crateTracks[0].filepath).toBe(join(dest, 'Track.mp3'))
  expect(tags.length).toBe(1)
})

test('a rescan after a move does NOT report the track missing', async () => {
  // The guarantee the whole engine exists to keep. sweepTracks marks a row
  // missing when its DB filepath is not among the walked paths; because the
  // move repointed the row, the walk finds it exactly where the row says.
  const src = join(workDir, 'src')
  const dest = join(workDir, 'dest')
  mkdirSync(src)
  mkdirSync(dest)
  const from = writeFixture(join(src, 'Track.mp3'))
  const landed = join(dest, 'Track.mp3')

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'moveTrackToFolder', args: [1, dest] },
    // What a rescan of the whole root would actually see on disk now.
    { fn: 'sweepTracks', args: [workDir, [landed]] },
    { fn: 'getTrackById', args: [1] }
  ])

  const sweep = at<{ swept: number; sweptIds: number[] }>(results, 2)
  const track = at<{ filepath: string; missing: number }>(results, 1)

  // Nothing swept: no "missing" row, and therefore no re-add as a duplicate.
  expect(sweep.swept).toBe(0)
  expect(sweep.sweptIds).toEqual([])
  expect(track.missing).toBe(0)
  expect(track.filepath).toBe(landed)
})

test('without the move, that same sweep WOULD mark it missing', async () => {
  // The control for the test above — proving the sweep is actually capable
  // of marking this row, so the previous test's zero means something.
  const src = join(workDir, 'src')
  mkdirSync(src)
  const from = writeFixture(join(src, 'Track.mp3'))

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    // The walk saw nothing — the file is gone from where the row says it is.
    { fn: 'sweepTracks', args: [workDir, []] },
    { fn: 'getTrackById', args: [1] }
  ])

  const sweep = at<{ swept: number; sweptIds: number[] }>(results, 2)
  const track = at<{ missing: number }>(results, 1)

  expect(sweep.swept).toBe(1)
  expect(track.missing).toBe(1)
})

test('moving into the folder it is already in is a no-op, not a false success', async () => {
  const src = join(workDir, 'src')
  mkdirSync(src)
  const from = writeFixture(join(src, 'Track.mp3'))

  const results = await run([
    { fn: 'addRoot', args: ['Library', workDir] },
    seedTrack(from),
    { fn: 'moveTrackToFolder', args: [1, src] },
    { fn: 'getTrackById', args: [1] }
  ])

  const outcome = at<Outcome>(results, 2)
  const track = at<{ filepath: string }>(results, 1)

  expect(outcome.status).toBe('skipped')
  expect(existsSync(from)).toBe(true)
  expect(track.filepath).toBe(from)
})
