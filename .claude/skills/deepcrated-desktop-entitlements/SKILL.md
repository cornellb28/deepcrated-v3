---
name: "deepcrated-desktop-entitlements"
description: "Reading plan and subscription state in the DeepCrated desktop and mobile apps, caching it offline, and the locked/upgrade UI for cloud sync and mobile. Use whenever work touches entitlements, plan or subscription status, the Settings Plan page, LockedView, LockBadge, upgrade prompts, or offline behavior tied to accounts. Read deepcrated-account-contract first."
---

# Client entitlements (deepcrated-v3 and deepcrated-mobile)

Read `deepcrated-account-contract` (v4.2) first. The apps only **read** entitlements; they never write them.

- Plan ids are `free | sync | library | touring`. Use the constants from the contract; never invent plans, prices or caps.
- Read the signed-in user's own row from Supabase (RLS scopes it). The plan shown in the app comes **only from that row**, which the Stripe webhook writes. A deep link, URL param, or "success" page never updates the plan.
- Storage caps (free=0, sync=10 GB, library=250 GB, touring=1000 GB) are enforced **server-side only**. The client may display them, never decide them. Sync and above get the mobile app and mobile listening; free is desktop-only.
- Refresh on sign-in, after a deep-link return, and whenever the **app window regains focus**. Focus refresh is the fallback if the deep link fails after checkout.
- Settings has an **"I've signed in / paid, refresh"** button that re-reads the row on demand.
- Show a brief "confirming your purchase..." state after returning from checkout; the webhook can lag a few seconds, so re-check a few times before telling the user it failed.
- Cache the last known entitlement locally so the **local-first app opens offline**. The offline trust window is **30 days** (`OFFLINE_TRUST_MS`). The cache only drives UI state; the server enforces real access.
- `past_due` keeps access and shows an "update your payment method" banner. `canceled` and `none` behave as `free` for features, but the user's cloud data stays accessible: through the paid period, then 60 days read-only (downloads allowed, uploads blocked), per the contract.
- Over the storage cap (for example after a downgrade): block new uploads, still allow downloads and deletes, never purge automatically. Show a clear message, not a silent failure.
- A local SQLite table or column for the cache is a data-layer change: **confirm before implementing.**
- Gated cloud/mobile features use the app-wide **visible-but-locked** pattern: never hidden, never dead-disabled. Reuse `LockedView` and `LockBadge`; they send signed-out users into the website sign-in flow and signed-in free users to **Settings > Plan**.
- Settings > Plan opens the website via `shell.openExternal`. No embedded Stripe or card forms.
- **Mobile sells nothing in-app.** Upgrade prompts say to manage the plan on deepcrated.com, with no prices. Check current App Store rules with the owner before adding any purchase UI or upgrade link.
- The desktop app itself is free: don't lock existing local features.

**Done means:** subscribe on the website and the app updates (via deep link, and also via focus refresh with the deep link disabled); cancel and it updates; offline launch works; a forged deep link changes nothing; verified with Stripe test mode on a packaged build.