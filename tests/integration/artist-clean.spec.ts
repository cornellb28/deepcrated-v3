import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { freshAudio, hasFfmpeg, makeTempDir, readFileTags } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Artist-name cleanup against the real schema, the real tag-write path and
// real audio files: import-time cleanup, the inbox, keep rules, the re-clean,
// undo, and the "never write the file until it is decided" guarantee.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

let probe: ProbeSession
let workDir: string

test.beforeEach(() => {
  probe = createProbeSession()
  workDir = makeTempDir('deepcrated-artist-')
})

test.afterEach(() => {
  probe.cleanup()
  rmSync(workDir, { recursive: true, force: true })
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

interface ArtistState {
  artist: string | null
  artist_raw: string | null
  tags: string[]
}

// The DJ's library: one track already carrying the blessed tag.
function seedCanonical(): ProbeOp[] {
  return [
    {
      fn: 'insertTrack',
      args: [
        {
          filepath: '/music/canon.mp3',
          filename: 'canon.mp3',
          title: 'Canon',
          artist: 'NOTORIOUS B.I.G'
        }
      ]
    },
    { fn: 'setTagsForField', args: [1, 'artist', ['NOTORIOUS B.I.G']] }
  ]
}

function addFile(file: string, artist: string): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [{ filepath: file, filename: file.split('/').pop(), title: 'T', artist }]
  }
}

test('a high-confidence import is cleaned in the database AND in the file', async () => {
  const file = freshAudio(workDir, 'mp3', 'a')
  const r = await run<unknown>([
    ...seedCanonical(),
    addFile(file, 'Notorious BIG'),
    { fn: 'artistProcess', args: [[2]] },
    { fn: 'artistState', args: [2] }
  ])
  expect(r[r.length - 2]).toMatchObject({ tracks: 1, applied: 1, suggested: 0, failures: [] })
  expect(r[r.length - 1]).toEqual({
    artist: 'NOTORIOUS B.I.G',
    artist_raw: 'Notorious BIG',
    tags: ['NOTORIOUS B.I.G']
  })
  expect((await readFileTags(file)).artist).toBe('NOTORIOUS B.I.G')
})

test('medium: raw name kept as the tag, suggestion queued, file untouched until accepted', async () => {
  const file = freshAudio(workDir, 'mp3', 'a')
  const fileBefore = (await readFileTags(file)).artist
  const r = await run<unknown>([
    {
      fn: 'insertTrack',
      args: [{ filepath: '/music/aali.mp3', filename: 'aali.mp3', title: 'A', artist: 'AALIYAH' }]
    },
    { fn: 'setTagsForField', args: [1, 'artist', ['AALIYAH']] },
    addFile(file, 'Aliyah'),
    { fn: 'artistProcess', args: [[2]] },
    { fn: 'artistState', args: [2] },
    { fn: 'artistGroups' }
  ])
  expect(r[3]).toMatchObject({ applied: 0, suggested: 1 })
  expect(r[4]).toMatchObject({ artist: 'Aliyah', artist_raw: 'Aliyah', tags: ['Aliyah'] })
  expect(r[5]).toMatchObject([
    { raw: 'Aliyah', suggested: 'AALIYAH', confidence: 'medium', trackCount: 1 }
  ])
  // Nothing was written to the file.
  expect((await readFileTags(file)).artist).toBe(fileBefore)

  // Accepting writes it, and only then.
  const accepted = await run<unknown>([
    { fn: 'artistAccept', args: ['Aliyah'] },
    { fn: 'artistState', args: [2] },
    { fn: 'artistGroups' }
  ])
  expect(accepted[0]).toMatchObject({ applied: 1, failed: [] })
  expect(accepted[1]).toMatchObject({ artist: 'AALIYAH', tags: ['AALIYAH'] })
  expect(accepted[2]).toEqual([])
  expect((await readFileTags(file)).artist).toBe('AALIYAH')
})

test('edit writes a custom name; keep saves a rule that survives a restart', async () => {
  const fileA = freshAudio(workDir, 'mp3', 'a')
  const fileB = freshAudio(workDir, 'mp3', 'b')
  await run([
    {
      fn: 'insertTrack',
      args: [{ filepath: '/music/aali.mp3', filename: 'aali.mp3', title: 'A', artist: 'AALIYAH' }]
    },
    { fn: 'setTagsForField', args: [1, 'artist', ['AALIYAH']] },
    addFile(fileA, 'Aliyah'),
    addFile(fileB, 'Aaliyah'),
    { fn: 'artistProcess', args: [[2]] }
  ])
  const edited = await run<unknown>([
    { fn: 'artistAccept', args: ['Aliyah', 'Aaliyah Dana Haughton'] },
    { fn: 'artistState', args: [2] }
  ])
  expect(edited[1]).toMatchObject({
    artist: 'Aaliyah Dana Haughton',
    tags: ['Aaliyah Dana Haughton']
  })
  expect((await readFileTags(fileA)).artist).toBe('Aaliyah Dana Haughton')

  // Keep on a fresh suggestion, then a new process (restart) sees the rule.
  await run([
    addFile(freshAudio(workDir, 'mp3', 'c'), 'Aliyah'),
    { fn: 'artistProcess', args: [[4]] }
  ])
  await run([{ fn: 'artistKeep', args: ['Aliyah'] }])
  const after = await run<unknown>([
    addFile(freshAudio(workDir, 'mp3', 'd'), 'Aliyah'),
    { fn: 'artistProcess', args: [[5]] },
    { fn: 'artistGroups' }
  ])
  expect(after[1]).toMatchObject({ suggested: 0 })
  expect(after[2]).toEqual([])
})

test('a write failure is reported and the track and its file keep the original', async () => {
  const r = await run<unknown>([
    ...seedCanonical(),
    // No such file on disk: the sidecar cannot write it.
    addFile('/nonexistent/dir/ghost.mp3', 'Notorious BIG'),
    { fn: 'artistProcess', args: [[2]] },
    { fn: 'artistState', args: [2] },
    { fn: 'artistGroups' }
  ])
  const report = r[r.length - 3] as { applied: number; failures: { trackId: number }[] }
  expect(report.applied).toBe(0)
  expect(report.failures).toHaveLength(1)
  expect(r[r.length - 2]).toMatchObject({ artist: 'Notorious BIG', tags: ['Notorious BIG'] })
  expect(r[r.length - 1]).toMatchObject([{ raw: 'Notorious BIG', reason: 'write-failed' }])
})

test('the re-clean previews without writing, approves high, and undoes in one step', async () => {
  const f1 = freshAudio(workDir, 'mp3', 'one')
  const f2 = freshAudio(workDir, 'mp3', 'two')
  const before1 = (await readFileTags(f1)).artist

  const preview = await run<unknown>([
    ...seedCanonical(),
    addFile(f1, 'Notorious BIG'),
    addFile(f2, 'The Notorious B.I.G.'),
    { fn: 'artistPreview' },
    { fn: 'artistState', args: [2] }
  ])
  const p = preview[preview.length - 2] as {
    groups: { tier: string; canonical: string; trackCount: number }[]
    tracksAffected: number
  }
  expect(p.groups).toMatchObject([{ tier: 'high', canonical: 'NOTORIOUS B.I.G', trackCount: 2 }])
  expect(preview[preview.length - 1]).toMatchObject({ artist: 'Notorious BIG', tags: [] })
  expect((await readFileTags(f1)).artist).toBe(before1) // a dry run writes nothing

  const applied = await run<unknown>([
    { fn: 'artistApproveHigh' },
    { fn: 'artistState', args: [2] },
    { fn: 'artistState', args: [3] },
    { fn: 'artistUndoInfo' }
  ])
  expect(applied[0]).toMatchObject({ applied: 2, failed: [] })
  expect(applied[1]).toMatchObject({ artist: 'NOTORIOUS B.I.G', tags: ['NOTORIOUS B.I.G'] })
  expect(applied[2]).toMatchObject({ artist: 'NOTORIOUS B.I.G' })
  expect(applied[3]).toEqual({ available: true, tracks: 2 })
  expect((await readFileTags(f1)).artist).toBe('NOTORIOUS B.I.G')
  expect((await readFileTags(f2)).artist).toBe('NOTORIOUS B.I.G')

  // The undo journal survives a restart; undoing restores database and files.
  const undone = await run<unknown>([
    { fn: 'artistUndo' },
    { fn: 'artistState', args: [2] },
    { fn: 'artistState', args: [3] },
    { fn: 'artistUndoInfo' }
  ])
  expect(undone[0]).toMatchObject({ applied: 2, failed: [] })
  expect(undone[1]).toMatchObject({ artist: 'Notorious BIG', tags: [] })
  expect(undone[2]).toMatchObject({ artist: 'The Notorious B.I.G.', tags: [] })
  expect(undone[3]).toEqual({ available: false, tracks: 0 })
  expect((await readFileTags(f1)).artist).toBe('Notorious BIG')
  expect((await readFileTags(f2)).artist).toBe('The Notorious B.I.G.')
})

test('restore original puts the imported name back in the file and the tags', async () => {
  const file = freshAudio(workDir, 'mp3', 'a')
  await run([
    ...seedCanonical(),
    addFile(file, 'Notorious BIG'),
    { fn: 'artistProcess', args: [[2]] }
  ])
  expect((await readFileTags(file)).artist).toBe('NOTORIOUS B.I.G')
  const r = await run<unknown>([
    { fn: 'artistRestore', args: [2] },
    { fn: 'artistState', args: [2] }
  ])
  expect(r[0]).toEqual({ ok: true })
  expect(r[1]).toMatchObject({
    artist: 'Notorious BIG',
    artist_raw: 'Notorious BIG',
    tags: ['Notorious BIG']
  })
  expect((await readFileTags(file)).artist).toBe('Notorious BIG')
})

test('the schema migration is idempotent and the raw name is stored once', async () => {
  const file = freshAudio(workDir, 'mp3', 'a')
  await run([
    ...seedCanonical(),
    addFile(file, 'Notorious BIG'),
    { fn: 'artistProcess', args: [[2]] }
  ])
  // a second launch against the same database
  const r = await run<unknown>([
    { fn: 'artistState', args: [2] },
    { fn: 'artistProcess', args: [[2]] },
    { fn: 'artistState', args: [2] }
  ])
  expect((r[0] as ArtistState).artist_raw).toBe('Notorious BIG')
  expect((r[2] as ArtistState).artist_raw).toBe('Notorious BIG')
})
