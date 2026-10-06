// ── Debounced stage writes ────────────────────────────────────────────────
// Clicking a stage pill cycles it instantly in the UI; the DATABASE write is
// what waits. Four quick clicks around the cycle should cost one write, not
// four — and never four writes that can land out of order.
//
// Module-level on purpose, NOT component state. A TrackRow unmounts whenever
// the list re-renders, the tab changes, or the grid virtualizer scrolls it
// out of view — and a timer owned by that component would be cancelled with
// it, silently losing the change the DJ just made. Keeping the pending write
// here means it survives the row that started it.

const DEBOUNCE_MS = 500

interface Pending {
  timer: ReturnType<typeof setTimeout>
  stageId: number
}

// Keyed by track id, so cycling track A and then track B leaves A's pending
// write running on its own schedule rather than cancelling it.
const pending = new Map<number, Pending>()

let unloadHookInstalled = false

function installUnloadHook(): void {
  if (unloadHookInstalled || typeof window === 'undefined') return
  unloadHookInstalled = true
  // Best-effort: the handler cannot await, but firing the writes is still
  // strictly better than dropping them. The exposure is one click inside the
  // last half-second before a quit.
  window.addEventListener('beforeunload', () => {
    void flushStageWrites()
  })
}

async function write(trackId: number, stageId: number): Promise<void> {
  try {
    await window.api.db.updateBoardId(trackId, stageId)
  } catch (err) {
    // The store was already updated optimistically, so the UI is ahead of
    // the database here. Logged rather than toasted: a failed stage write is
    // not worth interrupting a set over, and the next click will retry it.
    console.error('[stages] could not persist stage for track', trackId, err)
  }
}

// Replaces any write already queued for this track. Only the value the DJ
// landed on is ever sent — the intermediate stages they clicked through are
// not writes anyone needs.
export function queueStageWrite(trackId: number, stageId: number): void {
  installUnloadHook()

  const existing = pending.get(trackId)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    pending.delete(trackId)
    void write(trackId, stageId)
  }, DEBOUNCE_MS)

  pending.set(trackId, { timer, stageId })
}

// Sends every queued write now. Called on unload, and worth calling before
// anything that reads board_id back from the database.
export async function flushStageWrites(): Promise<void> {
  const entries = Array.from(pending.entries())
  pending.clear()
  await Promise.all(
    entries.map(([trackId, { timer, stageId }]) => {
      clearTimeout(timer)
      return write(trackId, stageId)
    })
  )
}

// Test seam: lets a unit test assert the coalescing without waiting.
export function pendingStageWriteCount(): number {
  return pending.size
}
