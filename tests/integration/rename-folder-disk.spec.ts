import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { makeTempDir } from '../helpers/audio'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// The claim this spec exists to hold: after a folder rename, all THREE of
// these agree —
//
//   1. the directory on the hard drive
//   2. the folder's name in CrateCloud
//   3. every track's filepath underneath it
//
// The earlier rename specs only ever called the database half, so "the disk
// and the DB stay in step" was an assertion about code nobody had run
// together. This uses real directories and real files.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-rename-')
  probe = createProbeSession()
})
test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}
function at<T>(r: unknown[], fromEnd: number): T {
  return r[r.length - fromEnd] as T
}

// A real tree on disk: <root>/House/One.mp3 and <root>/House/Deep/Two.mp3,
// plus a House2 sibling that must not be touched.
function buildOnDisk(): { root: string; house: string; deep: string } {
  const root = join(workDir, 'Library')
  const house = join(root, 'House')
  const deep = join(house, 'Deep')
  const house2 = join(root, 'House2')
  mkdirSync(deep, { recursive: true })
  mkdirSync(house2, { recursive: true })
  writeFileSync(join(house, 'One.mp3'), Buffer.alloc(128, 1))
  writeFileSync(join(deep, 'Two.mp3'), Buffer.alloc(128, 2))
  writeFileSync(join(house2, 'Three.mp3'), Buffer.alloc(128, 3))
  return { root, house, deep }
}

function seed(root: string): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', root] },
    { fn: 'ensureFolderTree', args: [1, ['House', 'House/Deep', 'House2']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: join(root, 'House', 'One.mp3'),
          filename: 'One.mp3',
          title: 'One',
          folder_id: 2,
          file_size_bytes: 128,
          duration_sec: 1
        }
      ]
    },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: join(root, 'House', 'Deep', 'Two.mp3'),
          filename: 'Two.mp3',
          title: 'Two',
          folder_id: 4,
          file_size_bytes: 128,
          duration_sec: 1
        }
      ]
    },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: join(root, 'House2', 'Three.mp3'),
          filename: 'Three.mp3',
          title: 'Three',
          folder_id: 3,
          file_size_bytes: 128,
          duration_sec: 1
        }
      ]
    }
  ]
}

test('renaming a subfolder moves the directory, the name and every filepath', async () => {
  const { root, house } = buildOnDisk()

  const results = await run([
    ...seed(root),
    { fn: 'renameFolder', args: [2, 'Peak Time'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] }
  ])

  const outcome = at<{ ok: boolean; newPath?: string }>(results, 3)
  const folders = at<{ id: number; name: string; path: string }[]>(results, 2)
  const tracks = at<{ filepath: string }[]>(results, 1)

  expect(outcome.ok).toBe(true)

  // 1. THE HARD DRIVE
  const renamed = join(root, 'Peak Time')
  expect(existsSync(house), 'old directory still on disk').toBe(false)
  expect(existsSync(renamed)).toBe(true)
  expect(existsSync(join(renamed, 'One.mp3'))).toBe(true)
  expect(existsSync(join(renamed, 'Deep', 'Two.mp3'))).toBe(true)

  // 2. THE NAME IN CRATECLOUD
  const byId = new Map(folders.map((f) => [f.id, f]))
  expect(byId.get(2)?.name).toBe('Peak Time')
  expect(byId.get(2)?.path).toBe(renamed)
  expect(byId.get(4)?.path).toBe(join(renamed, 'Deep'))

  // 3. EVERY FILEPATH
  const paths = tracks.map((t) => t.filepath).sort()
  expect(paths).toEqual(
    [
      join(renamed, 'Deep', 'Two.mp3'),
      join(renamed, 'One.mp3'),
      join(root, 'House2', 'Three.mp3')
    ].sort()
  )

  // And every filepath in the DB points at a file that is really there.
  for (const t of tracks) {
    expect(existsSync(t.filepath), `DB path does not exist: ${t.filepath}`).toBe(true)
  }
})

test('renaming a watched folder moves the root, the directory and every filepath', async () => {
  const { root } = buildOnDisk()

  const results = await run([
    ...seed(root),
    // folder id 1 is the root's own row.
    { fn: 'renameFolder', args: [1, 'Vinyl Rips'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] },
    { fn: 'getAllRoots', args: [] }
  ])

  const outcome = at<{ ok: boolean }>(results, 4)
  const folders = at<{ id: number; name: string; path: string; relative_path: string }[]>(results, 3)
  const tracks = at<{ filepath: string }[]>(results, 2)
  const roots = at<{ path: string; name: string }[]>(results, 1)

  expect(outcome.ok).toBe(true)

  const renamedRoot = join(workDir, 'Vinyl Rips')

  // 1. THE HARD DRIVE
  expect(existsSync(root)).toBe(false)
  expect(existsSync(renamedRoot)).toBe(true)
  expect(existsSync(join(renamedRoot, 'House', 'Deep', 'Two.mp3'))).toBe(true)

  // 2. THE NAME IN CRATECLOUD — library_roots AND the folder row
  expect(roots[0].path).toBe(renamedRoot)
  expect(roots[0].name).toBe('Vinyl Rips')
  const byId = new Map(folders.map((f) => [f.id, f]))
  expect(byId.get(1)?.name).toBe('Vinyl Rips')
  expect(byId.get(1)?.path).toBe(renamedRoot)
  // relative_path is relative to the root, so it does NOT move.
  expect(byId.get(2)?.relative_path).toBe('House')
  expect(byId.get(2)?.path).toBe(join(renamedRoot, 'House'))

  // 3. EVERY FILEPATH
  for (const t of tracks) {
    expect(t.filepath.startsWith(renamedRoot), `not repointed: ${t.filepath}`).toBe(true)
    expect(existsSync(t.filepath), `DB path does not exist: ${t.filepath}`).toBe(true)
  }
})

test('a name already taken on disk is refused, and nothing moves', async () => {
  const { root, house } = buildOnDisk()

  const results = await run([
    ...seed(root),
    // "House2" already exists beside it.
    { fn: 'renameFolder', args: [2, 'House2'] },
    { fn: 'getFolderTree', args: [] },
    { fn: 'getAllTracks', args: [] }
  ])

  const outcome = at<{ ok: boolean; error?: string }>(results, 3)
  const folders = at<{ id: number; name: string }[]>(results, 2)
  const tracks = at<{ filepath: string }[]>(results, 1)

  expect(outcome.ok).toBe(false)
  expect(outcome.error).toContain('already exists')

  // Disk untouched.
  expect(existsSync(house)).toBe(true)
  expect(readdirSync(root).sort()).toEqual(['House', 'House2'])
  // DB untouched.
  expect(folders.find((f) => f.id === 2)?.name).toBe('House')
  expect(tracks.every((t) => existsSync(t.filepath))).toBe(true)
})

test('renaming to the same name is a no-op, not a rewrite', async () => {
  const { root } = buildOnDisk()
  const results = await run([
    ...seed(root),
    { fn: 'renameFolder', args: [2, 'House'] },
    { fn: 'getFolderTree', args: [] }
  ])
  const outcome = at<{ ok: boolean; newPath?: string }>(results, 2)
  expect(outcome.ok).toBe(true)
  expect(outcome.newPath).toBeUndefined()
  expect(at<{ id: number; name: string }[]>(results, 1).find((f) => f.id === 2)?.name).toBe('House')
})

test('a slash in the name is refused before anything is touched', async () => {
  const { root, house } = buildOnDisk()
  const results = await run([...seed(root), { fn: 'planFolderRename', args: [2, 'A/B'] }])
  const planned = at<{ ok: boolean; error?: string }>(results, 1)
  expect(planned.ok).toBe(false)
  expect(planned.error).toContain('slashes')
  expect(existsSync(house)).toBe(true)
})
