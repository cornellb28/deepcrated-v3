---
name: "deepcrated-web-webhook"
description: "The Stripe webhook (Vercel serverless) that writes DeepCrated entitlements, in deepcrate-web. Use whenever work touches the webhook handler, Stripe signature verification, event handling, price-to-plan mapping, idempotency, the service role key, or writing subscription state to Supabase. Read deepcrated-account-contract first."
---

# Stripe webhook (deepcrate-web)

Read `deepcrated-account-contract` (v4.2) first. This is the **only writer of entitlements**. Keep it narrow: no extra endpoints, no general API for the apps. (The cloud-storage endpoints are a separate, documented set in the contract and do not write entitlements.)

- **Verify the signature against the raw request body.** Serverless body parsing is the usual failure; confirm the handler gets raw bytes.
- **Idempotent:** record each processed event ID and skip repeats.
- Write with the **service role** key inside this function only. Server-only env var, never client-exposed, never logged.
- Return 2xx quickly. For out-of-order events, re-fetch the subscription from Stripe instead of trusting arrival order.
- **Price-to-plan mapping:** map the subscription's price id to a plan id (`sync | library | touring`) and an interval (month or year) using all six env vars: `STRIPE_PRICE_SYNC`, `STRIPE_PRICE_LIBRARY`, `STRIPE_PRICE_TOURING` and the `_ANNUAL` versions of each. An unknown price id is logged and ignored, never granted. An annual subscriber must never end up with no plan.
- Status handling: `past_due` keeps access (the app shows a banner); when Stripe cancels an unpaid subscription, or on `customer.subscription.deleted`, set `canceled`, which behaves as `free`. Cloud data then stays accessible through the paid period and is read-only (downloads allowed, uploads blocked) for 60 days after it ends; the webhook starts that window, and a failure there should return an error so Stripe retries. The deletion job and the cancelled-subscription sweep are TODOs.
- Event mapping is in the contract; don't diverge from it without flagging a contract change.
- Test mode until the owner says go live.

**Done means:** with the Stripe CLI forwarding events: checkout, renewal, failed payment, cancellation and a plan change, monthly and annual, all update the row to the right plan and status; a replayed duplicate event is a no-op; an unknown price id grants nothing; a second user can't read the first user's row and a client can't write it.