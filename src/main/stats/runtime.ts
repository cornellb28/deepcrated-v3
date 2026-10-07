// ── Anonymous stats: uploader lifecycle ───────────────────────────────────
// Starts the periodic flush and does the final one on quit. Config comes from
// import.meta.env for the same reason supabase.ts does (see there). If the
// Supabase config is absent the uploader does nothing — stats must never
// stop the app from running.

import { consent, statsStore } from './index'
import { createHttpSender } from './transport'
import { createUploader, type Uploader } from './uploader'

const SUPABASE_URL = import.meta.env.MAIN_VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY

// Short tick; the real "at most every few hours" rule lives in the uploader
// (UPLOAD_INTERVAL_MS) and the per-row backoff, so a failed send can retry
// on schedule instead of waiting a full interval.
const TICK_MS = 15 * 60 * 1000
const FIRST_RUN_DELAY_MS = 60 * 1000
const QUIT_FLUSH_TIMEOUT_MS = 3000

let uploader: Uploader | null = null
let timer: ReturnType<typeof setInterval> | null = null

function getUploader(): Uploader | null {
  if (uploader) return uploader
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  uploader = createUploader(statsStore, consent, {
    now: () => Date.now(),
    random: Math.random,
    send: createHttpSender({ supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY })
  })
  return uploader
}

export function startStatsUploader(): void {
  consent.reconcile()
  if (timer) return
  const tick = (): void => {
    void getUploader()
      ?.flush()
      .catch(() => {})
  }
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref()
  timer = setInterval(tick, TICK_MS)
  timer.unref()
}

// Lets the quit handler skip the delay entirely when there is nothing to send.
export function shouldFlushOnQuit(): boolean {
  return consent.isConsentActive() && getUploader() !== null
}

export async function flushStatsOnQuit(): Promise<void> {
  const up = getUploader()
  if (!up) return
  // Capped so a slow network can never hold the app open.
  await Promise.race([
    up.flush({ force: true }).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS))
  ])
}
