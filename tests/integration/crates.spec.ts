import { test, expect } from '@playwright/test'
import { rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { makeTempDir } from '../helpers/audio'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'
import { readSubcratesDir } from '../../src/main/serato/seratoCrates'

// Covers crate creation, nesting, membership and ordering (commit 44d96bf)
// and the export that turns a crate into a Serato .crate file (6e25b9e),
// against the real SQLite schema rather than a stand-in.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-crates-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

// Positional destructuring across a long op list is easy to get wrong and
// gives a confusing failure when it is; every spec here only cares about
// the last op's value.
async function runLast<T = unknown>(ops: ProbeOp[]): Promise<T> {
  const results = await run<T>(ops)
  return results[results.length - 1]
}

function trackIds(value: unknown): number[] {
  return (value as { id: number }[]).map((t) => t.id)
}

function seedTracks(count: number): ProbeOp[] {
  return Array.from({ length: count }, (_, index) => ({
    fn: 'insertTrack',
    args: [
      {
        filepath: `/music/Track ${index + 1}.mp3`,
        filename: `Track ${index + 1}.mp3`,
        title: `Track ${index + 1}`,
        artist: 'Artist'
      }
    ]
  }))
}

test('tracks keep the order they were added in', async () => {
  const tracks = await runLast([
    ...seedTracks(3),
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [3, 1, 2]] },
    { fn: 'getCrateTracks', args: [1] }
  ])
  expect(trackIds(tracks)).toEqual([3, 1, 2])
})

test('adding a track that is already in the crate does not duplicate it', async () => {
  const tracks = await runLast([
    ...seedTracks(2),
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2, 1]] },
    { fn: 'getCrateTracks', args: [1] }
  ])
  expect(trackIds(tracks)).toEqual([1, 2])
})

test('reordering renumbers the whole crate and survives a restart', async () => {
  await run([
    ...seedTracks(4),
    { fn: 'insertCrate', args: ['Set', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2, 3, 4]] },
    { fn: 'reorderCrateTracks', args: [1, [4, 3, 2, 1]] }
  ])

  const tracks = await runLast([{ fn: 'getCrateTracks', args: [1] }])
  expect(trackIds(tracks)).toEqual([4, 3, 2, 1])
})

test('removing a track leaves the rest in order', async () => {
  const tracks = await runLast([
    ...seedTracks(3),
    { fn: 'insertCrate', args: ['Set', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2, 3]] },
    { fn: 'removeTracksFromCrate', args: [1, [2]] },
    { fn: 'getCrateTracks', args: [1] }
  ])
  expect(trackIds(tracks)).toEqual([1, 3])
})

test('deleting a track removes it from every crate it was in', async () => {
  const tracks = await runLast([
    ...seedTracks(2),
    { fn: 'insertCrate', args: ['A', null] },
    { fn: 'insertCrate', args: ['B', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2]] },
    { fn: 'addTracksToCrate', args: [2, [1, 2]] },
    { fn: 'deleteTrack', args: [1] },
    { fn: 'getCrateTracks', args: [1] }
  ])
  expect(trackIds(tracks)).toEqual([2])
})

test('a crate can be nested under a parent and moved to another one', async () => {
  const [parentA, parentB, child] = await run<number>([
    { fn: 'insertCrate', args: ['Parent A', null] },
    { fn: 'insertCrate', args: ['Parent B', null] },
    { fn: 'insertCrate', args: ['Child', 1] }
  ])

  const crates = await runLast([
    { fn: 'moveCrateParent', args: [child, parentB] },
    { fn: 'getAllCrates' }
  ])

  const list = crates as { id: number; name: string; parent_crate_id: number | null }[]
  expect(list.find((c) => c.id === child)!.parent_crate_id).toBe(parentB)
  expect(parentA).toBe(1)
})

test('deleting a crate does not delete its tracks', async () => {
  const allTracks = await runLast([
    ...seedTracks(2),
    { fn: 'insertCrate', args: ['Doomed', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2]] },
    { fn: 'deleteCrate', args: [1] },
    { fn: 'getAllTracks' }
  ])
  expect((allTracks as unknown[]).length).toBe(2)
})

test('getAllCrateTrackIds reports membership for every crate at once', async () => {
  const byCrate = await runLast([
    ...seedTracks(3),
    { fn: 'insertCrate', args: ['A', null] },
    { fn: 'insertCrate', args: ['B', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2]] },
    { fn: 'addTracksToCrate', args: [2, [3]] },
    { fn: 'getAllCrateTrackIds' }
  ])

  const map = byCrate as Record<string, number[]>
  expect(map['1'].sort()).toEqual([1, 2])
  expect(map['2']).toEqual([3])
})

// ── Crate to Serato, end to end ───────────────────────────────────────────

test('a crate exports to a .crate file that reads back with the same tracks in order', async () => {
  const seratoDir = join(workDir, '_Serato_')
  const filepaths = ['/music/Third.mp3', '/music/First.mp3', '/music/Second.mp3']

  const inserts: ProbeOp[] = filepaths.map((filepath) => ({
    fn: 'insertTrack',
    args: [{ filepath, filename: filepath.split('/').pop(), title: filepath, artist: 'A' }]
  }))

  const outcome = await runLast([
    ...inserts,
    { fn: 'insertCrate', args: ['Openers', null] },
    { fn: 'addTracksToCrate', args: [1, [1, 2, 3]] },
    {
      fn: 'exportCrateToSerato',
      args: [
        {
          id: 1,
          fileBaseName: 'Openers',
          tracks: filepaths.map((filepath, index) => ({ id: index + 1, filepath, missing: false }))
        },
        { libraryOverridePath: seratoDir, overwriteExisting: true }
      ]
    }
  ])

  expect((outcome as { error?: string }).error).toBeUndefined()
  expect(readdirSync(join(seratoDir, 'Subcrates'))).toEqual(['Openers.crate'])

  const [crate] = await readSubcratesDir(join(seratoDir, 'Subcrates'))
  expect(crate.relativePaths).toEqual(['music/Third.mp3', 'music/First.mp3', 'music/Second.mp3'])
})

test('exporting marks the crate as exported', async () => {
  const crates = await runLast([
    { fn: 'insertCrate', args: ['Tracked', null] },
    { fn: 'touchCrateExported', args: [1] },
    { fn: 'getAllCrates' }
  ])
  const crate = (crates as { id: number; last_exported_at: string | null }[])[0]
  expect(crate.last_exported_at).toBeTruthy()
})
