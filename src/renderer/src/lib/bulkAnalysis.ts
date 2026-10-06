// ── Bulk analysis, the parts with no dependencies ─────────────────────────
// Split from reanalyze.ts so this can be unit-tested: that module reaches for
// the zustand store, which reads localStorage the moment it is imported and
// so cannot be loaded outside a renderer. Same split as lib/crateTree.ts and
// lib/folderTree.ts — the logic worth pinning down lives where a test can
// reach it, and the wiring stays in the module the components import.

// librosa is heavy and each track is its own Python process, so a bulk run
// goes four at a time — the same ceiling main/index.ts's runPhase2Analysis
// settled on for the import pipeline.
export const REANALYZE_CONCURRENCY = 4

// Seed for the progress bar's first frame only. Every real stage event carries
// its own `steps` and analyze.py is the authority on how many there are; this
// is just what the card shows between the click and Python starting up.
export const ANALYSIS_STEPS = 5

export type ReanalyzeOutcome = 'ok' | 'failed' | 'skipped'

export interface ReanalyzeTally {
  ok: number
  failed: number
  skipped: number
  stopped: boolean
}

// Runs `worker` over `items` with at most `limit` in flight at once. Workers
// pull from a shared cursor rather than running in fixed batches: track
// lengths vary by an order of magnitude, and a batch would idle three
// processes waiting for the longest one in it to finish.
//
// `shouldStop` is consulted before each item is picked up, never mid-item —
// a sidecar process that has already been spawned is left to finish, since
// the renderer has no way to kill it.
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean
): Promise<{ completed: number; stopped: boolean }> {
  let cursor = 0
  let completed = 0
  let stopped = false

  async function drain(): Promise<void> {
    for (;;) {
      if (shouldStop?.()) {
        stopped = true
        return
      }
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index])
      completed++
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, drain)
  await Promise.all(workers)
  return { completed, stopped }
}

// "12 re-analyzed, 1 failed" — the parts that are zero are left out, so the
// common case reads as one clause rather than a row of noughts.
export function reanalyzeSummary(tally: ReanalyzeTally): string {
  const parts: string[] = []
  if (tally.ok > 0) parts.push(`${tally.ok} re-analyzed`)
  if (tally.failed > 0) parts.push(`${tally.failed} failed`)
  if (tally.skipped > 0) parts.push(`${tally.skipped} skipped`)
  if (parts.length === 0) return 'Nothing to re-analyze'
  return parts.join(', ') + (tally.stopped ? ' — stopped' : '')
}
