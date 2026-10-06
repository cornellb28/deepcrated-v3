---
name: deepcrate-account-contract
description: Shared account and entitlement contract between the DeepCrate desktop app (cratecloud-v3) and website (deepcrate-web). Use whenever work touches plans, subscriptions, entitlements, Supabase accounts, Stripe-to-account mapping, or any change that must stay consistent across both repos, even if the user just says "accounts", "plan", or "billing". Identical copy lives in both repos.
---

# DeepCrate account contract (v3, 2026-10-05)

Identical copy in `cratecloud-v3` and `deepcrate-web`. If you change this file, say so explicitly so the other repo's copy is updated in the same sitting, and bump the version/date above.

## Decided
- **Supabase** (auth + Postgres) is the account system, one project shared by desktop and website. Login: email/password and Google OAuth.
- **Sign-in is optional.** The desktop app is fully usable signed out; an account is only needed for cloud sync and mobile. Never gate local features behind sign-in.
- **No intermediary API.** Desktop talks to Supabase directly; RLS scopes reads to the user's own rows.
- The only server-side pieces in `deepcrate-web` are the **Stripe webhook** (writes entitlements with the service role key) and the **desktop sign-in handoff endpoints** (create and redeem, below). Do not grow them into a general-purpose API.
- Checkout and login return to the desktop app through its existing **custom protocol handler**.
- Desktop is free and ungated. Paid = cloud sync and mobile subscription tiers, **to be defined later**. Never invent plan names, prices, or limits.

## Entitlement record (PROPOSED, verify against the real migration)
One row per user: `user_id` (unique), `plan`, `status` (`active|trialing|past_due|canceled|none`), `current_period_end`, `stripe_customer_id`, `stripe_subscription_id`, `updated_at`.
- RLS: SELECT own row only. No client INSERT/UPDATE/DELETE. Only the service role writes.
- A table of processed Stripe event IDs makes the webhook idempotent.

## Stripe to entitlement (PROPOSED)
- `checkout.session.completed`: link customer/subscription IDs via `client_reference_id` = Supabase `user_id`.
- `customer.subscription.created|updated`: set plan, status, period end from the subscription object.
- `customer.subscription.deleted`: status `canceled`.
- `invoice.payment_failed`: status `past_due`.
The subscription object is the source of truth, not event order.

## Round trip: desktop sign-in handoff
1. The app generates a `verifier` (random), a `challenge` = base64url(SHA-256(verifier)), and a `state` (random). It keeps verifier and state in memory only, then opens `<site>/desktop/connect?challenge=...&state=...` in the system browser (add `mode=signup` for create account).
2. The website makes sure the user is signed in on the web (login or signup, email/password or Google), then shows "Open DeepCrate as <email>?" with a confirm button.
3. On confirm, the website calls the **create** endpoint (authenticated by the web session). It requires a confirmed email, stores SHA-256(key) with the challenge, user id, a 60-second expiry and a single-use flag, and returns the key.
4. The website opens `<custom-scheme>://auth-callback?key=<key>&state=<state>`.
5. The app checks scheme and authority, checks `state` against its pending flow, then POSTs `{ key, verifier }` over HTTPS to the **redeem** endpoint.
6. Redeem atomically marks the key used, checks SHA-256(verifier) equals the stored challenge, then creates a fresh session for that user on the server (admin generateLink with type magiclink, which sends no email, then verifyOtp with the hashed token and type email) and returns `{ access_token, refresh_token }` over TLS.
7. The app stores the session (safeStorage) and re-reads its own entitlement row. Nothing in a link is proof of purchase.
- Someone who intercepts the deep link gets a key they cannot redeem without the verifier, which never leaves the app.
- Never issue a handoff for an unconfirmed email: verifying a magic link confirms the email.
- Do not lower Supabase's global Email OTP Expiration for this. The setting also covers confirmation and reset emails, and the OTP here is generated and consumed inside one request anyway.
- Table (PROPOSED, needs owner approval before any migration): `desktop_auth_handoffs` with `id`, `key_hash` (unique), `challenge`, `user_id`, `expires_at`, `used_at`, `created_at`. RLS enabled with no policies (service role only).
- All redirect URLs on the website must be on the Supabase allowlist.

## Hard rules
- **Tokens never travel in a URL.** The deep link carries a one-time key and a state value only.
- Service role key and Stripe secret key never appear in the desktop repo, build, or prompts. Desktop gets only the Supabase URL and anon key.
- Only the webhook writes entitlements.
- Stripe **test mode** until the owner says go live.
- Owner's workflow: inspect first, no new dependencies without approval, confirm before touching any data layer, reuse existing infrastructure, explicit TODOs for deferred work.

## Open decisions (ask, don't resolve silently)
Plan IDs and Stripe Price IDs; adding Sign in with Apple to the website login page before any iOS submission (App Store guideline 4.8 requires an equivalent login option when Google login is offered); offline trust window for cached entitlements; per-user vs per-seat; customer portal scope.
