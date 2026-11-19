---
name: "deepcrated-mobile-auth"
description: "Sign-in, session storage, deep-link callback and entitlement reading in the DeepCrated mobile app (deepcrated-mobile, Expo + React Native). Use whenever work touches mobile login, the deepcrated:// scheme, secure session storage, or plan-based gating on mobile. Read deepcrated-account-contract first."
---

# Mobile auth (deepcrated-mobile)

Read `deepcrated-account-contract` (v4.2) first. Inspect the existing Expo config, Supabase client and navigation before changing anything. Spell the product "DeepCrated" in all user-facing copy. Mobile follows the same design as the desktop app; read `deepcrated-desktop-auth` and `deepcrated-desktop-deeplink` for the reasoning.

## Decided
- URL scheme: **`deepcrated`**. The only accepted callback is `deepcrated://auth-callback?key=...&state=...`. The desktop app keeps its own scheme `cratecloud`; never reuse one for the other.
- Sign-in and sign-up happen on the website (email/password and Google OAuth), never in an in-app form. The app never sees or handles a password.
- The deep link carries only a one-time key and a state value, never tokens. The app proves it started the flow by sending a secret verifier when it redeems the key over HTTPS.
- Mobile sells nothing in-app (store fees would break the margin guardrail). Upgrade prompts say to manage the plan on deepcrated.com, with no prices. Check current App Store rules with the owner before adding any purchase UI or upgrade link.

## Starting a sign-in
- Generate `verifier` (32 random bytes, base64url), `challenge` = base64url(SHA-256(verifier)) and `state` (32 random bytes, base64url). Keep verifier and state in memory only, with a created-at time; a pending flow expires after about 10 minutes.
- Open `<site>/desktop/connect?client=mobile&challenge=...&state=...` in the system browser or the platform authentication session (never an embedded webview; Google blocks OAuth there). Add `mode=signup` for create account.
- Tokens never travel in a URL.

## Handling the callback
- Accept only `deepcrated://auth-callback`. Check scheme and authority exactly. Reject fragments and any `access_token`, `refresh_token` or `code` params. Log generic warnings with no values.
- Ignore the link if there is no pending flow, it is expired, or `state` does not match (constant-time compare). Clear the pending flow on first valid use.
- Redeem: POST `{ key, verifier }` over HTTPS to the configured redeem URL, with a timeout, refusing redirects. Success returns `{ access_token, refresh_token }`.
- Store the session in the platform secure store (Keychain on iOS, Keystore on Android), never in plain AsyncStorage. Feed the Supabase client through a custom storage adapter backed by that store.
- Then re-read the user's own entitlement row. On any failure return to signed out with a generic message; never show why a key failed.
- Expo Go uses a different scheme; verify the real round trip on a development or production build, not only Expo Go.

## Entitlements and gating
- Plan ids: `free | sync | library | touring`. The plan comes only from the user's entitlement row (RLS scopes it). A deep link or success page never changes it.
- Free is desktop-only. Sync and above get the mobile app, including listening to audio stored in the cloud (within the plan's cap: sync 10 GB, library 250 GB, touring 1 TB).
- Cache the last entitlement with a 30-day offline trust window. The cache only drives UI; the server enforces storage caps and cloud access.
- `past_due` keeps access with a payment banner. `canceled` and `none` behave as free for features; cloud data stays downloadable through the paid period and 60 days after (read-only).
- Locked features are visible-but-locked, never hidden. Free signed-in users see "Manage your plan on deepcrated.com".

## Rules
- Only the Supabase URL and anon key belong in this repo (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`), plus the public site URL (`EXPO_PUBLIC_SITE_URL`, https only outside development). Never the service role, Stripe or B2 keys. Anything with the `EXPO_PUBLIC_` prefix is public.
- Any new package (secure store, web browser, linking, crypto) is a new dependency: check what is installed and get approval.
- Before any iOS submission, Sign in with Apple must exist on the website login page (App Store guideline 4.8, since Google login is offered).
- Custom schemes can be claimed by other apps. The verifier protects the handoff; consider universal links later as a hardening step (TODO for the owner).