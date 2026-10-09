import { test, expect } from '@playwright/test'
import {
  createArtistCleaner,
  SETTING_ENABLED,
  SETTING_SUGGEST_ONLY,
  type ArtistCleaner
} from '../../src/main/artist/service'
import type { WriteArtistFn } from '../../src/main/artist/types'
import { FakeArtistStore } from '../helpers/fakeArtistStore'

// What happens to a track when an artist name is cleaned: what is written,
// where, and — as important — what is NOT written until the DJ agrees.

interface Harness {
  store: FakeArtistStore
  cleaner: ArtistCleaner
  writes: { filepath: string; artist: string }[]
  failFor: Set<string>
}

function harness(): Harness {
  const store = new FakeArtistStore()
  // The DJ's own library: one blessed tag per artist.
  store
    .addTrack(1, null)
    .tag(1, 'NOTORIOUS B.I.G')
    .addTrack(2, null)
    .tag(2, 'JAY Z')
    .addTrack(3, null)
    .tag(3, 'AALIYAH')
  const writes: { filepath: string; artist: string }[] = []
  const failFor = new Set<string>()
  const writeArtist: WriteArtistFn = async (filepath, artist) => {
    if (failFor.has(filepath)) return { ok: false, error: 'disk is read-only' }
    writes.push({ filepath, artist })
    return { ok: true }
  }
  let n = 0
  const cleaner = createArtistCleaner(store, { writeArtist, uuid: () => `batch-${++n}` })
  return { store, cleaner, writes, failFor }
}

// ── import ────────────────────────────────────────────────────────────────

test('a high-confidence name is applied: file written, tag and column changed', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG')
  const report = await h.cleaner.processNewTracks([10])

  expect(report).toMatchObject({ tracks: 1, applied: 1, suggested: 0, failures: [] })
  expect(h.writes).toEqual([{ filepath: '/music/10.mp3', artist: 'NOTORIOUS B.I.G' }])
  expect(h.store.row(10).tags).toEqual(['NOTORIOUS B.I.G'])
  expect(h.store.row(10).artist).toBe('NOTORIOUS B.I.G')
})

test('the raw imported string is stored alongside, for "keep original"', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG')
  await h.cleaner.processNewTracks([10])
  expect(h.store.row(10).artist_raw).toBe('Notorious BIG')
})

test('the raw string is stored once and never overwritten', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG')
  await h.cleaner.processNewTracks([10])
  h.store.row(10).artist = 'something else'
  await h.cleaner.processNewTracks([10])
  expect(h.store.row(10).artist_raw).toBe('Notorious BIG')
})

test('a medium match keeps the raw name as the tag, adds a suggestion, and writes NO file', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  const report = await h.cleaner.processNewTracks([10])

  expect(report).toMatchObject({ applied: 0, suggested: 1 })
  expect(h.writes).toEqual([])
  expect(h.store.row(10).tags).toEqual(['Aliyah'])
  expect(h.store.suggestions).toMatchObject([
    { track_id: 10, raw: 'Aliyah', suggested: 'AALIYAH', confidence: 'medium', status: 'pending' }
  ])
})

test('a low or no match: raw name becomes the tag, nothing to review, nothing written', async () => {
  const h = harness()
  h.store.addTrack(10, 'Somebody Brand New')
  const report = await h.cleaner.processNewTracks([10])
  expect(report).toMatchObject({ applied: 0, suggested: 0 })
  expect(h.writes).toEqual([])
  expect(h.store.row(10).tags).toEqual(['Somebody Brand New'])
  expect(h.store.suggestions).toEqual([])
})

test('a name that already matches exactly is tagged and not rewritten', async () => {
  const h = harness()
  h.store.addTrack(10, 'JAY Z')
  const report = await h.cleaner.processNewTracks([10])
  expect(report.applied).toBe(0)
  expect(h.writes).toEqual([])
  expect(h.store.row(10).tags).toEqual(['JAY Z'])
})

test('multi-artist strings are cleaned per artist, after the " | " split', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG | Jay-Z')
  await h.cleaner.processNewTracks([10])
  expect(h.store.row(10).tags).toEqual(['NOTORIOUS B.I.G', 'JAY Z'])
  expect(h.writes[0].artist).toBe('NOTORIOUS B.I.G | JAY Z')
})

test('a comma list is one name: tagged as is, never split', async () => {
  const h = harness()
  h.store.addTrack(10, 'Tyler, The Creator')
  await h.cleaner.processNewTracks([10])
  expect(h.store.row(10).tags).toEqual(['Tyler, The Creator'])
})

test('only the part that needs it is suggested when one artist is high and one is not', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG / Aliyah')
  await h.cleaner.processNewTracks([10])
  expect(h.store.row(10).tags).toEqual(['NOTORIOUS B.I.G', 'Aliyah'])
  expect(h.store.suggestions.map((s) => s.raw)).toEqual(['Aliyah'])
})

test('a track with no artist is left alone', async () => {
  const h = harness()
  h.store.addTrack(10, null).addTrack(11, '   ')
  const report = await h.cleaner.processNewTracks([10, 11])
  expect(report.tracks).toBe(0)
  expect(h.writes).toEqual([])
})

// ── modes ─────────────────────────────────────────────────────────────────

test('suggest-only: nothing is changed automatically, even a high match goes to the inbox', async () => {
  const h = harness()
  h.store.settings.set(SETTING_SUGGEST_ONLY, 'true')
  h.store.addTrack(10, 'Notorious BIG')
  const report = await h.cleaner.processNewTracks([10])
  expect(report).toMatchObject({ applied: 0, suggested: 1 })
  expect(h.writes).toEqual([])
  expect(h.store.row(10).tags).toEqual(['Notorious BIG'])
  expect(h.store.suggestions[0]).toMatchObject({ suggested: 'NOTORIOUS B.I.G', confidence: 'high' })
})

test('auto-clean off: tags are created from the raw names and nothing is suggested', async () => {
  const h = harness()
  h.store.settings.set(SETTING_ENABLED, 'false')
  h.store.addTrack(10, 'Notorious BIG')
  const report = await h.cleaner.processNewTracks([10])
  expect(report).toMatchObject({ applied: 0, suggested: 0 })
  expect(h.writes).toEqual([])
  expect(h.store.row(10).tags).toEqual(['Notorious BIG'])
})

test('the default is auto, on', () => {
  expect(harness().cleaner.mode()).toBe('auto')
})

// ── failures ──────────────────────────────────────────────────────────────

test('a failed file write is reported, not fatal, and the original is left untouched', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG').addTrack(11, 'Aaliyah')
  h.failFor.add('/music/10.mp3')
  const notices: string[] = []
  const cleaner = createArtistCleaner(h.store, {
    writeArtist: async (filepath, artist) =>
      h.failFor.has(filepath)
        ? { ok: false, error: 'disk is read-only' }
        : (h.writes.push({ filepath, artist }), { ok: true }),
    uuid: () => 'b',
    onNotice: (m) => notices.push(m)
  })
  const report = await cleaner.processNewTracks([10, 11])

  expect(report.failures).toEqual([{ trackId: 10, error: 'disk is read-only' }])
  // The failed track keeps its original name everywhere...
  expect(h.store.row(10).tags).toEqual(['Notorious BIG'])
  expect(h.store.row(10).artist).toBe('Notorious BIG')
  // ...and is offered in the inbox so it can be retried.
  expect(h.store.suggestions).toMatchObject([{ track_id: 10, reason: 'write-failed' }])
  // The other track still went through.
  expect(h.store.row(11).tags).toEqual(['AALIYAH'])
  expect(notices).toHaveLength(1)
})

// ── the inbox: accept, edit, keep ─────────────────────────────────────────

test('accept changes every track carrying that name: file first, then the tags', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah').addTrack(11, 'Aliyah')
  await h.cleaner.processNewTracks([10, 11])
  h.writes.length = 0

  const r = await h.cleaner.acceptGroup('Aliyah')
  expect(r).toMatchObject({ applied: 2, failed: [], stale: 0 })
  expect(h.writes.map((w) => w.artist)).toEqual(['AALIYAH', 'AALIYAH'])
  expect(h.store.row(10).tags).toEqual(['AALIYAH'])
  expect(h.store.row(11).artist).toBe('AALIYAH')
  expect(h.store.suggestions.every((s) => s.status === 'accepted')).toBe(true)
})

test('accepting leaves no orphan raw tag behind', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  h.store.looseTags.add('Aliyah')
  await h.cleaner.acceptGroup('Aliyah')
  expect(h.store.allTagValues().has('Aliyah')).toBe(false)
})

test('edit applies a custom name through the tag system', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  await h.cleaner.acceptGroup('Aliyah', 'Aaliyah Haughton')
  expect(h.store.row(10).tags).toEqual(['Aaliyah Haughton'])
  expect(h.store.row(10).artist).toBe('Aaliyah Haughton')
  expect(h.store.suggestions[0].status).toBe('edited')
})

test('an empty edited name is refused', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  await expect(h.cleaner.acceptGroup('Aliyah', '   ')).rejects.toThrow()
  expect(h.store.row(10).tags).toEqual(['Aliyah'])
})

test('keep saves a rule: that exact string is never flagged again', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  expect(h.cleaner.keepGroup('Aliyah')).toEqual({ kept: 1 })
  expect(h.writes).toEqual([])
  expect(h.store.keepRules()).toEqual(['Aliyah'])

  h.store.addTrack(11, 'Aliyah')
  const report = await h.cleaner.processNewTracks([11])
  expect(report.suggested).toBe(0)
  expect(h.store.suggestions.filter((s) => s.status === 'pending')).toEqual([])
})

test('a kept name stays kept even when a tag would match it with high confidence', async () => {
  const h = harness()
  h.store.keep.add('Notorious BIG')
  h.store.addTrack(10, 'Notorious BIG')
  const report = await h.cleaner.processNewTracks([10])
  expect(report).toMatchObject({ applied: 0, suggested: 0 })
  expect(h.store.row(10).tags).toEqual(['Notorious BIG'])
})

test('a track edited since the suggestion is skipped, not overwritten', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  h.store.setArtistTags(10, ['Something The DJ Typed'])
  const r = await h.cleaner.acceptGroup('Aliyah')
  expect(r).toMatchObject({ applied: 0, stale: 1 })
  expect(h.store.row(10).tags).toEqual(['Something The DJ Typed'])
})

test('a failed write during accept leaves that track and its suggestion as they were', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah')
  await h.cleaner.processNewTracks([10])
  h.failFor.add('/music/10.mp3')
  const r = await h.cleaner.acceptGroup('Aliyah')
  expect(r.failed).toHaveLength(1)
  expect(h.store.row(10).tags).toEqual(['Aliyah'])
  expect(h.store.suggestions[0].status).toBe('pending')
})

test('a raw name waiting on a decision does not become what later imports match against', async () => {
  const h = harness()
  h.store.addTrack(10, 'Aliyah').addTrack(11, 'Aliyah')
  // Two imports of the same raw name, in separate batches.
  await h.cleaner.processNewTracks([10])
  await h.cleaner.processNewTracks([11])
  // The second is suggested too — the first one's raw tag did not make "Aliyah" canonical.
  expect(h.store.suggestions.map((s) => s.track_id).sort()).toEqual([10, 11])
  expect(h.cleaner.suggestionGroups()).toMatchObject([{ raw: 'Aliyah', trackCount: 2 }])
})

test('restore original puts the imported name back everywhere and keeps it', async () => {
  const h = harness()
  h.store.addTrack(10, 'Notorious BIG')
  await h.cleaner.processNewTracks([10])
  h.writes.length = 0

  expect(await h.cleaner.restoreOriginal(10)).toEqual({ ok: true })
  expect(h.writes).toEqual([{ filepath: '/music/10.mp3', artist: 'Notorious BIG' }])
  expect(h.store.row(10).tags).toEqual(['Notorious BIG'])
  expect(h.store.keepRules()).toContain('Notorious BIG')
})

test('restore original fails cleanly with no stored original', async () => {
  const h = harness()
  h.store.addTrack(10, 'X')
  expect((await h.cleaner.restoreOriginal(10)).ok).toBe(false)
})

// ── re-clean the existing library ─────────────────────────────────────────

function libraryWithVariants(h: Harness): void {
  // Tracks that already exist with their artist only in the column.
  h.store
    .addTrack(20, 'Notorious BIG')
    .addTrack(21, 'The Notorious B.I.G.')
    .addTrack(22, 'Aliyah')
    .addTrack(23, 'Somebody Brand New')
}

test('the preview groups changes by canonical name and tier, and writes nothing', async () => {
  const h = harness()
  libraryWithVariants(h)
  const preview = await h.cleaner.previewReclean()

  const high = preview.groups.find((g) => g.tier === 'high' && g.canonical === 'NOTORIOUS B.I.G')
  expect(high?.items.map((i) => i.raw).sort()).toEqual(['Notorious BIG', 'The Notorious B.I.G.'])
  expect(high?.trackCount).toBe(2)
  const medium = preview.groups.find((g) => g.tier === 'medium')
  expect(medium).toMatchObject({ canonical: 'AALIYAH' })
  expect(preview.byTier).toMatchObject({ high: 2, medium: 1, low: 0 })
  // Dry run: no files, no database change.
  expect(h.writes).toEqual([])
  expect(h.store.row(20).tags).toEqual([])
  expect(h.store.row(20).artist).toBe('Notorious BIG')
})

test('approve-all-high applies only the high tier, and tracks without tags get them', async () => {
  const h = harness()
  libraryWithVariants(h)
  await h.cleaner.previewReclean()
  const r = await h.cleaner.approveHigh()

  expect(r).toMatchObject({ applied: 2, failed: [], stale: 0 })
  expect(h.store.row(20).tags).toEqual(['NOTORIOUS B.I.G'])
  expect(h.store.row(21).artist).toBe('NOTORIOUS B.I.G')
  // medium and low untouched
  expect(h.store.row(22).artist).toBe('Aliyah')
  expect(h.writes).toHaveLength(2)
})

test('one level of undo restores tags, column and files for the whole batch', async () => {
  const h = harness()
  libraryWithVariants(h)
  await h.cleaner.previewReclean()
  await h.cleaner.approveHigh()
  h.writes.length = 0
  expect(h.cleaner.undoInfo()).toEqual({ available: true, tracks: 2 })

  const r = await h.cleaner.undoLastBatch()
  expect(r).toMatchObject({ applied: 2, failed: [] })
  expect(h.store.row(20).artist).toBe('Notorious BIG')
  expect(h.store.row(20).tags).toEqual([])
  expect(h.store.row(21).artist).toBe('The Notorious B.I.G.')
  expect(h.writes.map((w) => w.artist).sort()).toEqual(['Notorious BIG', 'The Notorious B.I.G.'])
  expect(h.cleaner.undoInfo().available).toBe(false)
})

test('undo restores previous tags for a track that had them', async () => {
  const h = harness()
  // As left by an import: the raw name is the tag, with a suggestion waiting.
  h.store.addTrack(30, 'Notorious BIG').tag(30, 'Notorious BIG')
  h.store.insertSuggestion({
    track_id: 30,
    raw: 'Notorious BIG',
    suggested: 'NOTORIOUS B.I.G',
    confidence: 'high',
    reason: 'normalized-tag'
  })
  await h.cleaner.previewReclean()
  await h.cleaner.approveHigh()
  expect(h.store.row(30).tags).toEqual(['NOTORIOUS B.I.G'])
  // The inbox question it answered is closed.
  expect(h.store.suggestions[0].status).toBe('accepted')
  await h.cleaner.undoLastBatch()
  expect(h.store.row(30).tags).toEqual(['Notorious BIG'])
})

test('a new batch replaces the previous undo: one level only', async () => {
  const h = harness()
  libraryWithVariants(h)
  await h.cleaner.previewReclean()
  await h.cleaner.approveHigh()
  h.store.addTrack(40, 'notorious b.i.g')
  await h.cleaner.previewReclean()
  await h.cleaner.approveHigh()
  expect(h.cleaner.undoInfo().tracks).toBe(1)
})

test('a failed write during approve leaves that track unchanged and out of the undo batch', async () => {
  const h = harness()
  libraryWithVariants(h)
  h.failFor.add('/music/20.mp3')
  await h.cleaner.previewReclean()
  const r = await h.cleaner.approveHigh()
  expect(r.failed).toEqual([{ trackId: 20, error: 'disk is read-only' }])
  expect(r.applied).toBe(1)
  expect(h.store.row(20).artist).toBe('Notorious BIG')
  expect(h.cleaner.undoInfo().tracks).toBe(1)
})

test('a failed write during undo keeps that entry so a retry can finish', async () => {
  const h = harness()
  libraryWithVariants(h)
  await h.cleaner.previewReclean()
  await h.cleaner.approveHigh()
  h.failFor.add('/music/20.mp3')
  const r = await h.cleaner.undoLastBatch()
  expect(r.failed).toHaveLength(1)
  expect(h.store.row(20).artist).toBe('NOTORIOUS B.I.G') // still agrees with its file
  expect(h.cleaner.undoInfo().tracks).toBe(1)
  h.failFor.clear()
  expect((await h.cleaner.undoLastBatch()).applied).toBe(1)
  expect(h.store.row(20).artist).toBe('Notorious BIG')
})

test('review-each sends everything the dry run found to the inbox', async () => {
  const h = harness()
  libraryWithVariants(h)
  await h.cleaner.previewReclean()
  const q = h.cleaner.queueReview()
  expect(q.tracks).toBe(3)
  expect(h.cleaner.pendingCount()).toBe(3)
  expect(h.writes).toEqual([])
})

test('a kept name is excluded from the re-clean', async () => {
  const h = harness()
  libraryWithVariants(h)
  h.store.keep.add('Notorious BIG')
  const preview = await h.cleaner.previewReclean()
  const raws = preview.groups.flatMap((g) => g.items.map((i) => i.raw))
  expect(raws).not.toContain('Notorious BIG')
})

test('progress is reported for the preview, the apply and the undo', async () => {
  const h = harness()
  libraryWithVariants(h)
  const phases: string[] = []
  const cleaner = createArtistCleaner(h.store, {
    writeArtist: async () => ({ ok: true }),
    uuid: () => 'b',
    onProgress: (p) => phases.push(p.phase)
  })
  await cleaner.previewReclean()
  await cleaner.approveHigh()
  await cleaner.undoLastBatch()
  expect(new Set(phases)).toEqual(new Set(['preview', 'apply', 'undo', 'idle']))
})
