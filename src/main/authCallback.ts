// ── OAuth callback URL parsing ───────────────────────────────────────────
// Pure, and in its own module so it is reachable from a unit test: auth.ts
// imports electron (shell) and authStore (app, safeStorage), so anything
// that pulls it in only runs inside Electron. Same split as rescan.ts /
// rescanSweep.ts, and for the same reason.
//
// URL parsing is where deep-link handling actually goes wrong — a fragment
// read as a query, or an error page mistaken for a missing token — and it
// is the one part of the OAuth round trip that can be tested without a
// browser, a Google account, or a live Supabase project.

export const CALLBACK_PROTOCOL = 'cratecloud'
export const CALLBACK_URL = `${CALLBACK_PROTOCOL}://auth-callback`

export interface ParsedCallback {
  // 'recovery' is a password-reset link, which arrives carrying tokens just
  // like a sign-in does and is distinguishable ONLY by type=recovery. Worth
  // separating: adopting it as an ordinary sign-in would silently swallow
  // the reset, leaving the DJ signed in with the password they had forgotten
  // and no prompt to change it.
  kind: 'tokens' | 'recovery' | 'code' | 'error' | 'none'
  accessToken?: string
  refreshToken?: string
  code?: string
  error?: string
}

// Supabase can come back two ways and which one depends on project config,
// so both are handled rather than guessing:
//   implicit — tokens in the URL *fragment*: #access_token=…&refresh_token=…
//   PKCE    — a single-use ?code=… in the query, exchanged for a session
export function parseCallbackUrl(rawUrl: string): ParsedCallback {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'none' }
  }

  // Anything not on our scheme is not ours to interpret. Worth being strict:
  // on Windows every argv entry reaches this, not just deep links.
  if (url.protocol !== `${CALLBACK_PROTOCOL}:`) return { kind: 'none' }

  // URL does not parse the fragment beyond the raw string, and Supabase puts
  // implicit-flow tokens there precisely so they stay out of server logs.
  // Strip the leading '#' before handing it to URLSearchParams.
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams

  // Errors first. A denied consent screen comes back with an error and no
  // tokens, and reporting "no tokens" would bury the actual reason.
  // error_description is preferred over error: it is the human-readable one.
  const failure =
    fragment.get('error_description') ??
    query.get('error_description') ??
    fragment.get('error') ??
    query.get('error')
  if (failure) return { kind: 'error', error: failure }

  // Supabase puts this on recovery, invite and email-change links. Only
  // recovery is handled in-app today; the others still open the hosted page.
  const linkType = fragment.get('type') ?? query.get('type')

  const accessToken = fragment.get('access_token') ?? query.get('access_token')
  const refreshToken = fragment.get('refresh_token') ?? query.get('refresh_token')
  // Both or neither: setSession needs the pair, and a lone access token
  // would buy a session that cannot outlive its hour.
  if (accessToken && refreshToken) {
    return {
      kind: linkType === 'recovery' ? 'recovery' : 'tokens',
      accessToken,
      refreshToken
    }
  }

  const code = query.get('code') ?? fragment.get('code')
  if (code) return { kind: 'code', code }

  return { kind: 'none' }
}
