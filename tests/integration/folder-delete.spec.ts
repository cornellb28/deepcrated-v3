import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// deleteFolderCascade, against the real schema rather than a stand-in —
// which is the only way to prove the two foreign keys that make this work
// actually behave as claimed:
//
//   folders.parent_folder_id  ON DELETE CASCADE   → subfolder rows go too
//   tracks.folder_id          ON DELETE SET NULL  → tracks SURVIVE, unfiled
//
// Getting these backwards would silently destroy a DJ's tagging work on a
// "remove from CrateCloud" that promised to keep it.

test.skip(!hasElectron(), 'electron/esbuild not installed')

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

// Positional rest-tuple destructuring over a long op list does not narrow,
// so results are read back by index with the shape stated at the call site.
function at<T>(results: unknown[], indexFromEnd: number): T {
  return results[results.length - indexFromEnd] as T
}

// A root with House/ and House/Deep/, one track in each, plus a tag and a
// crate membership on the first — the associations a hard delete would take
// with it.
function seed(): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', '/music'] },
    { fn: 'ensureFolderTree', args: [1, ['House', 'House/Deep']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/House/One.mp3',
          filename: 'One.mp3',
          title: 'One',
          folder_id: 2,
          file_size_bytes: 4096,
          duration_sec: 180
        }
      ]
    },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/House/Deep/Two.mp3',
          filename: 'Two.mp3',
          title: 'Two',
          folder_id: 3,
          file_size_bytes: 4096,
          duration_sec: 200
        }
      ]
    },
    { fn: 'findOrCreateTag', args: ['genre', 'Deep House'] },
    { fn: 'applyTag', args: [1, 1] },
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [1]] }
  ]
}

test('the seed lays out the folder tree the rest of this spec assumes', async () => {
  const results = await run([...seed(), { fn: 'getFolderTree', args: [] }])
  const folders = at<{ id: number; name: string }[]>(results, 1)

  expect(folders.map((f) => f.name)).toContain('House')
  expect(folders.map((f) => f.name)).toContain('Deep')
})

test('removing from CrateCloud keeps the tracks, their tags and their crates', async () => {
  const results = await run([
    ...seed(),
    // id 2 is House — the subfolder, not the root row.
    { fn: 'deleteFolderCascade', args: [2, { deleteTracks: false }] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] },
    { fn: 'getTrackTags', args: [1] },
  ])

  const removed = at<{ folders: number; tracks: number }>(results, 4)
  const folders = at<{ id: number; name: string }[]>(results, 3)
  const tracks = at<{ id: number; folder_id: number | null }[]>(results, 2)
  const tags = at<unknown[]>(results, 1)

  // House and its Deep child both went.
  expect(removed.folders).toBe(2)
  expect(removed.tracks).toBe(0)
  expect(folders.map((f) => f.name)).not.toContain('House')
  expect(folders.map((f) => f.name)).not.toContain('Deep')

  // Both tracks survived, unfiled. This is the promise the dialog makes.
  expect(tracks.length).toBe(2)
  expect(tracks.every((t) => t.folder_id === null)).toBe(true)

  // And the work the DJ actually did is still there.
  expect(tags.length).toBe(1)
})

test('trashing a folder takes its tracks with it, subfolders included', async () => {
  const results = await run([
    ...seed(),
    { fn: 'deleteFolderCascade', args: [2, { deleteTracks: true }] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] }
  ])

  const removed = at<{ folders: number; tracks: number }>(results, 3)
  const folders = at<{ id: number; name: string }[]>(results, 2)
  const tracks = at<unknown[]>(results, 1)

  expect(removed.folders).toBe(2)
  // Both — the one directly in House and the one in House/Deep.
  expect(removed.tracks).toBe(2)
  expect(folders.map((f) => f.name)).not.toContain('House')
  expect(tracks.length).toBe(0)
})

test('folder rows carry an absolute path — the handler trashes folder.path', async () => {
  // fs:delete-folder refuses with "Folder has no path on disk" if this is
  // null, so the whole trash branch rests on it.
  const results = await run([...seed(), { fn: 'getFolderTree', args: [] }])
  const folders = results[results.length - 1] as { id: number; name: string; path: string | null }[]
  const house = folders.find((f) => f.name === 'House')
  expect(house?.path).toBe('/music/House')
})

test('a folder id that does not exist is a no-op, not a throw', async () => {
  const results = await run([...seed(), { fn: 'deleteFolderCascade', args: [999, { deleteTracks: true }] }])
  const removed = results[results.length - 1] as { folders: number; tracks: number }
  expect(removed).toEqual({ folders: 0, tracks: 0 })
})
