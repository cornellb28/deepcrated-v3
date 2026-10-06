import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { makeTempDir } from '../helpers/audio'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Covers the soft-delete contract behind relinking: a file disappearing must
// mark its track row missing, never remove it, so the row's identity
// (client_uuid, partial_hash), its tags and its crate membership are all
// still there to relink onto when the file comes back.
//
// Runs against the real SQLite schema via the probe rather than a stand-in,
// because the thing under test IS the schema behaviour — which rows survive
// a delete, and which rows getMissingTracks' query actually returns.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-missing-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

async function runLast<T = unknown>(ops: ProbeOp[]): Promise<T> {
  const results = await run<T>(ops)
  return results[results.length - 1]
}

interface MissingCandidate {
  id: number
  filepath: string
  client_uuid: string | null
}

// A root with one folder, holding one track that carries both a tag and a
// crate membership — the associations that a hard delete would cascade away.
function seedFiledTrack(): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', '/music'] },
    { fn: 'ensureFolderTree', args: [1, ['House']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/House/Track.mp3',
          filename: 'Track.mp3',
          title: 'Track',
          artist: 'Artist',
          folder_id: 1,
          client_uuid: 'uuid-filed',
          file_size_bytes: 4096,
          duration_sec: 180
        }
      ]
    },
    { fn: 'findOrCreateTag', args: ['genre', 'Deep House'] },
    { fn: 'applyTag', args: [1, 1] },
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [1]] }
  ]
}

test('a track marked missing keeps its row, tags and crate membership', async () => {
  await run([...seedFiledTrack(), { fn: 'markTrackMissing', args: ['/music/House/Track.mp3'] }])

  // Separate run == a fresh process against the same database, so this is
  // what survived the write, not what an in-memory store remembers.
  const [track, tags, crateTracks] = await run([
    { fn: 'getTrackById', args: [1] },
    { fn: 'getTrackTags', args: [1] },
    { fn: 'getCrateTracks', args: [1] }
  ])

  const row = track as Record<string, unknown>
  expect(row).toBeTruthy()
  expect(row.missing).toBe(1)
  // Identity survives — this is what a relink matches on.
  expect(row.client_uuid).toBe('uuid-filed')
  expect(row.filepath).toBe('/music/House/Track.mp3')
  expect((tags as unknown[]).length).toBe(1)
  expect((crateTracks as unknown[]).length).toBe(1)
})

test('a missing track is offered to its own root reconcile pool', async () => {
  const pool = await runLast<MissingCandidate[]>([
    ...seedFiledTrack(),
    { fn: 'markTrackMissing', args: ['/music/House/Track.mp3'] },
    { fn: 'getMissingTracks', args: [1] }
  ])

  expect(pool.map((t) => t.id)).toEqual([1])
})

// The LEFT JOIN fix. importSingleFile always inserts with folder_id null,
// and insertTrack's COALESCE lets that null persist — under the old inner
// join those tracks were invisible to every root-scoped pool, so the
// watcher's onFileAdded could never relink one and would insert a duplicate.
test('a missing track with no folder still reaches a root-scoped pool', async () => {
  const pool = await runLast<MissingCandidate[]>([
    { fn: 'addRoot', args: ['Library', '/music'] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/Unfiled.mp3',
          filename: 'Unfiled.mp3',
          title: 'Unfiled',
          client_uuid: 'uuid-unfiled',
          file_size_bytes: 2048,
          duration_sec: 200
        }
      ]
    },
    { fn: 'markTrackMissing', args: ['/music/Unfiled.mp3'] },
    { fn: 'getMissingTracks', args: [1] }
  ])

  expect(pool.map((t) => t.client_uuid)).toEqual(['uuid-unfiled'])
})

// Scoping is still real: widening to unfiled tracks must not drag in a
// different root's filed tracks.
test('another root’s missing track stays out of the pool', async () => {
  const pool = await runLast<MissingCandidate[]>([
    { fn: 'addRoot', args: ['Library A', '/musicA'] },
    { fn: 'addRoot', args: ['Library B', '/musicB'] },
    { fn: 'ensureFolderTree', args: [2, ['House']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/musicB/House/Other.mp3',
          filename: 'Other.mp3',
          title: 'Other',
          folder_id: 1,
          file_size_bytes: 512,
          duration_sec: 90
        }
      ]
    },
    { fn: 'markTrackMissing', args: ['/musicB/House/Other.mp3'] },
    { fn: 'getMissingTracks', args: [1] }
  ])

  expect(pool).toEqual([])
})

// The whole point of the soft delete: the file comes back under a different
// name, and the original row — tags, crate, client_uuid — follows it there
// instead of a second row appearing beside it.
test('relinking a missing track moves the original row, not a copy', async () => {
  await run([
    ...seedFiledTrack(),
    { fn: 'markTrackMissing', args: ['/music/House/Track.mp3'] },
    { fn: 'ensureFolderTree', args: [1, ['Techno']] },
    { fn: 'relinkTrack', args: [1, '/music/Techno/Renamed.mp3'] }
  ])

  const [tracks, tags, crateTracks] = await run([
    { fn: 'getAllTracks' },
    { fn: 'getTrackTags', args: [1] },
    { fn: 'getCrateTracks', args: [1] }
  ])

  const rows = tracks as Record<string, unknown>[]
  expect(rows.length).toBe(1)
  expect(rows[0].id).toBe(1)
  expect(rows[0].filepath).toBe('/music/Techno/Renamed.mp3')
  expect(rows[0].filename).toBe('Renamed.mp3')
  // Relink clears missing itself — nothing has to un-mark it by hand.
  expect(rows[0].missing).toBe(0)
  expect(rows[0].client_uuid).toBe('uuid-filed')
  expect((tags as unknown[]).length).toBe(1)
  expect((crateTracks as unknown[]).length).toBe(1)
})

// A relinked track must leave the pool, or the next new file could match
// against a row that is no longer missing and steal its identity.
test('a relinked track drops out of the reconcile pool', async () => {
  const pool = await runLast<MissingCandidate[]>([
    ...seedFiledTrack(),
    { fn: 'markTrackMissing', args: ['/music/House/Track.mp3'] },
    { fn: 'relinkTrack', args: [1, '/music/House/Renamed.mp3'] },
    { fn: 'getMissingTracks', args: [1] }
  ])

  expect(pool).toEqual([])
})
