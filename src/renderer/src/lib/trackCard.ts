// ── Track card shaping ────────────────────────────────────────────────────
// Shared sizing plus the small pure bits behind the index-card layout. Kept
// out of the component so the four grids that render TrackCard cannot drift
// into different column widths, and so the field logic can be tested.

// Wide enough that the card reads as a landscape index card rather than a
// tile: two per row on a smaller window, three on a maximised one, four on
// a very wide display. Letting a card stretch to fill the row instead
// would give 600px-wide cards with the right half empty, which is worse
// than adding a column.
export const TRACK_CARD_MIN_WIDTH = 380
// At one column the grid cell is the whole content area, and a 1300px-wide
// card is mostly empty space to the right of the text. Capping it keeps the
// index-card proportion on a narrow window; at two or three columns the
// cell is already narrower than this, so the cap never applies.
export const TRACK_CARD_MAX_WIDTH = 560
export const TRACK_CARD_HEIGHT = 164
export const TRACK_CARD_PADDING = 12
export const TRACK_GRID_GAP = 12

// The artwork is the card's full inner height, so the left column has no
// dead space under it and the card reads as a photo beside its caption.
export const TRACK_CARD_ARTWORK = TRACK_CARD_HEIGHT - TRACK_CARD_PADDING * 2

export const trackGridColumns = `repeat(auto-fill, minmax(${TRACK_CARD_MIN_WIDTH}px, 1fr))`

// The `format` column is populated for none of the library in practice, so
// the extension is the honest source. Upper-cased because it reads as a
// badge, not a filename.
export function fileFormat(filepath: string | null | undefined): string | null {
  if (!filepath) return null
  const cut = filepath.lastIndexOf('.')
  if (cut <= filepath.lastIndexOf('/')) return null
  const ext = filepath.slice(cut + 1).toUpperCase()
  return ext.length > 0 && ext.length <= 5 ? ext : null
}

// analyze.py stores duration_str already formatted; the seconds column is
// the fallback for rows that predate it.
export function trackDuration(track: {
  duration_str?: string | null
  duration_sec?: number | null
}): string | null {
  if (track.duration_str) return track.duration_str
  const seconds = track.duration_sec
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Album, year, genre and label are each missing on most of a real library,
// so they are joined into one flowing line rather than laid out as a table
// that would be mostly empty cells. Empty strings count as missing: the
// schema defaults several of these to '' rather than NULL.
export function trackMetaParts(track: {
  album?: string | null
  year?: string | null
  genre?: string | null
  label?: string | null
}): string[] {
  return [track.album, track.year, track.genre, track.label]
    .map((value) => (typeof value === 'string' ? value.trim() : value))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export interface TrackStat {
  value: string
  label: string
  color: string
}

// The four a DJ reads first. Absent ones are dropped rather than shown as
// a dash — see isAnalysed for the case where the important two are missing
// and the card says so instead.
export function trackStats(track: {
  bpm?: number | null
  key_camelot?: string | null
  energy?: number | null
  duration_str?: string | null
  duration_sec?: number | null
  filepath?: string | null
}): TrackStat[] {
  const stats: TrackStat[] = []
  if (track.bpm) stats.push({ value: String(track.bpm), label: 'BPM', color: '#5d9fd8' })
  if (track.key_camelot) stats.push({ value: track.key_camelot, label: 'KEY', color: '#3db88a' })
  if (track.energy) stats.push({ value: String(track.energy), label: 'NRG', color: '#d4537e' })
  const duration = trackDuration(track)
  if (duration) stats.push({ value: duration, label: 'TIME', color: '#8a8aa0' })
  const format = fileFormat(track.filepath)
  if (format) stats.push({ value: format, label: 'FILE', color: '#6a6a80' })
  return stats
}

// "Has the thing a DJ actually needs." A track with neither tempo nor key
// is worth flagging on the card, because it is the one state the DJ can do
// something about.
export function isAnalysed(track: { bpm?: number | null; key_camelot?: string | null }): boolean {
  return Boolean(track.bpm) || Boolean(track.key_camelot)
}

// ── Re-analysis progress ──────────────────────────────────────────────────
// A re-analysis is one blocking sidecar call of a few seconds, so the card
// shows a bar along its bottom edge while it runs. analyze.py reports the
// stage it is in (see its _emit_progress) and these turn that into the two
// things the bar needs: a width and something to call the current stage.

export const ANALYSIS_STAGE_LABELS: Record<TrackAnalysisProgress['stage'], string> = {
  queued: 'Starting analysis',
  tags: 'Reading tags',
  decode: 'Decoding audio',
  bpm: 'Detecting tempo',
  key: 'Detecting key',
  artwork: 'Reading artwork',
  done: 'Finishing up'
}

// `step` counts stages finished, so this is a real fraction rather than a
// timer — and because the stages are wildly unequal in duration (decode is
// most of the wall clock), the bar jumps rather than creeping. Clamped both
// ways so a payload from a future sidecar with a different stage count can
// never produce a bar wider than the card or a negative width.
export function analysisPercent(progress: { step: number; steps: number }): number {
  const { step, steps } = progress
  if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((step / steps) * 100)))
}
