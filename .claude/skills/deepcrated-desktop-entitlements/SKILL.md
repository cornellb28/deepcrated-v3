---
name: deepcrated-desktop-entitlements
description: Reading plan and subscription state in the DeepCrated desktop app (deepcrated-v3), caching it offline, and the locked/upgrade UI for cloud sync and mobile. Use whenever work touches entitlements, plan or subscription status, the Settings Plan page, LockedView, LockBadge, upgrade prompts, or offline behavior tied to accounts, even if the user just says "the plan screen" or "locked features". Read deepcrate-account-contract first.
---

# Desktop entitlements (deepcrated-v3)

Read `deepcrate-account-contract` first. The desktop app only **reads** entitlements; it never writes them.

- Read the signed-in user's own row from Supabase (RLS scopes it). Refresh on sign-in, app focus, and after a deep-link return.
- Cache the last known entitlement locally so the **local-first app opens offline**. The trust window is an open decision: leave a marked TODO, don't invent a number.
- A local SQLite table or column for the cache is a data-layer change: **confirm before implementing.**
- Gated cloud/mobile features use the app-wide **visible-but-locked** pattern: never hidden, never dead-disabled. Reuse `LockedView` and `LockBadge`; both default to the one **See plans** action (`openPlans()`), which opens the website's pricing page.
- Settings > Plan shows plan label and status, plus See plans. No prices in the app. Website pages open by name over `website:open` (fixed URLs in `src/main/websiteLinks.ts`); the renderer never passes a URL. No embedded Stripe or card forms.
- The desktop app itself is free: don't lock existing local features.

**Done means:** subscribe on the website and the app updates; cancel and it updates; offline launch works; verified with Stripe test mode.
