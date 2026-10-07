---
name: deepcrated-desktop-deeplink
description: Custom protocol handler and the sign-in handoff from the website into the DeepCrate desktop app (deepcrated-v3, Electron). Use whenever work touches the protocol scheme, open-url, second-instance, single-instance lock, auth callback links, the one-time key and verifier exchange, redeeming a sign-in, or the checkout/login redirect back into the app, even if the user just says "redirect back to the app". Read deepcrate-account-contract first.
---

# Desktop deep link and sign-in handoff (deepcrated-v3)

Read `deepcrate-account-contract` (v3) first. The existing handler already covers the scheme (`deepcrated`), macOS `open-url`, Windows/Linux `second-instance`, and the single-instance lock. The scheme was renamed from `cratecloud` to `deepcrated`; the app still registers and accepts the old `cratecloud` scheme until the website builds `deepcrated://` links and the Supabase redirect allowlist has `deepcrated://auth-callback` (see TODO(deepcrated) in `src/main/authCallback.ts`). Do not rename it again.

## Starting a sign-in (main process)
- Generate `verifier` (32 random bytes, base64url), `challenge` = base64url(SHA-256(verifier)), and `state` (32 random bytes, base64url) with Node `crypto`.
- Keep verifier and state in main-process memory only, with a created-at time. Never persist them or send them to the renderer.
- Open the configured website sign-in URL in the system browser with `challenge` and `state` as query params (`mode=signup` for create account).
- Cancel clears the pending flow. A pending flow expires after about 10 minutes.

## Handling the callback
- Accept only `deepcrated://auth-callback?key=...&state=...` (or the legacy `cratecloud://` form during the transition). Check the scheme **and** the authority exactly.
- Reject anything else: other authorities, fragments, `access_token`, `refresh_token`, or `code` params. Log a generic warning with no values.
- Ignore the link if there is no pending flow, it is expired, or `state` does not match (constant-time compare). Clear the pending flow on first valid use.
- Redeem: POST `{ key, verifier }` as JSON to the configured redeem URL. HTTPS only (plain http only for localhost in development), with a timeout. A success returns `{ access_token, refresh_token }`.
- Adopt the session in main with the existing safeStorage path, then re-read the user's own entitlement row, emit the state change, focus the window, and show the toast.
- On any failure return to signedOut with a generic message. Never show why a key failed.
- Tokens and keys never go in logs, URLs, or the renderer. Do not guess website URLs; read them from config and keep links hidden when unset.

## Testing
Unit tests: challenge derivation; wrong authority; missing or mismatched state; no pending flow; expired flow; fragment or token params; replay of the same link; successful redeem (mocked endpoint); failed redeem back to signedOut.

**Done means:** the full round trip works on a **packaged build** (protocol registration differs from dev), and a hand-made callback with a fake key or wrong state changes nothing.
