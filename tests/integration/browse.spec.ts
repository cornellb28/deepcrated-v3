import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'
import { getDimension } from '../../src/renderer/src/lib/browse/registry'
import type { BrowseContext } from '../../src/renderer/src/lib/browse/types'

// The Browse dimensions are pure functions over the renderer store, so the
// unit spec proves them on hand-made arrays. This proves them on what the
// REAL data layer hands the store — rows from db.ts (getAllTracks,
// getTrackTagsForTracks) after the real write paths run — so a column or
// shape difference between the fixture and the database cannot hide.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => {
  probe.cleanup()
})

function track(n: number, extra: Record<string, unknown> = {}): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [
      {
        filepath: `/music/House/T${n}.mp3`,
        filename: `T${n}.mp3`,
        title: `Title ${n}`,
        artist: `Artist ${n}`,
        file_size_bytes: 1000 + n,
        duration_sec: 100 + n,
        ...extra
      }
    ]
  }
}

const SEED: ProbeOp[] = [{ fn: 'addRoot', args: ['Library', '/music'] }]

// Reads the library the way App.tsx does at startup, then builds the same
// context the store would hold.
async function snapshot(ops: ProbeOp[]): Promise<BrowseContext> {
  // Two passes: the tag query needs the track ids, which only exist once the
  // tracks do.
  const trackOps: ProbeOp[] = [...ops, { fn: 'getAllTracks' }]
  const results = unwrap<unknown>(await probe.run(trackOps), trackOps)
  const tracks = results[results.length - 1] as Track[]

  const tagOps: ProbeOp[] = [{ fn: 'getTrackTagsForTracks', args: [tracks.map((t) => t.id)] }]
  const [byTrack] = unwrap<Record<string, Tag[]>>(await probe.run(tagOps), tagOps)
  const trackTags = new Map<number, Tag[]>(
    Object.entries(byTrack).map(([id, tags]) => [Number(id), tags])
  )
  return { tracks, trackTags }
}

function count(ctx: BrowseContext, dimension: string, label: string): number | undefined {
  return getDimension(dimension)!
    .values(ctx)
    .find((v) => v.label === label)?.count
}

test('real rows: artists group case-insensitively and split on " / " only', async () => {
  const ctx = await snapshot([
    ...SEED,
    track(1, { artist: 'Aaliyah' }),
    track(2, { artist: 'aaliyah ' }),
    track(3, { artist: 'Foxy Brown / Dru Hill' }),
    track(4, { artist: 'AC/DC' }),
    track(5, { artist: '' })
  ])
  expect(count(ctx, 'artist', 'Aaliyah')).toBe(2)
  expect(count(ctx, 'artist', 'Foxy Brown')).toBe(1)
  expect(count(ctx, 'artist', 'Dru Hill')).toBe(1)
  expect(count(ctx, 'artist', 'AC/DC')).toBe(1)
  expect(count(ctx, 'artist', 'No artist')).toBe(1)
})

test('real rows: every count equals the list it opens, in every dimension', async () => {
  const ctx = await snapshot([
    ...SEED,
    track(1, { artist: 'A / B' }),
    track(2, { artist: 'a' }),
    track(3, { artist: '' }),
    { fn: 'setTagsForField', args: [1, 'genre', ['House', 'Techno']] },
    { fn: 'setTagsForField', args: [2, 'genre', ['House']] },
    { fn: 'setTagsForField', args: [2, 'comment', ['DARK']] }
  ])
  for (const id of ['genre', 'tags', 'artist']) {
    const d = getDimension(id)!
    for (const v of d.values(ctx)) {
      expect(d.tracksFor(ctx, v.key), `${id}/${v.label}`).toHaveLength(v.count)
    }
  }
  expect(count(ctx, 'genre', 'House')).toBe(2)
  expect(count(ctx, 'genre', 'No genre')).toBe(1)
  expect(count(ctx, 'tags', 'Untagged')).toBe(1)
})

test('real rows: a tag edit moves a track out of Untagged', async () => {
  const before = await snapshot([...SEED, track(1), track(2)])
  expect(count(before, 'tags', 'Untagged')).toBe(2)

  probe.cleanup()
  probe = createProbeSession()
  const after = await snapshot([
    ...SEED,
    track(1),
    track(2),
    { fn: 'setTagsForField', args: [1, 'genre', ['House']] }
  ])
  expect(count(after, 'tags', 'Untagged')).toBe(1)
  expect(count(after, 'genre', 'House')).toBe(1)
})

test('real rows: an import adds to its artist, a file move changes nothing, a missing file stays listed', async () => {
  const base: ProbeOp[] = [...SEED, track(1, { artist: 'Same' })]
  const one = await snapshot(base)
  expect(count(one, 'artist', 'Same')).toBe(1)

  // Import (insert) a second track by the same artist.
  probe.cleanup()
  probe = createProbeSession()
  const imported = await snapshot([...base, track(2, { artist: 'Same' })])
  expect(count(imported, 'artist', 'Same')).toBe(2)

  // Move one file, mark the other missing: counts are unchanged and the
  // missing track is still in the list, as the genre and tag views keep it.
  probe.cleanup()
  probe = createProbeSession()
  const moved = await snapshot([
    ...base,
    track(2, { artist: 'Same' }),
    { fn: 'updateTrackFilepath', args: ['/music/House/T1.mp3', '/music/Techno/T1.mp3'] },
    { fn: 'markTrackMissing', args: ['/music/House/T2.mp3'] }
  ])
  expect(count(moved, 'artist', 'Same')).toBe(2)
  const artist = getDimension('artist')!
  const key = artist.values(moved).find((v) => v.label === 'Same')!.key
  const listed = artist.tracksFor(moved, key)
  expect(listed.some((t) => t.missing === 1)).toBe(true)
})
