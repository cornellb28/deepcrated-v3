import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// repointFolderSubtree, against the real schema. A folder rename touches
// three things that must move together — the folder row, every descendant
// folder's relative_path, and every track's filepath. relative_path is what
// UNIQUE(root_folder_id, relative_path) keys on, so if it is left behind the
// next ensureFolderTree inserts duplicates of the whole subtree.

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
function at<T>(r: unknown[], fromEnd: number): T {
  return r[r.length - fromEnd] as T
}

// /music/House, /music/House/Deep, one track in each, plus a decoy folder
// whose name SHARES the prefix — "House2" must not be caught by the rename.
function seed(): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', '/music'] },
    { fn: 'ensureFolderTree', args: [1, ['House', 'House/Deep', 'House2']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/House/One.mp3',
          filename: 'One.mp3',
          title: 'One',
          folder_id: 2,
          file_size_bytes: 1,
          duration_sec: 1
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
          // Deep is id 4, not 3 — ensureFolderTree creates the siblings
          // breadth-first, so House2 takes 3.
          folder_id: 4,
          file_size_bytes: 1,
          duration_sec: 1
        }
      ]
    },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/House2/Three.mp3',
          filename: 'Three.mp3',
          title: 'Three',
          folder_id: 3,
          file_size_bytes: 1,
          duration_sec: 1
        }
      ]
    }
  ]
}

test('a rename moves the folder, its descendants and every track under it', async () => {
  const results = await run([
    ...seed(),
    { fn: 'repointFolderSubtree', args: [2, '/music/House', '/music/Peak Time', 'Peak Time'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] }
  ])

  const counts = at<{ foldersUpdated: number; tracksUpdated: number }>(results, 3)
  const folders = at<{ id: number; name: string; path: string; relative_path: string }[]>(results, 2)
  const tracks = at<{ id: number; filepath: string }[]>(results, 1)

  // The folder itself plus its one descendant.
  expect(counts.foldersUpdated).toBe(2)
  expect(counts.tracksUpdated).toBe(2)

  const byId = new Map(folders.map((f) => [f.id, f]))
  expect(byId.get(2)?.name).toBe('Peak Time')
  expect(byId.get(2)?.path).toBe('/music/Peak Time')
  expect(byId.get(2)?.relative_path).toBe('Peak Time')
  // The descendant followed, path AND relative_path.
  expect(byId.get(4)?.path).toBe('/music/Peak Time/Deep')
  expect(byId.get(4)?.relative_path).toBe('Peak Time/Deep')

  const paths = tracks.map((t) => t.filepath).sort()
  expect(paths).toContain('/music/Peak Time/One.mp3')
  expect(paths).toContain('/music/Peak Time/Deep/Two.mp3')
})

test('a sibling sharing the name prefix is NOT caught', async () => {
  // "/music/House" must not match "/music/House2/...". The separator in the
  // prefix is the whole defence.
  const results = await run([
    ...seed(),
    { fn: 'repointFolderSubtree', args: [2, '/music/House', '/music/Peak Time', 'Peak Time'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] }
  ])

  const folders = at<{ id: number; path: string; relative_path: string }[]>(results, 2)
  const tracks = at<{ filepath: string }[]>(results, 1)

  const house2 = folders.find((f) => f.id === 3)
  expect(house2?.path).toBe('/music/House2')
  expect(house2?.relative_path).toBe('House2')
  expect(tracks.map((t) => t.filepath)).toContain('/music/House2/Three.mp3')
})

test('relative_path stays unique, so a rescan cannot duplicate the subtree', async () => {
  const results = await run([
    ...seed(),
    { fn: 'repointFolderSubtree', args: [2, '/music/House', '/music/Peak Time', 'Peak Time'] },
    // ensureFolderTree is what a rescan runs. If relative_path had been left
    // behind, this would insert a second "Peak Time" subtree.
    { fn: 'ensureFolderTree', args: [1, ['Peak Time', 'Peak Time/Deep', 'House2']] },
    { fn: 'getFolderTree', args: [] }
  ])

  const folders = at<{ relative_path: string }[]>(results, 1)
  const rels = folders.map((f) => f.relative_path).filter((r) => r !== null)
  expect(new Set(rels).size, `duplicate relative_paths: ${rels.join(', ')}`).toBe(rels.length)
})

// ── Renaming a watched folder (a library root) ────────────────────────────
// The rule that separates this from a subfolder rename: descendant
// relative_path must NOT change. It is relative to the root, and the root is
// what moved — "House/Deep" is still "House/Deep" after /music becomes
// /library. Rewriting it would break UNIQUE(root_folder_id, relative_path)
// against rows that were already correct.

test('renaming a root moves paths but leaves relative_path alone', async () => {
  const results = await run([
    ...seed(),
    { fn: 'repointRootPath', args: [1, '/music', '/library', 'library'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] },
    { fn: 'getAllRoots', args: [] }
  ])

  const folders = at<{ id: number; name: string; path: string; relative_path: string }[]>(results, 3)
  const tracks = at<{ filepath: string }[]>(results, 2)
  const roots = at<{ id: number; name: string; path: string }[]>(results, 1)

  // library_roots followed.
  expect(roots[0].path).toBe('/library')
  expect(roots[0].name).toBe('library')

  const byId = new Map(folders.map((f) => [f.id, f]))

  // The root folder row: new name and path, relative_path still ''.
  expect(byId.get(1)?.name).toBe('library')
  expect(byId.get(1)?.path).toBe('/library')
  expect(byId.get(1)?.relative_path).toBe('')

  // Descendants: absolute path moved, relative_path untouched.
  expect(byId.get(2)?.path).toBe('/library/House')
  expect(byId.get(2)?.relative_path).toBe('House')
  expect(byId.get(4)?.path).toBe('/library/House/Deep')
  expect(byId.get(4)?.relative_path).toBe('House/Deep')

  const paths = tracks.map((t) => t.filepath).sort()
  expect(paths).toEqual([
    '/library/House/Deep/Two.mp3',
    '/library/House/One.mp3',
    '/library/House2/Three.mp3'
  ])
})

test('a rescan after a root rename does not duplicate the tree', async () => {
  // The payoff of leaving relative_path alone: ensureFolderTree, which is
  // what a rescan runs, finds every folder already present.
  const results = await run([
    ...seed(),
    { fn: 'repointRootPath', args: [1, '/music', '/library', 'library'] },
    { fn: 'ensureFolderTree', args: [1, ['House', 'House/Deep', 'House2']] },
    { fn: 'getFolderTree', args: [] }
  ])

  const folders = at<{ id: number; relative_path: string }[]>(results, 1)
  // Four rows before, four rows after — nothing was re-created.
  expect(folders.length).toBe(4)
  const rels = folders.map((f) => f.relative_path)
  expect(new Set(rels).size).toBe(rels.length)
})
