import { test, expect } from '@playwright/test'
import { runPool, reanalyzeSummary } from '../../src/renderer/src/lib/bulkAnalysis'

// Covers the two pure pieces behind the bulk bar's Re-analyze button. The
// analysis itself is a sidecar spawn per track (see analysis-progress.spec.ts);
// what matters here is that the pool never runs more of them at once than it
// promised, and that asking it to stop actually stops it — a bulk run over a
// full library is minutes of CPU, so both are the difference between a usable
// button and an unusable one.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('every item is worked exactly once', async () => {
  const seen: number[] = []
  const { completed, stopped } = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    seen.push(n)
  })

  expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  expect(completed).toBe(5)
  expect(stopped).toBe(false)
})

test('no more than the limit are ever in flight at once', async () => {
  let inFlight = 0
  let peak = 0

  await runPool(
    Array.from({ length: 12 }, (_, i) => i),
    4,
    async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }
  )

  expect(peak).toBe(4)
})

test('a worker that finishes early picks up the next item rather than waiting', async () => {
  // The reason for a rolling pool over fixed batches: one four-minute track
  // must not hold three idle slots behind it.
  const slow = deferred()
  const order: string[] = []

  const run = runPool(['slow', 'a', 'b', 'c'], 2, async (item) => {
    if (item === 'slow') {
      await slow.promise
      order.push('slow')
      return
    }
    order.push(item)
  })

  // a, b and c all get through while 'slow' is still blocked in its worker.
  await new Promise((r) => setTimeout(r, 10))
  expect(order).toEqual(['a', 'b', 'c'])

  slow.resolve()
  await run
  expect(order).toEqual(['a', 'b', 'c', 'slow'])
})

test('stopping is honoured between items, and reported', async () => {
  let stop = false
  const seen: number[] = []

  const { completed, stopped } = await runPool(
    [1, 2, 3, 4, 5, 6, 7, 8],
    1,
    async (n) => {
      seen.push(n)
      if (n === 3) stop = true
    },
    () => stop
  )

  // The item in hand still finishes — a spawned sidecar cannot be called back.
  expect(seen).toEqual([1, 2, 3])
  expect(completed).toBe(3)
  expect(stopped).toBe(true)
})

test('an empty selection spawns no workers at all', async () => {
  let called = 0
  const { completed, stopped } = await runPool([], 4, async () => {
    called++
  })

  expect(called).toBe(0)
  expect(completed).toBe(0)
  expect(stopped).toBe(false)
})

// ── The toast line ────────────────────────────────────────────────────────

test('the summary names only the outcomes that happened', () => {
  expect(reanalyzeSummary({ ok: 12, failed: 0, skipped: 0, stopped: false })).toBe('12 re-analyzed')
  expect(reanalyzeSummary({ ok: 10, failed: 2, skipped: 1, stopped: false })).toBe(
    '10 re-analyzed, 2 failed, 1 skipped'
  )
})

test('a stopped run says so, and one that did nothing does not pretend otherwise', () => {
  expect(reanalyzeSummary({ ok: 3, failed: 0, skipped: 0, stopped: true })).toBe(
    '3 re-analyzed — stopped'
  )
  expect(reanalyzeSummary({ ok: 0, failed: 0, skipped: 0, stopped: true })).toBe(
    'Nothing to re-analyze'
  )
})
