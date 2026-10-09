---
name: deepcrated-web-auth-pages
description: Login and signup pages, Supabase redirect allowlists, and the handoff back to the desktop app on the DeepCrated website (deepcrate-web). Use whenever work touches the website's sign-in or sign-up UI, Google OAuth on the web, Supabase redirect URLs, or why login "does nothing", even if the user just says "login page". Read deepcrate-account-contract first.
---

# Web auth pages (deepcrate-web)

Read `deepcrate-account-contract` first. Inspect the existing framework and auth code before changing anything.

- Email/password and Google OAuth against the **same** Supabase project the desktop app uses.
- Every redirect URL (site URLs and the desktop deep link) must be on the Supabase allowlist. A missing entry is the first thing to check when login does nothing.
- Hand off to the desktop app with a **PKCE / one-time code**, not tokens in the URL.
- Only the Supabase URL and anon key are public. The service role key is server-only.

**Done means:** a full browser, deep link, desktop-signed-in round trip works for both email and Google login.
