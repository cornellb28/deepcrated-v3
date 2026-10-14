---
name: "deepcrated-account-contract"
description: "Shared account and entitlement contract between the DeepCrated desktop app, mobile app and website. Use whenever work touches plans, subscriptions, entitlements, Supabase accounts, Stripe-to-account mapping, or billing across repos."
---

# DeepCrated account contract (v4.2, 2026-10-14)

Identical copy in `deepcrated-v3`, `deepcrate-web` and `deepcrated-mobile`. If you change this file, say so explicitly so the other copies are updated in the same sitting, and bump the version/date above. Spell the product "DeepCrated" in all user-facing copy.

The sync schema (tables, merge rules, tombstones) lives in `sync-contract.md` in `deepcrated-v3`. This file covers accounts, plans, billing and cloud storage limits.

## Decided
- **Supabase** (auth + Postgres) is the account system, one project shared by desktop, mobile and website. Login: email/password and Google OAuth. `deepcrate-web` owns all migrations.
- **Sign-in is optional.** The desktop app is fully usable signed out; an account is only needed for cloud sync and mobile. Never gate local features behind sign-in.
- **No general intermediary API.** Desktop and mobile talk to Supabase directly; RLS scopes reads to the user's own rows.
- The only server-side pieces in `deepcrate-web` are the **Stripe webhook** (writes entitlements with the service role key), the **app sign-in handoff endpoints** (create and redeem, below), and the **four cloud-storage endpoints** (upload-url, complete, download-url, delete) that issue signed Backblaze B2 links and keep per-user usage. Do not grow any of them into a general-purpose API.
- Checkout and login return to each app through its custom URL scheme (below).
- The desktop app is **free and ungated**. Paid = cloud sync, mobile and cloud audio storage, in three tiers (below), each sold monthly or annually.

## Deep-link schemes (FINAL)
| App | Scheme | Callback |
|---|---|---|
| Desktop (deepcrated-v3) | `cratecloud` (legacy, kept so installed apps keep working) | `cratecloud://auth-callback?key=...&state=...` |
| Mobile (deepcrated-mobile) | `deepcrated` | `deepcrated://auth-callback?key=...&state=...` |

- The website picks the scheme from a fixed server-side map keyed by a `client=desktop|mobile` parameter (default `desktop`). The scheme is never taken from a URL parameter.
- Each app accepts only its own scheme and the `auth-callback` authority. Never reuse one app's scheme in the other.
- Custom schemes can be claimed by other apps. The verifier protects the handoff; universal links are a possible later hardening step.

## Plans (FINAL)
| Plan id | Name | Monthly | Annual | Includes |
|---|---|---|---|---|
| free | Free | $0 | $0 | Signed-in account, desktop only: no cloud sync, no mobile, no cloud audio |
| sync | Sync | $10 | $100 | Cloud sync of library data (metadata, tags, crates), mobile app (browse, tag, listen to stored audio), 10 GB cloud audio |
| library | Library | $19 | $190 | Sync + 250 GB cloud audio, mobile listening |
| touring | Touring | $55 | $550 | Sync + 1 TB cloud audio, mobile listening |

- **Annual = 10 x monthly (two months free) on every paid tier.** The old 10% annual-discount cap is dropped; the margin guardrail below is the real limit.
- Storage caps (sync=10 GB, library=250 GB, touring=1000 GB, free=0) are constants enforced **server-side only**. Never trust a client-supplied cap.
- Stripe: one Product per paid plan, two Prices each (monthly and annual), six Price IDs in total, read from env vars `STRIPE_PRICE_SYNC`, `STRIPE_PRICE_LIBRARY`, `STRIPE_PRICE_TOURING` (monthly) and `STRIPE_PRICE_SYNC_ANNUAL`, `STRIPE_PRICE_LIBRARY_ANNUAL`, `STRIPE_PRICE_TOURING_ANNUAL` (annual). Test-mode and live-mode IDs differ, so keep them per environment. Never invent IDs. The webhook maps every one of the six price ids to a plan id; an unknown price id is logged and ignored, never granted. Checkout takes a server-validated interval (month or year). The customer portal must list both prices of each product.
- **Cloud storage:** audio lives in a private Backblaze B2 bucket through its S3-compatible API. B2 keys exist only as `deepcrate-web` server env vars (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION`) and never ship in the desktop or mobile apps. Apps get short-lived (15 minute) presigned PUT/GET links from the storage endpoints. Object key is `u/{user_id}/{sha256}`, with the user id taken from the verified session only; dedupe within one user's own files, never across users. Use separate dev and prod buckets and application keys (prod values on Production only; dev values on Preview and local). Never use the B2 master key.
- Mobile proxy files are counted at about 10% of library size in margin math.
- **Margin guardrail:** every tier must keep gross margin above 75% at worst case (subscriber fills the cap), counting B2 storage ($6.95/TB-month), Stripe fees (2.9% + $0.30 assumed) and about $0.50/user database/support. Indicative worst-case margins on B2: Sync 88.3% monthly / 89.9% annual, Library 82.8% / 81.7%, Touring 81.7% / 79.3%. Re-check this math before changing any price, cap or inclusion.
- Subscriptions are sold on the website through Stripe only. The mobile app is sign-in only and sells nothing in-app (store fees would break the margin). Verify current App Store rules before adding any purchase UI or upgrade link in mobile.
- Offline trust window for cached entitlements: 30 days (`OFFLINE_TRUST_MS`). A cache only drives UI state; the server enforces real access.
- `past_due` keeps access with a payment banner; Stripe's retry schedule should cancel unpaid subscriptions after about 14 days, and the webhook then sets `canceled`.
- `canceled` and `none` behave as `free` for new features, but cloud data stays accessible: access continues through the paid period, then **60 days read-only** (downloads allowed, uploads blocked) with a warning email, then the data is permanently deleted.
- **Over the cap** (for example after a downgrade): block new uploads, still allow downloads and deletes, never purge automatically.
- **Retention:** a deleted track's cloud audio is hidden and removed after 14 days by a B2 lifecycle rule (days from hiding to deleting = 14, set in the Backblaze console on every bucket); deleted accounts are purged after 60 days, with an immediate-delete option; sync delete records (tombstones) are kept 90 days, and a device offline longer than that needs a full re-check.
- Full-library restore fair use: one per 30 days; beyond that charge retrieval cost or contact support.
- Not built yet (leave TODOs): extra 250 GB add-on at $15/mo (re-check against B2 costs first), the deleted-account purge job, the cancelled-subscription sweep.

## Entitlement record (verify against the real migration)
One row per user: `user_id` (unique), `plan` (free|sync|library|touring), `status` (`active|trialing|past_due|canceled|none`), `current_period_end`, `stripe_customer_id`, `stripe_subscription_id`, `updated_at`.
- RLS: SELECT own row only. No client INSERT/UPDATE/DELETE. Only the service role writes.
- A table of processed Stripe event IDs makes the webhook idempotent.
- Storage usage lives in separate tables (`storage_usage`, `storage_objects`), including the read-only deadline; only the server functions write them.

## Stripe to entitlement
- `checkout.session.completed`: link customer/subscription IDs via `client_reference_id` = Supabase `user_id`.
- `customer.subscription.created|updated`: set plan (from price id), status, period end from the subscription object.
- `customer.subscription.deleted`: status `canceled`, and start the 60-day read-only window.
- `invoice.payment_failed`: status `past_due`.
The subscription object is the source of truth, not event order.

## Round trip: app sign-in handoff (desktop and mobile)
1. The app generates a `verifier` (random), a `challenge` = base64url(SHA-256(verifier)), and a `state` (random). It keeps verifier and state in memory only, then opens `<site>/desktop/connect?client=<desktop|mobile>&challenge=...&state=...` in the system browser (add `mode=signup` for create account).
2. The website makes sure the user is signed in on the web (login or signup, email/password or Google), then shows "Open DeepCrated as <email>?" with a confirm button.
3. On confirm, the website calls the **create** endpoint (authenticated by the web session). It requires a confirmed email, stores SHA-256(key) with the challenge, user id, a 60-second expiry and a single-use flag, and returns the key.
4. The website opens the client's scheme callback (table above) with `key` and `state`.
5. The app checks scheme and authority, checks `state` against its pending flow, then POSTs `{ key, verifier }` over HTTPS to the **redeem** endpoint.
6. Redeem atomically marks the key used, checks SHA-256(verifier) equals the stored challenge, then creates a fresh session for that user on the server (admin generateLink with type magiclink, which sends no email, then verifyOtp with the hashed token and type email) and returns `{ access_token, refresh_token }` over TLS.
7. The app stores the session (desktop: safeStorage; mobile: platform secure store) and re-reads its own entitlement row. Nothing in a link is proof of purchase.
- Someone who intercepts the deep link gets a key they cannot redeem without the verifier, which never leaves the app.
- Never issue a handoff for an unconfirmed email: verifying a magic link confirms the email.
- Do not lower Supabase's global Email OTP Expiration for this. The setting also covers confirmation and reset emails, and the OTP here is generated and consumed inside one request anyway.
- Table (needs owner approval before any migration): `desktop_auth_handoffs` with `id`, `key_hash` (unique), `challenge`, `user_id`, `expires_at`, `used_at`, `created_at`. RLS enabled with no policies (service role only).
- All redirect URLs on the website must be on the Supabase allowlist.

## Hard rules
- **Tokens never travel in a URL.** The deep link carries a one-time key and a state value only.
- Service role key, Stripe secret key and B2 keys never appear in the desktop or mobile repos, builds, or prompts. Clients get only the Supabase URL and anon key.
- Only the webhook writes entitlements.
- Stripe **test mode** until the owner says go live. Before launch, create the six live-mode prices and swap their IDs into Production.
- Owner's workflow: inspect first, no new dependencies without approval, confirm before touching any data layer, reuse existing infrastructure, explicit TODOs for deferred work.

## Open decisions (ask, don't resolve silently)
Live-mode Stripe Price IDs (real values); the website repo's final name (`deepcrate-web` here; confirm whether it is being renamed); Sign in with Apple on the website login page before any iOS submission (App Store guideline 4.8 applies when Google login is offered); per-user vs per-seat (currently per-user); customer portal scope; whether mobile may link to the website for upgrades under current App Store rules; universal links for mobile; key rotation for derived fingerprint keys and who can access them.