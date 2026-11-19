---
name: "deepcrated-web-auth-pages"
description: "Login and signup pages, Supabase redirect allowlists, and the return path into the desktop connect page on the DeepCrated website (deepcrate-web). Use whenever work touches the website's sign-in or sign-up UI, Google OAuth on the web, Supabase redirect URLs, why login does nothing, or logging in on behalf of the desktop or mobile app. Read deepcrated-account-contract first."
---

# Web auth pages (deepcrate-web)

Read `deepcrated-account-contract` (v4.2) first. Inspect the existing framework and auth code before changing anything. Spell the product "DeepCrated" in all copy.

- Email/password and Google OAuth against the **same** Supabase project the desktop and mobile apps use.
- Every redirect URL on the website must be on the Supabase allowlist. A missing entry is the first thing to check when login does nothing.
- Login and signup must support returning the visitor to a **next path** after success, for both email and Google. The app flow depends on it: after login the visitor must land back on `/desktop/connect` with its `client`, `challenge` and `state` query values intact.
- Only the next path on your own site is allowed. Never redirect to an arbitrary URL.
- The app handoff itself (the connect page and the create and redeem endpoints) is covered by `deepcrated-web-desktop-handoff`. Do not put tokens in any URL.
- Only the Supabase URL and anon key are public. The service role key is server-only.
- The account and profile area follows Claude's profile layout, and the site's design direction is Spotify-style. Plan labels shown there are Free, Sync, Library and Touring, read from the entitlement row.
- Subscriptions are bought on the website only. Sign-in pages reached from the mobile app must not add a purchase flow without the owner confirming current App Store rules.
- **Before any iOS app submission, add Sign in with Apple to the login page.** App Store guideline 4.8 requires an equivalent login option when Google login is offered. This is still an open TODO.

**Done means:** a full browser round trip works for both email and Google login, including returning to the connect page with its query values intact.