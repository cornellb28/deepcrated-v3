---
name: "deepcrated-web-checkout"
description: "Stripe Checkout Sessions, customer portal, pricing page and success/cancel redirects on the DeepCrated website (deepcrate-web, Vercel). Use whenever work touches checkout, pricing pages, Stripe customers, subscriptions purchase flow, or the customer portal. Read deepcrated-account-contract first."
---

# Web checkout (deepcrate-web)

Read `deepcrated-account-contract` (v4.2) first. Inspect the existing framework, routes, and Stripe code before changing anything; don't assume a layout. v2's license-key flow is reference only. Spell the product "DeepCrated" in all copy.

- The pricing page shows exactly the contract's plans, with a Monthly/Annual toggle: Sync $10 / $100, Library $19 / $190, Touring $55 / $550, with the desktop app clearly free. Annual is 10 x monthly (two months free). Prices, caps and inclusions come from the contract, never from memory.
- Require a signed-in user before creating a Checkout Session. `/api/checkout` takes a plan and an `interval` (month or year); validate the interval on the server (missing means month, invalid returns 400) and choose the Price on the server. Six Price IDs, read from env vars `STRIPE_PRICE_SYNC`, `STRIPE_PRICE_LIBRARY`, `STRIPE_PRICE_TOURING` and `STRIPE_PRICE_SYNC_ANNUAL`, `STRIPE_PRICE_LIBRARY_ANNUAL`, `STRIPE_PRICE_TOURING_ANNUAL`. Test-mode and live-mode IDs differ, so set them per Vercel environment. Never invent Price IDs.
- Set `client_reference_id` to the Supabase `user_id`. Reuse an existing `stripe_customer_id` to avoid duplicate customers.
- Success/cancel URLs and the final redirect into the desktop app use the real deep-link scheme from the desktop protocol handler (ask if unknown). The success page names the plan and whether it is monthly or annual, read from the session's price.
- Stripe customer portal for manage/cancel/upgrade. Configure it in Stripe so both the monthly and annual price of each product are listed, otherwise customers cannot switch intervals; any other scope is an open decision.
- Subscriptions are sold on the website only. Mobile never links into a purchase flow without the owner confirming current App Store rules.
- Not built yet, leave TODOs only: extra 250 GB add-on ($15/mo; re-check against B2 costs first), and creating the six live-mode prices before launch.
- Stripe **test mode** until the owner says go live.
- Nothing from the client counts as proof of payment; only the webhook changes entitlements.
- Any price, cap or inclusion change must be re-checked against the contract's 75% worst-case margin guardrail first.

**Done means:** a test-mode checkout for each of the three plans, monthly and annual, completes and, via the webhook, the entitlement row updates to the right plan; the browser-to-desktop redirect works.