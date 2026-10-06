---
name: deepcrate-web-checkout
description: Stripe Checkout Sessions, customer portal, and success/cancel redirects on the DeepCrate website (deepcrate-web, Vercel). Use whenever work touches checkout, pricing pages, Stripe customers, subscriptions purchase flow, the customer portal, or redirecting to the desktop app after payment, even if the user just says "buy button" or "billing page". Read deepcrate-account-contract first.
---

# Web checkout (deepcrate-web)

Read `deepcrate-account-contract` first. Inspect the existing framework, routes, and Stripe code before changing anything; don't assume a layout. v2's license-key flow is reference only.

- Require a signed-in user before creating a Checkout Session.
- Set `client_reference_id` to the Supabase `user_id`. Reuse an existing `stripe_customer_id` to avoid duplicate customers.
- Success/cancel URLs and the final redirect into the desktop app use the real deep-link scheme from the desktop protocol handler (ask if unknown).
- Stripe customer portal for manage/cancel; its scope is an open decision.
- Never invent plan names, prices, or Price IDs. Stripe **test mode** until the owner says go live.
- Nothing from the client counts as proof of payment; only the webhook changes entitlements.

**Done means:** a test-mode checkout completes and, via the webhook, the entitlement row updates; the browser-to-desktop redirect works.