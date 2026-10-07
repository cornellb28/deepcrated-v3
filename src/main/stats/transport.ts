// ── Anonymous stats: HTTP transport ───────────────────────────────────────
// A plain PostgREST insert, deliberately NOT through the supabase-js client
// in supabase.ts. That client carries the signed-in user's access token;
// this request must not, or a row could be tied to an account. Only the
// publishable anon key is sent, as `apikey`, and there is no Authorization
// header, so the database sees the `anon` role.

import type { SendBatch } from './uploader'

export interface TransportConfig {
  supabaseUrl: string
  anonKey: string
  fetchImpl?: typeof fetch
}

// The configured URL has been seen with a /rest/v1/ suffix; accept either.
export function statsEndpoint(supabaseUrl: string): string {
  const base = supabaseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '')
  return `${base}/rest/v1/stats_events`
}

export function createHttpSender(config: TransportConfig): SendBatch {
  const doFetch = config.fetchImpl ?? fetch
  const url = statsEndpoint(config.supabaseUrl)

  return async (rows) => {
    // Only the table's columns. Local ids and attempt counts stay local.
    const body = rows.map((r) => ({
      anon_install_id: r.anon_install_id,
      event_type: r.event_type,
      payload: JSON.parse(r.payload),
      app_version: r.app_version,
      created_at: r.created_at
    }))

    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          apikey: config.anonKey,
          'Content-Type': 'application/json',
          // The row is never read back (no SELECT policy exists).
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(body),
        credentials: 'omit'
      })
    } catch {
      return 'retry'
    }

    if (res.ok) return 'ok'
    // A malformed or oversized batch will never succeed. Auth and rate-limit
    // failures might (bad config, throttling), so those are retried.
    if (res.status === 400 || res.status === 413 || res.status === 422) return 'drop'
    return 'retry'
  }
}
