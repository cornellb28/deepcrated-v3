import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Crate Health against the REAL db.ts schema and the REAL write paths. The
// unit specs prove each check on a fixture; this proves the counts actually
// follow a tag edit, an import and a file move, and that the real schema has
// the columns the checks read.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => {
  probe.cleanup()
})

interface Summary {
  liveTracks: number
  flaggedTracks: number
  checks: { id: string; count: number }[]
}

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

// Positional lookups break whenever a helper adds an op, so results are read
// from the end of the list instead.
function fromEnd<T>(results: unknown[], n: number): T {
  return results[results.length - n] as T
}

function counts(summary: Summary): Record<string, number> {
  return Object.fromEntries(summary.checks.map((c) => [c.id, c.count]))
}

// insertTrack does not store artwork_hash (artwork is attached separately),
// so a track with art is an insert plus setTrackArtworkHash. Tracks are
// inserted into a fresh DB, so track n has id n.
function track(n: number, extra: Record<string, unknown> = {}): ProbeOp[] {
  const { artwork_hash: artwork = `art${n}`, ...rest } = extra
  const insert: ProbeOp = {
    fn: 'insertTrack',
    args: [
      {
        filepath: `/music/House/T${n}.mp3`,
        filename: `T${n}.mp3`,
        title: `Title ${n}`,
        artist: `Artist ${n}`,
        genre: 'House',
        bpm: 120,
        key_camelot: '8A',
        file_size_bytes: 1000 + n,
        duration_sec: 100 + n * 7,
        ...rest
      }
    ]
  }
  return artwork === null
    ? [insert]
    : [insert, { fn: 'setTrackArtworkHash', args: [n, artwork as string] }]
}

const SEED: ProbeOp[] = [{ fn: 'addRoot', args: ['Library', '/music'] }]

test('every check runs on the real schema and an empty library is all zeros', async () => {
  const [summary] = await run<Summary>([{ fn: 'getHealthSummary' }])
  expect(summary.liveTracks).toBe(0)
  expect(summary.checks).toHaveLength(10)
  expect(summary.checks.every((c) => c.count === 0)).toBe(true)
})

test('an import (insert) is reflected in the counts and the queue', async () => {
  const results = await run<unknown>([
    ...SEED,
    { fn: 'getHealthSummary' },
    ...track(1, { bpm: null, artwork_hash: null }),
    ...track(2),
    { fn: 'getHealthSummary' },
    { fn: 'getHealthQueue', args: ['missing_bpm'] },
    { fn: 'getHealthQueue', args: ['missing_artwork'] }
  ])
  const before = fromEnd<Summary>(results, 7)
  const after = fromEnd<Summary>(results, 3)
  expect(before.liveTracks).toBe(0)
  expect(after.liveTracks).toBe(2)
  expect(counts(after).missing_bpm).toBe(1)
  expect(counts(after).missing_artwork).toBe(1)
  expect(fromEnd<number[]>(results, 2)).toHaveLength(1)
  expect(fromEnd<number[]>(results, 1)).toHaveLength(1)
})

test('a tag edit moves a track out of "no tags" and "missing genre"', async () => {
  const results = await run<unknown>([
    ...SEED,
    ...track(1, { genre: '', artist: '' }),
    { fn: 'getHealthSummary' },
    { fn: 'setTagsForField', args: [1, 'genre', ['Techno']] },
    { fn: 'setTagsForField', args: [1, 'artist', ['Someone']] },
    { fn: 'getHealthSummary' }
  ])
  const before = counts(fromEnd<Summary>(results, 4))
  const after = counts(fromEnd<Summary>(results, 1))
  expect(before.no_tags).toBe(1)
  expect(before.missing_genre).toBe(1)
  expect(before.missing_artist).toBe(1)
  expect(after.no_tags).toBe(0)
  expect(after.missing_genre).toBe(0)
  expect(after.missing_artist).toBe(0)
})

test('a metadata edit is reflected in the counts', async () => {
  const results = await run<unknown>([
    ...SEED,
    ...track(1, { bpm: null }),
    { fn: 'getHealthSummary' },
    { fn: 'updateTrackMeta', args: [{ id: 1, bpm: 128 }] },
    { fn: 'getHealthSummary' }
  ])
  expect(counts(fromEnd<Summary>(results, 3)).missing_bpm).toBe(1)
  expect(counts(fromEnd<Summary>(results, 1)).missing_bpm).toBe(0)
})

test('a file move keeps the track healthy; losing the file moves it to "missing file"', async () => {
  const results = await run<unknown>([
    ...SEED,
    ...track(1, { bpm: null }),
    { fn: 'updateTrackFilepath', args: ['/music/House/T1.mp3', '/music/Techno/T1.mp3'] },
    { fn: 'getHealthSummary' },
    { fn: 'markTrackMissing', args: ['/music/Techno/T1.mp3'] },
    { fn: 'getHealthSummary' },
    { fn: 'getHealthQueue', args: ['missing_file'] },
    { fn: 'relinkTrack', args: [1, '/music/Elsewhere/T1.mp3'] },
    { fn: 'getHealthSummary' }
  ])
  const moved = counts(fromEnd<Summary>(results, 6))
  expect(moved.missing_file).toBe(0)
  expect(moved.missing_bpm).toBe(1)

  const gone = fromEnd<Summary>(results, 4)
  expect(counts(gone).missing_file).toBe(1)
  // A missing file leaves every other check — it was in missing_bpm a
  // moment ago.
  expect(counts(gone).missing_bpm).toBe(0)
  expect(gone.liveTracks).toBe(0)
  expect(fromEnd<number[]>(results, 3)).toHaveLength(1)

  // Relinking brings it back under the other checks.
  const relinked = counts(fromEnd<Summary>(results, 1))
  expect(relinked.missing_file).toBe(0)
  expect(relinked.missing_bpm).toBe(1)
})

test('counts equal queue lengths for every check on the real schema', async () => {
  const checkIds = [
    'missing_artwork',
    'missing_key',
    'missing_bpm',
    'missing_genre',
    'missing_artist',
    'no_tags',
    'duplicates',
    'unreadable_audio',
    'missing_file'
  ]
  const results = await run<unknown>([
    ...SEED,
    ...track(1, { artwork_hash: null }),
    ...track(2, { key_camelot: '' }),
    ...track(3, { bpm: 0 }),
    ...track(4, { artist: 'Dup', title: 'Same' }),
    ...track(5, { artist: 'dup', title: 'same' }),
    { fn: 'markTrackMissing', args: ['/music/House/T3.mp3'] },
    { fn: 'getHealthSummary' },
    ...checkIds.map((id): ProbeOp => ({ fn: 'getHealthQueue', args: [id] }))
  ])
  const summary = fromEnd<Summary>(results, checkIds.length + 1)
  checkIds.forEach((id, i) => {
    expect(counts(summary)[id], id).toBe(fromEnd<number[]>(results, checkIds.length - i).length)
  })
  expect(counts(summary).duplicates).toBe(2)
})

test('an unknown check id is refused', async () => {
  const raw = await probe.run([{ fn: 'getHealthQueue', args: ['nope'] }])
  expect(raw[0].ok).toBe(false)
})
