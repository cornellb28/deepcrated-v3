// ── Metadata Cleanup: wiring ──────────────────────────────────────────────
// Binds the service to the real database. File writes are started from
// index.ts, which owns the background-jobs registry.

import { getTagCleanupStore } from '../db'
import { createTagCleanup } from './service'

type Send = (channel: string, payload: unknown) => void
let send: Send = () => {}

// Called once from index.ts with a function that posts to the main window.
export function setTagCleanupSender(fn: Send): void {
  send = fn
}

export const tagCleanup = createTagCleanup(getTagCleanupStore())

// Import hook. Saved rules never apply on their own: this only counts the
// new tracks they would change and tells the renderer, which offers the
// review screen. Most import paths report one track at a time, so ids are
// collected and checked once things go quiet. Never throws; it must not be
// able to fail an import.
const IMPORT_SETTLE_MS = 2000
const pending = new Set<number>()
let timer: ReturnType<typeof setTimeout> | null = null

export function checkImportsForCleanup(trackIds: readonly number[]): void {
  for (const id of trackIds) if (id > 0) pending.add(id)
  if (pending.size === 0) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const ids = [...pending]
    pending.clear()
    try {
      const count = tagCleanup.importMatches(ids)
      if (count > 0) send('tag-cleanup:import-matches', { count })
    } catch (err) {
      console.warn('[tag-cleanup] import check failed:', (err as Error).message)
    }
  }, IMPORT_SETTLE_MS)
}
