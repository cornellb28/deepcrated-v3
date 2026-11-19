import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { freshAudio, hasFfmpeg, makeTempDir } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// "Tags in your files" end to end: real audio files, the real sidecar
// writer, the real Serato-view reader (analyze.py --serato-tags-batch) and
// the real database. Serato itself is not involved — the reader returns the
// exact frames/atoms Serato shows, which is the contract being tested.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv() || !hasFfmpeg(), 'needs the sidecar venv and ffmpeg')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('deepcrated-file-tags-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

interface SeratoLine {
  filepath: string
  ok: boolean
  tags: Record<string, string>
}

interface Plan {
  checked: number
  tracks: {
    trackId: number
    differences: { field: string; inFile: string; deepcrated: string }[]
  }[]
  fileOnly: number
}

// Three files tagged the old way (by "another app"): legacy " / ", a
// different genre spelling, a comment DeepCrated does not have, no label.
function files(): { mp3: string; m4a: string; wav: string } {
  return {
    mp3: freshAudio(workDir, 'mp3', 'track'),
    m4a: freshAudio(workDir, 'm4a', 'track'),
    wav: freshAudio(workDir, 'wav', 'track')
  }
}

function oldTags(paths: string[]): ProbeOp {
  return {
    fn: 'editTags',
    args: [
      paths.map((filepath) => ({
        filepath,
        meta: { artist: 'ATCQ / VLVT JONES', genre: 'Hip Hop', comment: 'typed elsewhere' }
      })),
      { writeSerato: false }
    ]
  }
}

// What DeepCrated holds for them: the comment is empty here.
function insert(filepath: string): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [
      {
        filepath,
        filename: filepath.split('/').pop(),
        title: 'T',
        artist: 'ATCQ | VLVT JONES',
        genre: 'Hip-Hop',
        label: 'SERATOCOLLECTION',
        remixer: 'NASTYNAS',
        grouping: 'CLASSIC'
      }
    ]
  }
}

test('the check finds every out-of-step file, the write fixes them, and Serato-visible tags match', async () => {
  const f = files()
  const paths = [f.mp3, f.m4a, f.wav]
  const [, , , , plan] = await run<unknown>([
    oldTags(paths),
    insert(f.mp3),
    insert(f.m4a),
    insert(f.wav),
    { fn: 'fileSyncPlan' }
  ])
  const p = plan as Plan
  expect(p.checked).toBe(3)
  expect(p.tracks).toHaveLength(3)
  const mp3Fields = p.tracks[0].differences.map((d) => d.field).sort()
  expect(mp3Fields).toEqual(['artist', 'genre', 'grouping', 'label', 'remixer'].sort())
  // The comment only the file has is counted, not planned.
  expect(p.fileOnly).toBe(3)

  const [written] = await run<{ results: { success: boolean }[] }>([
    { fn: 'fileSyncWrite', args: [p.tracks.map((t) => t.trackId)] }
  ])
  expect(written.results.every((r) => r.success)).toBe(true)

  const [lines, again] = await run<unknown>([
    { fn: 'readSeratoVisibleTags', args: [paths] },
    { fn: 'fileSyncPlan' }
  ])
  const byPath = new Map((lines as SeratoLine[]).map((l) => [l.filepath, l.tags]))

  for (const path of paths) {
    const tags = byPath.get(path)!
    expect(tags.artist, path).toBe('ATCQ | VLVT JONES')
    expect(tags.genre, path).toBe('Hip-Hop')
    // Never cleared: only the file had it.
    expect(tags.comment, path).toBe('typed elsewhere')
  }
  // MP3: label and remixer in their own frames; grouping is just grouping.
  expect(byPath.get(f.mp3)!.label).toBe('SERATOCOLLECTION')
  expect(byPath.get(f.mp3)!.remixer).toBe('NASTYNAS')
  expect(byPath.get(f.mp3)!.grouping).toBe('CLASSIC')
  // M4A and WAV: Serato does not read their label/remixer, so grouping
  // carries them as well.
  expect(byPath.get(f.m4a)!.grouping).toBe('CLASSIC | SERATOCOLLECTION | NASTYNAS')
  expect(byPath.get(f.wav)!.grouping).toBe('CLASSIC | SERATOCOLLECTION | NASTYNAS')

  // And a second check has nothing left to do.
  expect((again as Plan).tracks).toEqual([])
})

test('renaming a tag rewrites that field in every file that carries it', async () => {
  const f = files()
  const [, , , , , genreTagId] = await run<unknown>([
    oldTags([f.mp3, f.m4a]),
    insert(f.mp3),
    insert(f.m4a),
    { fn: 'setTagsForField', args: [1, 'genre', ['Hip-Hop']] },
    { fn: 'setTagsForField', args: [2, 'genre', ['Hip-Hop']] },
    { fn: 'findOrCreateTag', args: ['genre', 'Hip-Hop'] }
  ])

  const [renamed, lines] = await run<unknown>([
    { fn: 'renameTagWithFiles', args: [genreTagId, 'Golden Era'] },
    { fn: 'readSeratoVisibleTags', args: [[f.mp3, f.m4a]] }
  ])
  const r = renamed as { result: { trackIds: number[] }; results: { success: boolean }[] }
  expect(r.result.trackIds.sort()).toEqual([1, 2])
  expect(r.results.every((x) => x.success)).toBe(true)
  for (const line of lines as SeratoLine[]) {
    expect(line.tags.genre, line.filepath).toBe('Golden Era')
    // Only the renamed field is touched.
    expect(line.tags.artist, line.filepath).toBe('ATCQ / VLVT JONES')
  }
})

test('a vibe tag reaches the file through grouping on every write', async () => {
  const f = files()
  const [, , vibeId] = await run<number>([
    insert(f.mp3),
    insert(f.m4a),
    { fn: 'findOrCreateTag', args: ['vibe', 'DARK'] }
  ])
  const [, meta] = await run<unknown>([
    { fn: 'applyTag', args: [1, vibeId] },
    { fn: 'composeWriteMeta', args: [f.mp3, { vibe: 'DARK' }] }
  ])
  expect(meta).toEqual({ grouping: 'CLASSIC | DARK' })

  // A plain grouping edit from the Inspector keeps the vibe in the file too.
  const [m2] = await run<unknown>([
    { fn: 'composeWriteMeta', args: [f.mp3, { grouping: 'CLASSIC | 90s' }] }
  ])
  expect(m2).toEqual({ grouping: 'CLASSIC | 90s | DARK' })

  // An unrelated write is left alone.
  const [m3] = await run<unknown>([{ fn: 'composeWriteMeta', args: [f.mp3, { artist: 'X' }] }])
  expect(m3).toEqual({ artist: 'X' })
})
