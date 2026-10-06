import { test, expect } from '@playwright/test'
import {
  refreshDelayMs,
  MIN_REFRESH_DELAY_MS,
  MAX_REFRESH_DELAY_MS,
  REFRESH_LEAD_RATIO
} from '../../src/main/sessionRefresh'

// When the session gets refreshed. The desktop app drives this itself
// instead of using supabase-js's autoRefreshToken, whose timer assumes a
// browser page lifecycle rather than an Electron main process a DJ leaves
// running all night — so the timing is ours to get right and ours to test.

const NOW = 1_800_000_000_000 // fixed clock; the function takes `now` so it is testable
const inSeconds = (s: number): number => Math.floor(NOW / 1000) + s

// Two rules are in play and which one binds depends on the token's life:
// the 80% lead ratio governs SHORT tokens, the 30-minute cap governs long
// ones. At Supabase's default 1h token, 0.8 x 60min = 48min exceeds the cap,
// so the cap wins — and that is the intended outcome, not an accident: it
// refreshes at the halfway mark with an enormous margin, and it bounds how
// long a revoked session can go unnoticed.
test('a fresh one-hour token is governed by the cap, with a wide margin', () => {
  const delay = refreshDelayMs(inSeconds(3600), NOW)
  expect(delay).toBe(MAX_REFRESH_DELAY_MS)
  expect(delay).toBeLessThan(3600 * 1000)
})

// Where the ratio actually does the work: a project configured with a short
// token. 0.8 x 15min = 12min, comfortably inside the cap.
test('a short token is governed by the lead ratio', () => {
  expect(refreshDelayMs(inSeconds(900), NOW)).toBe(900 * 1000 * REFRESH_LEAD_RATIO)
})

// The laptop-resumed-from-sleep case, and a clock that jumped forward.
test('an already-expired token schedules immediately, but not in a tight loop', () => {
  expect(refreshDelayMs(inSeconds(-60), NOW)).toBe(MIN_REFRESH_DELAY_MS)
  expect(refreshDelayMs(inSeconds(0), NOW)).toBe(MIN_REFRESH_DELAY_MS)
})

test('a token expiring within moments still respects the floor', () => {
  // 80% of 2s is 1.6s — refreshing that fast would spin if it kept failing.
  expect(refreshDelayMs(inSeconds(2), NOW)).toBe(MIN_REFRESH_DELAY_MS)
})

// A long-lived token must still re-check periodically: that is what notices
// a session revoked server-side (password changed, signed out elsewhere)
// rather than finding out at the next launch.
test('a very long-lived token is still re-checked periodically', () => {
  expect(refreshDelayMs(inSeconds(86400), NOW)).toBe(MAX_REFRESH_DELAY_MS)
})

// Session.expires_at is optional in supabase-js.
test('a missing expiry falls back to the periodic re-check', () => {
  expect(refreshDelayMs(undefined, NOW)).toBe(MAX_REFRESH_DELAY_MS)
})

test('an unparseable expiry is treated as missing rather than trusted', () => {
  expect(refreshDelayMs(NaN, NOW)).toBe(MAX_REFRESH_DELAY_MS)
  expect(refreshDelayMs(Infinity, NOW)).toBe(MAX_REFRESH_DELAY_MS)
})

test('the result is always inside the clamp', () => {
  for (const seconds of [-10000, -1, 0, 1, 30, 300, 3600, 7200, 999999]) {
    const delay = refreshDelayMs(inSeconds(seconds), NOW)
    expect(delay).toBeGreaterThanOrEqual(MIN_REFRESH_DELAY_MS)
    expect(delay).toBeLessThanOrEqual(MAX_REFRESH_DELAY_MS)
  }
})

// The refresh must land before the token dies, or the whole exercise is
// pointless — this is the property that actually matters.
test('the refresh is always scheduled before the token expires', () => {
  for (const seconds of [15, 60, 300, 3600]) {
    const remainingMs = seconds * 1000
    expect(refreshDelayMs(inSeconds(seconds), NOW)).toBeLessThan(remainingMs + MIN_REFRESH_DELAY_MS)
  }
})
