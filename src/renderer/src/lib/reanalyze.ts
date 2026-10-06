// ── Re-analysing tracks ───────────────────────────────────────────────────
// One place for "run the sidecar over this track and write what comes back",
// shared by the single-track menu item and the bulk bar so the two cannot
// drift over which columns a re-analysis is allowed to touch. The pieces with
// no store dependency live in bulkAnalysis.ts, where a unit test can reach
// them; this module is the wiring.

import { useLibraryStore } from '../store/useLibraryStore'
import {
  ANALYSIS_STEPS,
  REANALYZE_CONCURRENCY,
  runPool,
  type ReanalyzeOutcome,
  type ReanalyzeTally
} from './bulkAnalysis'

export { reanalyzeSummary, type ReanalyzeTally } from './bulkAnalysis'

// Analyses one track and writes the result to its row. The track is read out
// of the store here rather than passed in, so a bulk run that takes minutes
// cannot write back a snapshot taken before it started.
//
// Only the fields the analysis actually produces are sent to updateTrackMeta,
// which merges — passing the whole row back would risk overwriting a tag edit
// the user made while this was running.
export async function reanalyzeTrack(trackId: number): Promise<ReanalyzeOutcome> {
  const track = useLibraryStore.getState().tracks.find((t) => t.id === trackId)
  if (!track?.filepath || track.missing) return 'skipped'

  // Show the bar on the card straight away — Python takes a moment to boot
  // before it reports its first stage, and an action that appears to do
  // nothing for a second reads as a broken one. Passing the id is what turns
  // the stage events on.
  useLibraryStore
    .getState()
    .setTrackAnalysis(trackId, { stage: 'queued', step: 0, steps: ANALYSIS_STEPS })

  try {
    const result = await window.api.analyzeFile(track.filepath, trackId)
    if (!result.ok || !result.data) return 'failed'

    const { bpm, key_camelot, key_full, duration_sec, duration_str } = result.data

    // TODO(cratecloud): duration_sec/duration_str are shown but not saved —
    // neither is in db.ts's UPDATABLE_TRACK_FIELDS, so a re-analysed duration
    // survives in the UI until the next launch and no further.
    useLibraryStore
      .getState()
      .updateTrack(trackId, { bpm, key_camelot, key_full, duration_sec, duration_str })

    const saved = await window.api.db.updateTrackMeta({ id: trackId, bpm, key_camelot, key_full })
    if (!saved.ok) return 'failed'

    await window.api.db.markAnalyzed(trackId)
    return 'ok'
  } catch {
    return 'failed'
  } finally {
    // Whatever happened, the card must not keep a progress bar on it.
    useLibraryStore.getState().clearTrackAnalysis(trackId)
  }
}

// Bulk version. Reports after each track so the caller can show a count, and
// takes shouldStop so a long run can be abandoned without waiting it out.
export async function reanalyzeTracks(
  trackIds: number[],
  options: {
    onSettled?: (tally: ReanalyzeTally) => void
    shouldStop?: () => boolean
  } = {}
): Promise<ReanalyzeTally> {
  const tally: ReanalyzeTally = { ok: 0, failed: 0, skipped: 0, stopped: false }

  const { stopped } = await runPool(
    trackIds,
    REANALYZE_CONCURRENCY,
    async (trackId) => {
      const outcome = await reanalyzeTrack(trackId)
      tally[outcome] += 1
      options.onSettled?.({ ...tally })
    },
    options.shouldStop
  )

  tally.stopped = stopped
  return tally
}
