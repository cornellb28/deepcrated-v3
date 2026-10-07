// ── Artist-name cleanup: the service ──────────────────────────────────────
// Decides what to do with the engine's answers, and does it through the tag
// system: tags stay the source of truth, tracks.artist is regenerated from
// them (setArtistTags), and the audio file is written through the existing
// sidecar (writeArtist) BEFORE the database changes, so a failed write leaves
// the track exactly as it was.
//
// Nothing here touches Electron or SQLite directly; both are injected.

import {
  cleanArtistString,
  createArtistIndex,
  isChange,
  type ArtistIndex,
  type CleanResult
} from './clean'
import { buildRecleanPreview, type RecleanPreview, type RecleanTrack } from './reclean'
import { joinValues, splitValue } from '../tagFields'
import type { ArtistStore, SuggestionGroup, WriteArtistFn } from './types'

export const SETTING_ENABLED = 'artist_clean_enabled' // anything but 'false' = on
export const SETTING_SUGGEST_ONLY = 'artist_clean_suggest_only' // 'true' = never auto-apply

export type CleanMode = 'off' | 'auto' | 'suggest'

export type { WriteArtistResult } from './types'

export interface Failure {
  trackId: number
  error: string
}

export interface ImportReport {
  tracks: number
  applied: number // tracks whose artist was changed automatically
  suggested: number // suggestions added to the inbox
  failures: Failure[]
}

export interface ApplyReport {
  applied: number
  failed: Failure[]
  stale: number
}

export interface UndoInfo {
  available: boolean
  tracks: number
}

export interface CleanerDeps {
  writeArtist: WriteArtistFn
  uuid: () => string
  onNotice?: (message: string) => void
  onProgress?: (p: {
    phase: 'preview' | 'apply' | 'undo' | 'idle'
    done: number
    total: number
  }) => void
}

const APPLY_CONCURRENCY = 3

async function mapPool<T>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

export interface ArtistCleaner {
  mode(): CleanMode
  processNewTracks(trackIds: readonly number[]): Promise<ImportReport>
  suggestionGroups(): SuggestionGroup[]
  pendingCount(): number
  acceptGroup(raw: string, customName?: string): Promise<ApplyReport>
  keepGroup(raw: string): { kept: number }
  restoreOriginal(trackId: number): Promise<{ ok: boolean; error?: string }>
  previewReclean(): Promise<RecleanPreview>
  lastPreview(): RecleanPreview | null
  approveHigh(): Promise<ApplyReport & { batchId: string }>
  queueReview(): { tracks: number }
  undoLastBatch(): Promise<ApplyReport>
  undoInfo(): UndoInfo
}

export function createArtistCleaner(store: ArtistStore, deps: CleanerDeps): ArtistCleaner {
  let preview: RecleanPreview | null = null

  function mode(): CleanMode {
    if (store.getSetting(SETTING_ENABLED) === 'false') return 'off'
    return store.getSetting(SETTING_SUGGEST_ONLY) === 'true' ? 'suggest' : 'auto'
  }

  function buildIndex(): ArtistIndex {
    return createArtistIndex({
      tags: store.artistTagPool(),
      library: store.librarySpellings(),
      keepRules: new Set(store.keepRules())
    })
  }

  // The artist names a track currently has: its artist tags, or — for a track
  // that has none yet — its artist column split the way the library splits it.
  function currentParts(trackId: number): string[] {
    const tags = store.getArtistTagValues(trackId)
    if (tags.length > 0) return tags
    return splitValue('artist', store.getTrack(trackId)?.artist)
  }

  const dedupe = (values: string[]): string[] => [...new Set(values)]

  // ── import ──────────────────────────────────────────────────────────────

  async function processNewTracks(trackIds: readonly number[]): Promise<ImportReport> {
    const report: ImportReport = { tracks: 0, applied: 0, suggested: 0, failures: [] }
    const m = mode()
    const index = buildIndex()

    for (const id of trackIds) {
      const track = store.getTrack(id)
      if (!track || !track.artist || track.artist.trim() === '') continue
      report.tracks++

      // The original, kept once: "keep original" must always be possible.
      store.setArtistRawIfNull(id, track.artist)

      const parts = splitValue('artist', track.artist)
      if (parts.length === 0) continue

      let values = parts
      const suggestions: { raw: string; result: CleanResult; reason?: 'write-failed' }[] = []

      if (m !== 'off') {
        const cleaned = cleanArtistString(track.artist, index).parts
        values = cleaned.map((r) =>
          m === 'auto' && r.confidence === 'high' && isChange(r) ? r.canonical : r.raw.trim()
        )
        cleaned.forEach((r, i) => {
          if (isChange(r) && values[i] !== r.canonical) {
            suggestions.push({ raw: r.raw.trim(), result: r })
          }
        })
      }

      const autoChanged = values.some((v, i) => v !== parts[i])
      if (autoChanged) {
        // File first. If it cannot be written the track keeps its original
        // name and the change is offered in the inbox instead.
        const written = await deps.writeArtist(track.filepath, joinValues(values) as string)
        if (!written.ok) {
          report.failures.push({ trackId: id, error: written.error })
          parts.forEach((p, i) => {
            if (values[i] !== p) {
              const r = cleanArtistString(p, index).parts[0]
              suggestions.push({ raw: p, result: r, reason: 'write-failed' })
            }
          })
          values = parts
        } else {
          report.applied++
        }
      }

      store.transaction(() => {
        store.setArtistTags(id, values)
        for (const s of suggestions) {
          store.insertSuggestion({
            track_id: id,
            raw: s.raw,
            suggested: s.result.canonical,
            confidence: s.result.confidence,
            reason: s.reason ?? s.result.reason
          })
        }
      })
      report.suggested += suggestions.length

      // Only names that were actually chosen join the pool for the rest of
      // this batch — a raw name still waiting on a decision does not.
      const pending = new Set(suggestions.map((s) => s.raw))
      for (const v of values) if (!pending.has(v)) index.addTag(v)
    }

    if (report.failures.length > 0) {
      deps.onNotice?.(
        `${report.failures.length} artist name${report.failures.length === 1 ? '' : 's'} could not be written to the file and ${report.failures.length === 1 ? 'was' : 'were'} left as imported.`
      )
    }
    return report
  }

  // ── the inbox ───────────────────────────────────────────────────────────

  // Applies one replacement to one track: file first, then the tags.
  async function applyReplacement(
    trackId: number,
    from: string,
    toValues: string[],
    onDone?: (ctx: { prevColumn: string | null; prevTags: string[]; fileWritten: boolean }) => void
  ): Promise<'applied' | 'stale' | { error: string }> {
    const current = currentParts(trackId)
    if (!current.includes(from)) return 'stale'
    const next = dedupe(current.flatMap((v) => (v === from ? toValues : [v])))
    const track = store.getTrack(trackId)
    if (!track) return 'stale'

    const prevColumn = track.artist
    const prevTags = store.getArtistTagValues(trackId)
    const written = await deps.writeArtist(track.filepath, joinValues(next) as string)
    if (!written.ok) return { error: written.error }
    store.transaction(() => {
      store.setArtistTags(trackId, next)
    })
    onDone?.({ prevColumn, prevTags, fileWritten: true })
    return 'applied'
  }

  async function acceptGroup(raw: string, customName?: string): Promise<ApplyReport> {
    const rows = store.pendingForRaw(raw)
    const report: ApplyReport = { applied: 0, failed: [], stale: 0 }
    if (rows.length === 0) return report

    const target = (customName ?? rows[0].suggested).trim()
    const toValues = splitValue('artist', target)
    if (toValues.length === 0) throw new Error('A name is required')

    await mapPool(rows, APPLY_CONCURRENCY, async (row) => {
      const outcome = await applyReplacement(row.track_id, raw, toValues)
      if (outcome === 'applied') {
        store.setSuggestionStatus([row.id], customName !== undefined ? 'edited' : 'accepted')
        report.applied++
      } else if (outcome === 'stale') {
        // The track's artist changed since the suggestion was made.
        store.setSuggestionStatus([row.id], 'dismissed')
        report.stale++
      } else {
        report.failed.push({ trackId: row.track_id, error: outcome.error })
      }
    })
    // The raw tag may now be on no track at all.
    if (report.failed.length === 0) store.deleteOrphanArtistTag(raw)
    return report
  }

  function keepGroup(raw: string): { kept: number } {
    const rows = store.pendingForRaw(raw)
    store.transaction(() => {
      // Saved first: from here on this exact string is never flagged again.
      store.addKeepRule(raw)
      store.setSuggestionStatus(
        rows.map((r) => r.id),
        'kept'
      )
    })
    return { kept: rows.length }
  }

  async function restoreOriginal(trackId: number): Promise<{ ok: boolean; error?: string }> {
    const track = store.getTrack(trackId)
    if (!track || !track.artist_raw)
      return { ok: false, error: 'No original artist is stored for this track' }
    const rawParts = splitValue('artist', track.artist_raw)
    if (rawParts.length === 0)
      return { ok: false, error: 'No original artist is stored for this track' }
    const written = await deps.writeArtist(track.filepath, joinValues(rawParts) as string)
    if (!written.ok) return { ok: false, error: written.error }
    store.transaction(() => {
      store.setArtistTags(trackId, rawParts)
      // The DJ chose the original, so it is not proposed again.
      for (const p of rawParts) store.addKeepRule(p)
    })
    return { ok: true }
  }

  // ── re-clean the existing library ───────────────────────────────────────

  async function previewReclean(): Promise<RecleanPreview> {
    deps.onProgress?.({ phase: 'preview', done: 0, total: 0 })
    const tracks: RecleanTrack[] = store.liveTracksWithArtist().map((t) => ({
      id: t.id,
      parts: t.tagValues.length > 0 ? t.tagValues : splitValue('artist', t.artistColumn)
    }))
    const result = await buildRecleanPreview(tracks, buildIndex(), {
      onProgress: (done, total) => deps.onProgress?.({ phase: 'preview', done, total })
    })
    preview = result
    deps.onProgress?.({ phase: 'idle', done: tracks.length, total: tracks.length })
    return result
  }

  async function approveHigh(): Promise<ApplyReport & { batchId: string }> {
    if (!preview) await previewReclean()
    const groups = (preview as RecleanPreview).groups.filter((g) => g.tier === 'high')
    const batchId = deps.uuid()
    const report: ApplyReport & { batchId: string } = { applied: 0, failed: [], stale: 0, batchId }

    // A new batch replaces the previous one: undo is one level deep.
    store.journalClear()

    const jobs: { trackId: number; raw: string; canonical: string }[] = []
    for (const g of groups) {
      for (const item of g.items) {
        for (const trackId of item.trackIds)
          jobs.push({ trackId, raw: item.raw, canonical: g.canonical })
      }
    }

    let done = 0
    deps.onProgress?.({ phase: 'apply', done, total: jobs.length })
    await mapPool(jobs, APPLY_CONCURRENCY, async (job) => {
      const outcome = await applyReplacement(
        job.trackId,
        job.raw,
        splitValue('artist', job.canonical),
        (ctx) =>
          store.journalAppend({
            batch_id: batchId,
            track_id: job.trackId,
            prev_column: ctx.prevColumn,
            prev_tags: ctx.prevTags,
            file_written: ctx.fileWritten
          })
      )
      if (outcome === 'applied') {
        report.applied++
        // If the inbox was already asking about this name on this track, the
        // question has been answered.
        const asked = store
          .pendingForRaw(job.raw)
          .filter((row) => row.track_id === job.trackId)
          .map((row) => row.id)
        if (asked.length > 0) store.setSuggestionStatus(asked, 'accepted')
      } else if (outcome === 'stale') report.stale++
      else report.failed.push({ trackId: job.trackId, error: outcome.error })
      deps.onProgress?.({ phase: 'apply', done: ++done, total: jobs.length })
    })
    for (const g of groups) for (const item of g.items) store.deleteOrphanArtistTag(item.raw)

    preview = null // what it described has changed
    deps.onProgress?.({ phase: 'idle', done, total: jobs.length })
    return report
  }

  // "Review each": everything the dry run found goes to the inbox, to be
  // accepted, edited or kept one name at a time.
  function queueReview(): { tracks: number } {
    if (!preview) return { tracks: 0 }
    const seen = new Set<number>()
    store.transaction(() => {
      for (const g of (preview as RecleanPreview).groups) {
        for (const item of g.items) {
          for (const trackId of item.trackIds) {
            store.insertSuggestion({
              track_id: trackId,
              raw: item.raw,
              suggested: g.canonical,
              confidence: g.tier,
              reason: item.reason
            })
            seen.add(trackId)
          }
        }
      }
    })
    return { tracks: seen.size }
  }

  async function undoLastBatch(): Promise<ApplyReport> {
    const entries = store.journalAll()
    const report: ApplyReport = { applied: 0, failed: [], stale: 0 }
    if (entries.length === 0) return report

    const failedEntries: typeof entries = []
    let done = 0
    deps.onProgress?.({ phase: 'undo', done, total: entries.length })
    await mapPool(entries, APPLY_CONCURRENCY, async (entry) => {
      const track = store.getTrack(entry.track_id)
      if (!track) {
        report.stale++
      } else {
        // File first, as everywhere: if the original cannot be put back, the
        // database keeps agreeing with the file.
        let ok = true
        if (entry.file_written && entry.prev_column) {
          const written = await deps.writeArtist(track.filepath, entry.prev_column)
          if (!written.ok) {
            ok = false
            report.failed.push({ trackId: entry.track_id, error: written.error })
            failedEntries.push(entry)
          }
        }
        if (ok) {
          store.transaction(() => {
            if (entry.prev_tags.length > 0) {
              store.setArtistTags(entry.track_id, entry.prev_tags)
            } else {
              store.setArtistTags(entry.track_id, [])
              store.setTrackArtistColumn(entry.track_id, entry.prev_column)
            }
          })
          report.applied++
        }
      }
      deps.onProgress?.({ phase: 'undo', done: ++done, total: entries.length })
    })

    // Entries that could not be undone stay, so a retry can finish the job.
    store.journalClear()
    for (const e of failedEntries) store.journalAppend(e)
    preview = null
    deps.onProgress?.({ phase: 'idle', done, total: entries.length })
    return report
  }

  return {
    mode,
    processNewTracks,
    suggestionGroups: () => store.pendingGroups(),
    pendingCount: () => store.pendingCount(),
    acceptGroup,
    keepGroup,
    restoreOriginal,
    previewReclean,
    lastPreview: () => preview,
    approveHigh,
    queueReview,
    undoLastBatch,
    undoInfo: () => {
      const entries = store.journalAll()
      return { available: entries.length > 0, tracks: entries.length }
    }
  }
}
