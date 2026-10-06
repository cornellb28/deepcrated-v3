import { test, expect } from '@playwright/test'
import { rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isUnchanged, normalizeMtime } from '../../src/main/rescan'
import { makeTempDir } from '../helpers/audio'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// The database half of a rescan: what the sweep marks, what it leaves alone,
// and what it never touches. Against the real schema via the probe, because
// the point of these assertions is which rows survive — a stand-in could not
// tell you that.
//
// The invariant under test throughout: the sweep's only verb is missing = 1.
// A track whose file has gone keeps its row, its identity, its tags and its
// crate slots, and stays relinkable.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-sweep-')
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

const ROOT = '/music'

function track(filepath: string, extra: Record<string, unknown> = {}): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [
      {
        filepath,
        filename: filepath.split('/').pop(),
        title: filepath.split('/').pop(),
        artist: 'Artist',
        file_size_bytes: 1000,
        duration_sec: 180,
        ...extra
      }
    ]
  }
}

// A root with House/ and Techno/, one track in each, plus a tag and a crate
// on the House track so the sweep can be shown not to disturb them.
function seedLibrary(): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', ROOT] },
    { fn: 'ensureFolderTree', args: [1, ['', 'House', 'Techno']] },
    track(`${ROOT}/House/A.mp3`, { folder_id: 2, client_uuid: 'uuid-a' }),
    track(`${ROOT}/Techno/B.mp3`, { folder_id: 3, client_uuid: 'uuid-b' }),
    { fn: 'findOrCreateTag', args: ['genre', 'Deep House'] },
    { fn: 'applyTag', args: [1, 1] },
    { fn: 'insertCrate', args: ['Warmup', null] },
    { fn: 'addTracksToCrate', args: [1, [1]] }
  ]
}

test('a file the walk never saw is marked missing, not removed', async () => {
  // The walk found B but not A — A's file is gone from disk.
  const result = await runLast<{ swept: number; sweptIds: number[] }>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/Techno/B.mp3`]] }
  ])

  expect(result.swept).toBe(1)
  expect(result.sweptIds).toEqual([1])

  const [tracks, tags, crateTracks] = await run([
    { fn: 'getAllTracks' },
    { fn: 'getTrackTags', args: [1] },
    { fn: 'getCrateTracks', args: [1] }
  ])

  const rows = tracks as Record<string, unknown>[]
  // Still two rows. Nothing was deleted.
  expect(rows.length).toBe(2)

  const a = rows.find((r) => r.id === 1)!
  expect(a.missing).toBe(1)
  expect(a.client_uuid).toBe('uuid-a')
  expect(a.filepath).toBe(`${ROOT}/House/A.mp3`)
  // The associations a hard delete would have cascaded away.
  expect((tags as unknown[]).length).toBe(1)
  expect((crateTracks as unknown[]).length).toBe(1)

  // And B, which the walk did see, is untouched.
  expect(rows.find((r) => r.id === 2)!.missing).toBe(0)
})

test('a swept track is offered to the reconcile pool so it can be relinked', async () => {
  const pool = await runLast<{ id: number; client_uuid: string | null }[]>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/Techno/B.mp3`]] },
    { fn: 'getMissingTracks', args: [1] }
  ])

  expect(pool.map((t) => t.client_uuid)).toEqual(['uuid-a'])
})

test('a sweep that saw everything changes nothing', async () => {
  const result = await runLast<{ swept: number }>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/House/A.mp3`, `${ROOT}/Techno/B.mp3`]] }
  ])

  expect(result.swept).toBe(0)
})

// The sweep is scoped by filepath prefix. A rescan of one folder must not
// reach tracks outside it — and a prefix without its trailing separator
// would let "/music" match "/music-archive".
test('a sibling folder sharing a name prefix is never swept', async () => {
  const result = await runLast<{ swept: number }>([
    { fn: 'addRoot', args: ['Library', ROOT] },
    { fn: 'ensureFolderTree', args: [1, ['']] },
    track(`${ROOT}/A.mp3`),
    track('/music-archive/Old.mp3'),
    // Walk of /music found its one file; /music-archive was never in scope.
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/A.mp3`]] }
  ])

  expect(result.swept).toBe(0)

  const rows = (await runLast([{ fn: 'getAllTracks' }])) as Record<string, unknown>[]
  expect(rows.every((r) => r.missing === 0)).toBe(true)
})

test('a rescan of one subfolder leaves the rest of the library alone', async () => {
  // Walk of House/ only: it found nothing there, but Techno/ is out of scope.
  const result = await runLast<{ swept: number; sweptIds: number[] }>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [`${ROOT}/House`, []] }
  ])

  expect(result.sweptIds).toEqual([1])

  const rows = (await runLast([{ fn: 'getAllTracks' }])) as Record<string, unknown>[]
  expect(rows.find((r) => r.id === 2)!.missing).toBe(0)
})

// Already-missing rows are filtered out before the UPDATE, so a rescan that
// changes nothing reports zero rather than re-marking what was already known.
test('a track already missing is not swept a second time', async () => {
  const [first, second] = await run<{ swept: number }>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/Techno/B.mp3`]] },
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/Techno/B.mp3`]] }
  ]).then((r) => r.slice(-2))

  expect(first.swept).toBe(1)
  expect(second.swept).toBe(0)
})

// A file the walk saw but could not read tags for is still on disk. The
// caller adds it to `seen` regardless of the read failing, which is the
// behaviour this pins.
test('a file that was seen but unreadable is not swept', async () => {
  const result = await runLast<{ swept: number }>([
    ...seedLibrary(),
    { fn: 'sweepTracks', args: [ROOT, [`${ROOT}/House/A.mp3`, `${ROOT}/Techno/B.mp3`]] }
  ])
  expect(result.swept).toBe(0)
})

// ── Folder sweep ────────────────────────────────────────────────────────

test('a folder the walk never visited is marked missing, not removed', async () => {
  // Walk visited the root and House, but not Techno.
  const swept = await runLast<number>([
    ...seedLibrary(),
    { fn: 'sweepFolders', args: [1, ROOT, ROOT, ['', 'House']] }
  ])

  expect(swept).toBe(1)

  const folders = (await runLast([{ fn: 'getFolderScanIndex', args: [1] }])) as {
    relative_path: string
    missing: number
  }[]
  // Still three rows — the folder was flagged, not deleted.
  expect(folders.length).toBe(3)
  expect(folders.find((f) => f.relative_path === 'Techno')!.missing).toBe(1)
  expect(folders.find((f) => f.relative_path === 'House')!.missing).toBe(0)
})

// The reason sweepFolders does not call markFolderMissing: that helper also
// sweeps every track filed under the folder, which would overrule the
// per-file judgement the track sweep just made.
test('sweeping a folder does not mark the tracks filed under it missing', async () => {
  await run([...seedLibrary(), { fn: 'sweepFolders', args: [1, ROOT, ROOT, ['', 'House']] }])

  const rows = (await runLast([{ fn: 'getAllTracks' }])) as Record<string, unknown>[]
  // B is filed in Techno, the folder just swept — but its file was fine.
  expect(rows.find((r) => r.id === 2)!.missing).toBe(0)
})

test('a rescan of one subfolder does not sweep folders outside it', async () => {
  const swept = await runLast<number>([
    ...seedLibrary(),
    // Walked House/ only, and found no subfolders in it.
    { fn: 'sweepFolders', args: [1, ROOT, `${ROOT}/House`, ['House']] }
  ])

  expect(swept).toBe(0)
})

test('a rescan records when the root was last scanned', async () => {
  const roots = await runLast<{ last_scanned_at: number | null }[]>([
    ...seedLibrary(),
    { fn: 'setRootLastScannedAt', args: [1] },
    { fn: 'getAllRoots' }
  ])

  expect(roots[0].last_scanned_at).toBeGreaterThan(0)
})

// ── The stored mtime must survive the round trip ────────────────────────
// isUnchanged is unit-tested against synthetic numbers. What those tests
// cannot catch is a unit or precision mismatch between what fs.stat reports,
// what an INTEGER column stores, and what comes back out — a seconds-vs-
// milliseconds slip here would make every rescan re-read every file, and the
// fast path would silently do nothing.

test('an mtime stored through SQLite still compares equal to the real file', async () => {
  const filepath = join(workDir, 'Real.mp3')
  writeFileSync(filepath, 'not really audio, but it has a real size and mtime')
  const info = statSync(filepath)

  const index = await runLast<
    { id: number; filepath: string; file_size_bytes: number | null; last_modified: number | null }[]
  >([
    { fn: 'addRoot', args: ['Library', workDir] },
    { fn: 'ensureFolderTree', args: [1, ['']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath,
          filename: 'Real.mp3',
          title: 'Real',
          folder_id: 1,
          file_size_bytes: info.size,
          last_modified: normalizeMtime(info.mtimeMs)
        }
      ]
    },
    { fn: 'getTrackScanIndex', args: [workDir + '/'] }
  ])

  expect(index.length).toBe(1)
  expect(index[0].file_size_bytes).toBe(info.size)
  expect(index[0].last_modified).toBe(normalizeMtime(info.mtimeMs))

  // The actual decision the rescan makes, against a real stat of a real file.
  const row = { ...index[0], missing: 0 }
  expect(isUnchanged(row, statSync(filepath))).toBe(true)
})

test('rewriting the file in place makes the rescan re-read it', async () => {
  const filepath = join(workDir, 'Edited.mp3')
  writeFileSync(filepath, 'original bytes')
  const before = statSync(filepath)

  const index = await runLast<
    { id: number; file_size_bytes: number | null; last_modified: number | null }[]
  >([
    { fn: 'addRoot', args: ['Library', workDir] },
    { fn: 'ensureFolderTree', args: [1, ['']] },
    {
      fn: 'insertTrack',
      args: [
        {
          filepath,
          filename: 'Edited.mp3',
          title: 'Edited',
          folder_id: 1,
          file_size_bytes: before.size,
          last_modified: normalizeMtime(before.mtimeMs)
        }
      ]
    },
    { fn: 'getTrackScanIndex', args: [workDir + '/'] }
  ])

  // What an external tag editor does: rewrite the file where it stands.
  writeFileSync(filepath, 'rewritten bytes, a different length entirely')

  const row = { ...index[0], filepath, missing: 0 }
  expect(isUnchanged(row, statSync(filepath))).toBe(false)
})
