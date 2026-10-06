// ── Supabase client (main process) ────────────────────────────────────────
// The client lives in main, not the renderer, for the same reason db.ts
// does: the renderer never holds credentials or tokens, it asks over IPC.
// That keeps the access token out of a context where any renderer-side
// script could reach it.
//
// Config comes from import.meta.env, not process.env. electron-vite inlines
// MAIN_VITE_-prefixed variables into the main bundle at build time, which is
// what makes them readable in a PACKAGED app — a process.env read works
// under `npm run dev` (the shell has them) and then returns undefined once
// built, which is a miserable bug to find later. Both values are safe to
// inline: the anon key is publishable by design and every table is behind
// RLS. See .env.example.

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.MAIN_VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY

// Deliberately not thrown at import time. A missing key is a setup problem,
// and the app should still open and run the whole local library — which is
// all of it, since nothing is gated — rather than refuse to boot over a
// feature the DJ may never touch. isConfigured() lets the auth layer report
// this as a clear message instead of a crash.
export function isConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

export const MISSING_CONFIG_MESSAGE =
  'Supabase is not configured. Copy .env.example to .env and fill in ' +
  'MAIN_VITE_SUPABASE_URL and MAIN_VITE_SUPABASE_ANON_KEY, then restart.'

let client: SupabaseClient | null = null

// persistSession/autoRefreshToken are off, and detectSessionInUrl must be:
//   - persistSession would reach for localStorage, which does not exist in
//     the main process. We persist through safeStorage instead (authStore.ts)
//     so the refresh token is encrypted at rest by the OS keychain rather
//     than sitting in a readable file.
//   - autoRefreshToken runs a background timer that assumes a browser page
//     lifecycle. Refresh is driven explicitly from restoreSession() instead,
//     which is both testable and awake at the only moment it matters.
//   - detectSessionInUrl is a browser-only affordance (it reads
//     window.location) and there is no location here; the cratecloud://
//     callback is parsed by hand in auth.ts.
export function getClient(): SupabaseClient {
  if (!isConfigured()) throw new Error(MISSING_CONFIG_MESSAGE)
  if (!client) {
    client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  }
  return client
}

export type { Session }
