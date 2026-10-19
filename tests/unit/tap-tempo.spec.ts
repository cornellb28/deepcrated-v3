import { test, expect } from '@playwright/test'
import {
  EMPTY_TAPS,
  TAP_TEMPO,
  acceptsTapKey,
  doubleTime,
  halfTime,
  isStale,
  tap,
  type TapState
} from '../../src/renderer/src/lib/tapTempo'

// Tap tempo math (src/renderer/src/lib/tapTempo.ts).

function run(
  times: number[],
  start: TapState = EMPTY_TAPS
): { state: TapState; bpm: number | null }[] {
  const out: { state: TapState; bpm: number | null }[] = []
  let state = start
  for (const t of times) {
    const r = tap(state, t)
    out.push(r)
    state = r.state
  }
  return out
}

const every = (ms: number, n: number, from = 1000): number[] =>
  Array.from({ length: n }, (_, i) => from + i * ms)

test('a tempo appears from the second tap', () => {
  const r = run(every(500, 2)) // 120 BPM
  expect(r[0].bpm).toBeNull()
  expect(r[1].bpm).toBe(120)
})

test('averages the last intervals, so one shaky tap barely moves it', () => {
  // 128 BPM is 468.75 ms; one tap 30 ms late.
  const times = every(468.75, 9)
  times[5] += 30
  const r = run(times)
  expect(r[8].bpm).toBeCloseTo(128, 0)
  // Only the last MAX_INTERVALS intervals are kept.
  expect(r[8].state.taps).toHaveLength(TAP_TEMPO.MAX_INTERVALS + 1)
  const longer = run(every(468.75, 20))
  expect(longer[19].state.taps).toHaveLength(TAP_TEMPO.MAX_INTERVALS + 1)
})

test('a pause of more than RESET_MS starts a new run', () => {
  const first = run(every(500, 4))
  const after = tap(first[3].state, 1000 + 3 * 500 + TAP_TEMPO.RESET_MS + 1)
  expect(after.bpm).toBeNull()
  expect(after.state.taps).toHaveLength(1)
  expect(isStale(first[3].state, 2500 + TAP_TEMPO.RESET_MS + 1)).toBe(true)
  expect(isStale(first[3].state, 2600)).toBe(false)
})

test('nonsense intervals: a double-press is ignored, a too-slow gap restarts', () => {
  const r = run([1000, 1500, 1520]) // 20 ms bounce
  expect(r[2].bpm).toBe(120)
  expect(r[2].state.taps).toEqual([1000, 1500])
  // 1.8 s apart is under 40 BPM: not a tempo in range, so a fresh start.
  const slow = run([1000, 2800])
  expect(slow[1].bpm).toBeNull()
})

test('a clear change of tempo starts again from the previous tap', () => {
  const steady = run(every(500, 5)) // 120
  const last = steady[4].state.taps[4]
  // 240 ms is more than half off the 500 ms average: a new tempo (250).
  const faster = run([last + 240, last + 480], steady[4].state)
  expect(faster[0].state.taps).toEqual([last, last + 240])
  expect(faster[1].bpm).toBe(250)
  // Within half of the average is a wobble: still one run.
  const wobble = tap(steady[4].state, last + 400)
  expect(wobble.state.taps).toHaveLength(6)
})

test('clamped to the sane range', () => {
  // 210 ms apart is about 286 BPM: in range, unclamped.
  expect(run([0, 210])[1].bpm).toBeCloseTo(285.7, 1)
  expect(halfTime(60)).toBe(TAP_TEMPO.MIN_BPM)
  expect(doubleTime(200)).toBe(TAP_TEMPO.MAX_BPM)
})

test('half and double time', () => {
  expect(halfTime(174)).toBe(87)
  expect(doubleTime(87)).toBe(174)
  expect(halfTime(128.3)).toBe(64.2) // one decimal, as stored
})

test('key repeat is not a tap', () => {
  expect(acceptsTapKey({ repeat: false })).toBe(true)
  expect(acceptsTapKey({ repeat: true })).toBe(false)
})
