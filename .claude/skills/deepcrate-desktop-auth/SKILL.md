---
name: deepcrate-desktop-auth
description: Sign-in, sign-out, session storage, and Supabase auth in the DeepCrate desktop app (cratecloud-v3, Electron). Use whenever work touches login, signup, Google OAuth, Supabase client setup, session or token storage, safeStorage, or what the renderer may know about the user, even if the user just says "login" or "accounts". Read deepcrate-account-contract first.
---

# Desktop auth (cratecloud-v3)

Read `deepcrate-account-contract` first. Inspect existing auth, Supabase, and v2 license-token code before changing anything; v2's license-key flow is reference only.

- Run the Supabase client and session handling in the **Electron main process**. The renderer gets derived state over IPC only (`signedIn`, `email`, `plan`, `status`). Tokens never reach the renderer.
- Persist the session with `safeStorage` (plaintext fallback only if no OS secret store exists, as the v2 license token did).
- Methods: email/password and Google OAuth. OAuth opens the system browser, never an embedded webview.
- `@supabase/supabase-js` or any auth helper is a **new dependency: get approval**; check if it's already installed.
- Sign-out clears the stored session and the cached entitlement.
- Only the Supabase URL and anon key belong in this repo. Never the service role or Stripe keys.

**Done means:** verified against the real Supabase project: sign up, sign in (email + Google), sign out, relaunch with cached session. A second test user cannot read the first user's rows.