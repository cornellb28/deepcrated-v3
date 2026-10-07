// ── Anonymous stats: batched uploader ─────────────────────────────────────
// Sends queued events in batches, at most every UPLOAD_INTERVAL_MS and once
// more on quit. Consent is re-checked immediately before every send: if it
// is off the queue is purged and nothing goes out.
//
// The network is injected as `send`. The real one (transport.ts) carries
// only the anon key — never a user token.

import type { ConsentService } from './consent'
import { MAX_EVENT_AGE_MS } from './queue'
import type { QueuedStat, StatsStore } from './types'

export const UPLOAD_INTERVAL_MS = 3 * 60 * 60 * 1000
export const BATCH_SIZE = 100
export const BACKOFF_BASE_MS = 5 * 60 * 1000
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

// ok: delivered. retry: try again later with backoff. drop: the server will
// never accept this batch, so discard it rather than wedge the queue.
export type SendOutcome = 'ok' | 'retry' | 'drop'

export type SendBatch = (rows: QueuedStat[]) => Promise<SendOutcome>

export interface UploaderDeps {
  now: () => number
  random: () => number
  send: SendBatch
}

export function backoffMs(attempts: number, random: () => number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts))
  // ±20% jitter so a fleet of installs does not retry in lockstep.
  return Math.round(exp * (0.8 + 0.4 * random()))
}

export interface FlushOptions {
  // Quit-time flush: ignore the minimum interval.
  force?: boolean
}

export interface Uploader {
  flush(opts?: FlushOptions): Promise<{ sent: number }>
}

export function createUploader(
  store: StatsStore,
  consent: ConsentService,
  deps: UploaderDeps
): Uploader {
  let running: Promise<{ sent: number }> | null = null

  async function run(opts: FlushOptions): Promise<{ sent: number }> {
    if (!consent.isConsentActive()) {
      store.queuePurgeAll()
      return { sent: 0 }
    }

    const last = store.getLastUploadAt()
    if (!opts.force && last !== null && deps.now() - last < UPLOAD_INTERVAL_MS) {
      return { sent: 0 }
    }

    store.queueDeleteOlderThan(new Date(deps.now() - MAX_EVENT_AGE_MS).toISOString())

    let sent = 0
    let failed = false
    for (;;) {
      // Re-checked per batch: withdrawing consent mid-flush stops the next send.
      if (!consent.isConsentActive()) {
        store.queuePurgeAll()
        break
      }
      const batch = store.queueDue(deps.now(), BATCH_SIZE)
      if (batch.length === 0) break

      let outcome: SendOutcome
      try {
        outcome = await deps.send(batch)
      } catch {
        outcome = 'retry'
      }

      const ids = batch.map((r) => r.id)
      if (outcome === 'ok') {
        store.queueDelete(ids)
        sent += ids.length
        continue
      }
      if (outcome === 'drop') {
        store.queueDelete(ids)
        continue
      }
      const attempts = Math.max(...batch.map((r) => r.attempts))
      store.queueMarkFailed(ids, deps.now() + backoffMs(attempts, deps.random))
      failed = true
      break
    }

    // The interval starts only when this run finished its work. A failed send,
    // or rows still waiting out a backoff, must not start it: the per-row
    // backoff decides when to try again, and the caller's tick is short
    // enough to honour that.
    if (!failed && (sent > 0 || store.queueCount() === 0)) store.setLastUploadAt(deps.now())
    return { sent }
  }

  return {
    flush(opts = {}) {
      // One flush at a time: a quit-time flush joins one already in flight.
      if (!running) {
        running = run(opts).finally(() => {
          running = null
        })
      }
      return running
    }
  }
}
