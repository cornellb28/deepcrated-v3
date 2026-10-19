// ── What an analysis writes back to a track ───────────────────────────────
// Pure. Both analysis paths in index.ts (single-file and the Phase 2 batch)
// build their updateTrackMeta payload here, so there is one place that
// decides which columns analysis may touch.
//
// energy is NOT among them. It is the DJ's own rating (shared/energy.ts);
// analysis does not measure it. Both paths used to send `energy: null`,
// which updateTrackMeta writes (it skips only undefined), so every analysis
// wiped a hand-set energy.

// Values pass through exactly as given: updateTrackMeta skips undefined
// (leaves the column) and writes null (clears it), and the two call sites
// rely on that difference as they always have.
type Maybe<T> = T | null | undefined

export interface AnalysisSource {
  title: Maybe<string>
  artist: Maybe<string>
  genre: Maybe<string>
  comment: Maybe<string>
  artwork_path: Maybe<string>
}

export interface AnalysisMeasured {
  bpm: Maybe<number>
  key_camelot: Maybe<string>
}

export function analysisUpdate(
  trackId: number,
  source: AnalysisSource,
  measured: AnalysisMeasured
): Record<string, unknown> {
  return {
    id: trackId,
    title: source.title,
    artist: source.artist,
    genre: source.genre,
    bpm: measured.bpm,
    key_camelot: measured.key_camelot,
    comment: source.comment,
    artwork_path: source.artwork_path,
    needs_sync: 0,
    pending_changes: null
  }
}
