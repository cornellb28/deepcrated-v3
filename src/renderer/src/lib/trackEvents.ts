// ── "A track's data was saved" ────────────────────────────────────────────
// Fired only after a save has SUCCEEDED (the Inspector's per-field save, a
// tag change, an analysis result), never on the optimistic store update
// that precedes it. Inspector > Related re-ranks on it.

type Listener = (trackId: number) => void

const listeners = new Set<Listener>()

export function notifyTrackSaved(trackId: number): void {
  for (const listener of listeners) listener(trackId)
}

export function onTrackSaved(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Calls `run` once, `delayMs` after the last successful save of `trackId`
// (several saves in a row coalesce into one call). Returns a function that
// stops listening and cancels a pending call.
export function onTrackSavedDebounced(
  trackId: number,
  delayMs: number,
  run: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTrackSaved((savedId) => {
    if (savedId !== trackId) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run()
    }, delayMs)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
  }
}
