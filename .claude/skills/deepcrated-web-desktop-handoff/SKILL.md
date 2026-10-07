---
name: deepcrated-web-desktop-handoff
description: The website side of signing a user into the DeepCrate desktop app, in deepcrate-web. Covers the desktop connect page, the create-key and redeem endpoints, the handoff table, and creating a session server-side. Use whenever work touches desktop sign-in, the connect page, one-time keys, redeem, verifier or challenge checks, generateLink or verifyOtp, or why the app does not sign in after the browser login, even if the user just says "the handoff" or "sign in from the app". Read deepcrate-account-contract first.
---

# Desktop sign-in handoff (deepcrate-web)

Read `deepcrate-account-contract` (v3) first; its "Round trip" section is the design. Inspect the existing framework, routes, and migrations before changing anything. These two endpoints plus the Stripe webhook are the only server routes; don't add more.

## Pieces
- **Connect page** `/desktop/connect?challenge=...&state=...` (optional `mode=signup`): if not signed in, send through login or signup and return with the query intact. If signed in, show "Open DeepCrate as <email>?" with a confirm button and a "Use a different account" link. On confirm, call the create endpoint, then navigate to `<scheme>://auth-callback?key=...&state=...`. Include a "Didn't open? Try again" button.
- **Create endpoint** (authenticated by the web session): require a **confirmed email** (verifying a magic link confirms an email, so never issue for an unconfirmed user). Generate a key (32 random bytes, base64url). Store only SHA-256(key) with the challenge, user id, expiry 60 seconds, and a null `used_at`. Return the key.
- **Redeem endpoint** (called by the desktop app, not a browser): body `{ key, verifier }`. In one atomic statement mark the row used where `key_hash` matches, `used_at` is null, and it has not expired (UPDATE ... RETURNING). Check base64url(SHA-256(verifier)) equals the stored challenge. Then create a session for that user server-side: admin `generateLink` (type magiclink; sends no email) and `verifyOtp` with the returned `hashed_token` and type `email`, using a non-persisting anon client. Return `{ access_token, refresh_token }`.

## Rules
- Table `desktop_auth_handoffs` (PROPOSED): `id`, `key_hash` unique, `challenge`, `user_id`, `expires_at`, `used_at`, `created_at`. RLS on, no policies. **Confirm with the owner before any migration or RLS change.**
- Service role key is server-only. Never log keys, verifiers, or tokens.
- Generic error responses; never say why a key failed.
- Rate limit both endpoints by user and IP. Delete expired rows opportunistically.
- Do not lower Supabase's global Email OTP Expiration.
- Test calling generateLink twice quickly for the same user; older Supabase versions returned the same OTP, which would break the second sign-in.

**Done means:** valid redeem works once and a second fails; expired, wrong-verifier, unknown-key, unconfirmed-email, and unauthenticated-create all fail; two simultaneous redeems give exactly one success; a normal authenticated client cannot read or write the table.
