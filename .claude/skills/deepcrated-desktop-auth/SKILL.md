---
name: deepcrated-desktop-auth
description: Sign-in, sign-out, session storage, and Supabase auth in the DeepCrate desktop app (deepcrated-v3, Electron). Use whenever work touches login, signup, Google OAuth, Supabase client setup, session or token storage, safeStorage, or what the renderer may know about the user, even if the user just says "login" or "accounts". Read deepcrate-account-contract first.
---

# Desktop auth (deepcrated-v3)

Read `deepcrated-account-contract` first. Inspect existing auth, Supabase, and v2 license-token code before changing anything; v2's license-key flow is reference only.

- Run the Supabase client and session handling in the **Electron main process**. The renderer gets derived state over IPC only (`signedIn`, `email`, `plan`, `status`). Tokens never reach the renderer.
- Persist the session with `safeStorage` (plaintext fallback only if no OS secret store exists, as the v2 license token did).
- **Sign-in and sign-up happen on the website, never in an in-app form.** The app opens the website in the **system browser** (never an embedded webview; Google blocks OAuth there), and the website returns to the app by deep link. The app never sees or handles a password.
- The deep link carries only a **one-time key and a state value**, never tokens. The app proves it started the sign-in by sending a secret verifier when it redeems the key over HTTPS (see `deepcrated-desktop-deeplink`). Arriving at the deep link never changes the plan or tier on its own.
- Methods (handled on the website): email/password and Google OAuth. If email confirmation is required, configure that in Supabase so no session is issued until the email is confirmed.
- `@supabase/supabase-js` or any auth helper is a **new dependency: get approval**; check if it's already installed.
- Sign-out clears the stored session and the cached entitlement.
- Only the Supabase URL and anon key belong in this repo. Never the service role or Stripe keys.

## Account UI: the account chip
Sign-in is **optional**. Signed out is a normal state; never block the app or any local feature.
- One **account chip** in a fixed spot (sidebar footer or top-right), Spotify-style: avatar plus dropdown.
- **Signed out:** quiet "Sign in" button and "Create account" link; both open the website in the system browser.
- **Waiting:** spinner and "Waiting for browser..." with Reopen browser and Cancel.
- **Signed in:** avatar (Google profile photo if present and allowed by CSP, else a colored initial), name, plan label once a paid tier exists. Dropdown: email, Manage account (website), Manage subscription (customer portal), Sign out.
- **Offline:** same avatar with a small offline dot; nothing blocked.
- **Session expired:** amber "Sign in again", shown only where cloud features need it.
- When the deep link returns: focus the app window and show a short "Signed in as ..." toast.
- Settings > Account mirrors the chip's states. There is **no email/password or OAuth form in the app**; remove any that exists.
- Optional fallback if the deep link fails: the website callback page shows a short one-time code the user can paste into the app.
- A cached session lets the app open offline; don't force a browser round trip on launch.

**Done means:** verified against the real Supabase project and a **packaged build**: sign up and sign in via the browser (email + Google), unconfirmed email cannot sign in, sign out, relaunch with cached session, offline launch with cached session. A second test user cannot read the first user's rows.