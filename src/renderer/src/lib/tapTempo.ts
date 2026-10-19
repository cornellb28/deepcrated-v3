// ── Tap tempo: the math ───────────────────────────────────────────────────
// Pure, no React and no clock of its own: callers pass performance.now()
// timestamps in, so the tests drive it with plain numbers.
//
// The tempo is the average of the last few intervals between taps. A pause
// longer than RESET_MS starts over; an interval that could not be a tempo in
// range is ignored (a double-press) or starts a new run (a long gap); and a
// tap far off the running average starts a new run from the previous tap, so
// changing your mind about the tempo does not have to wait for a reset.

export const TAP_TEMPO = {
  MIN_BPM: 40,
  MAX_BPM: 300,
  // Taps further apart than this start a new run.
  RESET_MS: 2000,
  // Intervals averaged.
  MAX_INTERVALS: 8,
  // An interval this far (as a fraction) from the running average is a new
  // tempo, not a wobble in the old one.
  OUTLIER_RATIO: 0.5
} as const

const MIN_INTERVAL_MS = 60000 / TAP_TEMPO.MAX_BPM // 200 ms
const MAX_INTERVAL_MS = 60000 / TAP_TEMPO.MIN_BPM // 1500 ms

export interface TapState {
  // Timestamps of the current run, oldest first, at most MAX_INTERVALS + 1.
  taps: number[]
}

export const EMPTY_TAPS: TapState = { taps: [] }

export function clampBpm(bpm: number): number {
  return Math.min(TAP_TEMPO.MAX_BPM, Math.max(TAP_TEMPO.MIN_BPM, bpm))
}

// To one decimal, as analysed tempos are stored.
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function tapBpm(state: TapState): number | null {
  const { taps } = state
  if (taps.length < 2) return null
  const span = taps[taps.length - 1] - taps[0]
  const mean = span / (taps.length - 1)
  return round1(clampBpm(60000 / mean))
}

// One tap at `now`. Returns the new state and the tempo so far (null until
// the second tap of a run).
export function tap(state: TapState, now: number): { state: TapState; bpm: number | null } {
  const taps = state.taps
  const last = taps[taps.length - 1]
  if (last === undefined) return { state: { taps: [now] }, bpm: null }

  const interval = now - last
  // Too close: a bounce or double-press. Ignore it, keep the run.
  if (interval < MIN_INTERVAL_MS) return { state, bpm: tapBpm(state) }
  // Too far: the old run is over.
  if (interval > MAX_INTERVAL_MS || interval > TAP_TEMPO.RESET_MS) {
    return { state: { taps: [now] }, bpm: null }
  }
  // A clear change of tempo: start again from the previous tap.
  if (taps.length >= 3) {
    const mean = (last - taps[0]) / (taps.length - 1)
    if (Math.abs(interval - mean) > mean * TAP_TEMPO.OUTLIER_RATIO) {
      const next = { taps: [last, now] }
      return { state: next, bpm: tapBpm(next) }
    }
  }
  const next = { taps: [...taps, now].slice(-(TAP_TEMPO.MAX_INTERVALS + 1)) }
  return { state: next, bpm: tapBpm(next) }
}

// Whether the run has gone quiet long enough that the next tap starts over.
export function isStale(state: TapState, now: number): boolean {
  const last = state.taps[state.taps.length - 1]
  return last !== undefined && now - last > TAP_TEMPO.RESET_MS
}

// A held key repeats; only the first press is a tap.
export function acceptsTapKey(event: { repeat: boolean }): boolean {
  return !event.repeat
}

// Half and double time, kept in range (a 280 tapped as double stays 300).
export function halfTime(bpm: number): number {
  return round1(clampBpm(bpm / 2))
}

export function doubleTime(bpm: number): number {
  return round1(clampBpm(bpm * 2))
}
