import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { freshAudio, hasFfmpeg, makeTempDir, readFileTags } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Metadata Cleanup against the real SQLite schema (db.ts), through
// main/tagCleanup/. The last test also writes a real audio file the way the
// edit-tags job does; the job itself is covered by its own specs.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession
test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => probe.cleanup())

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

function track(n: number, extra: Record<string, unknown>): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [{ filepath: `/music/${n}.mp3`, filename: `${n}.mp3`, title: `T${n}`, ...extra }]
  }
}

interface Group {
  rare: { value: string; tracks: number }[]
  id: string
  kind: string
  field: string
  label: string
  result: string[]
  trackIds: number[]
}
interface Summary {
  batchId: string
  tracks: number
  changes: number
  byField: Record<string, number>
  tagsCreated: string[]
  tagsDeleted: string[]
  files: number
}
interface Row {
  id: number
  genre: string | null
  comment: string | null
  label: string | null
  artist: string | null
}

const CHOICES = {
  delimiters: [
    { field: 'genre', delimiter: ' x ' },
    { field: 'label', delimiter: ' x ' } // refused: never on label
  ],
  spellings: [
    { field: 'genre', canonical: 'RnB', variants: ['R&B', 'r&b'] },
    { field: 'genre', canonical: 'Hip Hop', variants: ['hip hop'] }
  ],
  typos: [],
  exact: [{ field: 'comment', value: 'GOTOS HEADZ', result: ['GOTOS', 'HEADZ'] }]
}

async function seed(): Promise<void> {
  await run([
    track(1, { genre: 'Hip Hop x R&B', label: 'Def Jam x Roc', artist: 'A x B' }),
    track(2, { genre: 'hip hop x r&b' }),
    track(3, { genre: 'Hip Hop x Twerk', comment: 'GOTOS HEADZ' }),
    track(4, { genre: 'Soul' }),
    track(5, { genre: 'R&B' }),
    // An old combined tag row that nothing uses.
    { fn: 'findOrCreateTag', args: ['genre', 'Soul x Boogie x Jazz'] }
  ])
}

async function rows(): Promise<Row[]> {
  const [all] = await run<Row[]>([{ fn: 'getAllTracks' }])
  return [...all].sort((a, b) => a.id - b.id)
}

async function genreTags(trackId: number): Promise<string[]> {
  const [tags] = await run<{ field: string; value: string }[]>([
    { fn: 'getTrackTags', args: [trackId] }
  ])
  return tags.filter((t) => t.field === 'genre').map((t) => t.value)
}

test('plan groups by original value and result; artist and label are never split', async () => {
  await seed()
  const [plan] = await run<{ groups: Group[]; tracks: number }>([
    { fn: 'cleanupPlan', args: [CHOICES] }
  ])
  const byLabel = Object.fromEntries(plan.groups.map((g) => [g.label, g]))
  // The chosen spelling makes both spellings of "Hip Hop x R&B" one group.
  expect(byLabel['Hip Hop x R&B']).toMatchObject({ kind: 'split', result: ['Hip Hop', 'RnB'] })
  expect(byLabel['Hip Hop x R&B'].trackIds).toHaveLength(2)
  expect(byLabel['GOTOS HEADZ']).toMatchObject({ kind: 'exact', result: ['GOTOS', 'HEADZ'] })
  expect(byLabel['R&B']).toMatchObject({ kind: 'spelling', result: ['RnB'] })
  expect(plan.groups.some((g) => g.field === 'label' || g.field === 'artist')).toBe(false)
  // One-off values are flagged (their groups start unticked on screen).
  expect(byLabel['Hip Hop x Twerk'].rare).toEqual([{ value: 'Twerk', tracks: 1 }])
  expect(byLabel['Hip Hop x R&B'].rare).toEqual([])
  expect(plan.tracks).toBe(4)
})

test('a dry run reports the real counts and changes nothing', async () => {
  await seed()
  const before = await rows()
  const [plan] = await run<{ groups: Group[] }>([{ fn: 'cleanupPlan', args: [CHOICES] }])
  const selections = plan.groups.map((g) => ({ groupId: g.id, result: g.result }))
  const [summary, batches] = await run<unknown>([
    { fn: 'cleanupApply', args: [{ choices: CHOICES, selections, dryRun: true }] },
    { fn: 'cleanupBatches' }
  ])
  expect(summary).toMatchObject({
    tracks: 4,
    changes: 5,
    byField: { genre: 4, comment: 1 },
    files: 4
  })
  // findOrCreateTag title-cased the seeded value, x included.
  expect((summary as Summary).tagsDeleted).toEqual(['genre:Soul X Boogie X Jazz'])
  expect(batches).toEqual([])
  expect(await rows()).toEqual(before)
  const [rules] = await run<{ savedRules: unknown }>([{ fn: 'cleanupScan' }])
  expect(rules.savedRules).toEqual({ delimiters: {}, rewrites: {} })
})

test('apply: exact spellings, derived columns, a log, saved rules; undo puts it all back', async () => {
  await seed()
  const before = await rows()
  const [plan] = await run<{ groups: Group[] }>([{ fn: 'cleanupPlan', args: [CHOICES] }])
  // Approve all but the standalone R&B, and edit one result.
  const selections = plan.groups
    .filter((g) => g.label !== 'R&B')
    .map((g) => ({
      groupId: g.id,
      result: g.label === 'Hip Hop x Twerk' ? ['Hip Hop', 'Twerk', 'Bounce'] : g.result
    }))
  const [summary] = await run<Summary>([
    { fn: 'cleanupApply', args: [{ choices: CHOICES, selections }] }
  ])
  expect(summary).toMatchObject({ tracks: 3, changes: 4 })

  const after = await rows()
  expect(after.map((r) => r.genre)).toEqual([
    'Hip Hop | RnB',
    'Hip Hop | RnB',
    'Hip Hop | Twerk | Bounce',
    'Soul',
    'R&B' // not selected
  ])
  expect(after[2].comment).toBe('GOTOS | HEADZ')
  expect(after[0].label).toBe('Def Jam x Roc')
  expect(after[0].artist).toBe('A x B')
  expect(await genreTags(1)).toEqual(['Hip Hop', 'RnB']) // not "Rnb"

  // Rules are saved for next time: the import check sees a new combined track.
  const [scan] = await run<{ savedRules: { delimiters: Record<string, string[]> } }>([
    { fn: 'cleanupScan' }
  ])
  expect(scan.savedRules.delimiters).toEqual({ genre: [' x '] })

  // Edit one track after the cleanup: undo must leave it alone.
  await run([{ fn: 'setTagsForField', args: [2, 'genre', ['Hip Hop', 'Soul']] }])
  const [batches] = await run<{ id: string; status: string; changes: number }[]>([
    { fn: 'cleanupBatches' }
  ])
  expect(batches).toHaveLength(1)
  const [undo] = await run<{ restored: number; skipped: { trackId: number }[] }>([
    { fn: 'cleanupUndo', args: [batches[0].id] }
  ])
  // Tracks 1 and 3 (genre and comment): counted per track, not per change.
  expect(undo.restored).toBe(2)
  expect(undo.skipped.map((s) => s.trackId)).toEqual([2])

  // Tag fields as they were; updated_at moves on (undo is an edit too, and
  // syncs like one).
  const fields = (r: Row): unknown[] => [r.genre, r.comment, r.label, r.artist]
  const restored = await rows()
  expect(fields(restored[0])).toEqual(fields(before[0]))
  expect(fields(restored[2])).toEqual(fields(before[2]))
  expect(restored[1].genre).toBe('Hip Hop | Soul')
  expect(await genreTags(1)).toEqual([]) // it was column-only before
  const [again] = await probe.run([{ fn: 'cleanupUndo', args: [batches[0].id] }])
  expect(again).toMatchObject({ ok: false })
})

test('file writes: one item per file, a canary limit, and missing files left out', async () => {
  await seed()
  const [plan] = await run<{ groups: Group[] }>([{ fn: 'cleanupPlan', args: [CHOICES] }])
  const selections = plan.groups.map((g) => ({ groupId: g.id, result: g.result }))
  await run([
    { fn: 'markTrackMissing', args: ['/music/5.mp3'] },
    { fn: 'cleanupApply', args: [{ choices: CHOICES, selections }] }
  ])
  const [batches] = await run<{ id: string }[]>([{ fn: 'cleanupBatches' }])
  const id = batches[0].id
  const [all, canary] = await run<{ filepath: string; meta: Record<string, string> }[]>([
    { fn: 'cleanupFileWrites', args: [id] },
    { fn: 'cleanupFileWrites', args: [id, 2] }
  ])
  expect(all.map((i) => i.filepath)).toEqual(['/music/1.mp3', '/music/2.mp3', '/music/3.mp3'])
  expect(all[2].meta).toEqual({ genre: 'Hip Hop | Twerk', comment: 'GOTOS | HEADZ' })
  expect(canary).toHaveLength(2)
})

test('after an import, saved rules only count matching tracks; nothing is applied', async () => {
  await seed()
  const [plan] = await run<{ groups: Group[] }>([{ fn: 'cleanupPlan', args: [CHOICES] }])
  await run([
    {
      fn: 'cleanupApply',
      args: [
        {
          choices: CHOICES,
          selections: plan.groups.map((g) => ({ groupId: g.id, result: g.result }))
        }
      ]
    }
  ])
  const inserted = await run<{ lastInsertRowid: number }>([
    track(10, { genre: 'House x Dance' }),
    track(11, { genre: 'House' })
  ])
  const ids = inserted.map((r) => r.lastInsertRowid)
  const [count, all] = await run<unknown>([
    { fn: 'cleanupImportMatches', args: [ids] },
    { fn: 'getAllTracks' }
  ])
  expect(count).toBe(1)
  expect((all as Row[]).find((r) => r.id === ids[0])?.genre).toBe('House x Dance')
})

test('real file: cleaned tags reach the file, and undo puts the original back', async () => {
  test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
  test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')
  const dir = makeTempDir('deepcrated-cleanup-')
  try {
    const filepath = freshAudio(dir, 'mp3')
    await run([
      {
        fn: 'insertTrack',
        args: [
          {
            filepath,
            filename: 'a.mp3',
            title: 'A',
            genre: 'Hip Hop x Twerk',
            comment: 'GOTOS HEADZ'
          }
        ]
      },
      {
        fn: 'writeTagsForFile',
        args: [filepath, { genre: 'Hip Hop x Twerk', comment: 'GOTOS HEADZ' }]
      }
    ])
    const [plan] = await run<{ groups: Group[] }>([{ fn: 'cleanupPlan', args: [CHOICES] }])
    const selections = plan.groups.map((g) => ({ groupId: g.id, result: g.result }))
    await run([{ fn: 'cleanupApply', args: [{ choices: CHOICES, selections }] }])
    const [batches] = await run<{ id: string }[]>([{ fn: 'cleanupBatches' }])
    const id = batches[0].id

    // What the edit-tags job does with each item, then records it.
    const [items] = await run<
      { filepath: string; meta: Record<string, string>; changeIds: number[] }[]
    >([{ fn: 'cleanupFileWrites', args: [id, 3] }])
    for (const item of items) {
      const [results] = await run<{ success: boolean }[]>([
        { fn: 'writeTagsForFile', args: [item.filepath, item.meta] }
      ])
      expect(results[0].success).toBe(true)
      await run([{ fn: 'cleanupMarkFileWritten', args: [item.changeIds] }])
    }
    let tags = await readFileTags(filepath)
    expect(tags.genre).toBe('Hip Hop | Twerk')
    expect(tags.comment).toBe('GOTOS | HEADZ')

    const [undo] = await run<{ filesToRestore: number }>([{ fn: 'cleanupUndo', args: [id] }])
    expect(undo.filesToRestore).toBe(1)
    const [restores] = await run<{ filepath: string; meta: Record<string, string> }[]>([
      { fn: 'cleanupFileRestores', args: [id] }
    ])
    expect(restores).toHaveLength(1)
    await run([{ fn: 'writeTagsForFile', args: [restores[0].filepath, restores[0].meta] }])
    tags = await readFileTags(filepath)
    expect(tags.genre).toBe('Hip Hop x Twerk')
    expect(tags.comment).toBe('GOTOS HEADZ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
