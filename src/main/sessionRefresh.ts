// ── When to refresh the session ──────────────────────────────────────────
// Supabase access tokens last an hour. The desktop app is deliberately NOT
// using supabase-js's autoRefreshToken: that timer assumes a browser page
// lifecycle (visibility events, a window that gets closed), none of which
// describes an Electron main process that a DJ leaves running all night.
// Refresh is driven explicitly instead, from a timer this module sizes.
//
// Pure, and in its own module so the timing is reachable from a test —
// auth.ts imports electron and cannot be. Same split as rescan.ts /
// rescanSweep.ts.

// Refresh once 80% of the remaining life has elapsed, leaving a 20% buffer
// to absorb a slow network or a laptop that was briefly asleep. At Supabase's
// default 1h token that is a refresh at ~48 minutes with ~12 minutes spare.
export const REFRESH_LEAD_RATIO = 0.8

// Never schedule a tighter loop than this, even for a token that is already
// expired — a 0ms timer on a failing refresh would spin.
export const MIN_REFRESH_DELAY_MS = 10_000

// Never sleep longer than this, however long-lived the token claims to be.
// A periodic re-check is also what notices a session revoked server-side
// (a password change, a sign-out elsewhere) rather than finding out at the
// next launch.
//
// Note this cap, not the lead ratio, is what governs Supabase's DEFAULT 1h
// token: 0.8 x 60min = 48min, which the cap trims to 30. That is intended —
// halfway through the token's life is a generous margin, and it bounds how
// long a revoked session can keep working. The ratio does the work for
// projects configured with a shorter token.
export const MAX_REFRESH_DELAY_MS = 30 * 60 * 1000

// After a NETWORK failure, as opposed to a rejected token. Short enough to
// recover quickly when the wifi comes back, long enough not to hammer.
export const NETWORK_RETRY_DELAY_MS = 60_000

// `expiresAtSec` is Supabase's Session.expires_at — unix SECONDS, and
// optional, hence the undefined case. Anything unparseable is treated the
// same as missing: fall back to the periodic re-check rather than guessing
// a lifetime, since guessing short burns requests and guessing long means a
// dead token goes unnoticed.
export function refreshDelayMs(expiresAtSec: number | undefined, nowMs = Date.now()): number {
  if (expiresAtSec === undefined || !Number.isFinite(expiresAtSec)) {
    return MAX_REFRESH_DELAY_MS
  }

  const remainingMs = expiresAtSec * 1000 - nowMs

  // Already expired, or expiring so soon that the lead time is meaningless.
  // Covers a laptop resumed from sleep after the token died, and a clock
  // that has jumped forward.
  if (remainingMs <= 0) return MIN_REFRESH_DELAY_MS

  const lead = remainingMs * REFRESH_LEAD_RATIO
  return Math.min(Math.max(lead, MIN_REFRESH_DELAY_MS), MAX_REFRESH_DELAY_MS)
}
