---
name: deepcrated-web-webhook
description: The Stripe webhook (Vercel serverless) that writes entitlements for DeepCrate, in deepcrate-web. Use whenever work touches the webhook handler, Stripe signature verification, event handling, idempotency, the service role key, or writing subscription state to Supabase, even if the user just says "payments aren't updating" or "the webhook". Read deepcrate-account-contract first.
---

# Stripe webhook (deepcrate-web)

Read `deepcrate-account-contract` first. This is the **only server-side piece** and the only writer of entitlements. Keep it narrow: no extra endpoints, no general API for the desktop app.

- **Verify the signature against the raw request body.** Serverless body parsing is the usual failure; confirm the handler gets raw bytes.
- **Idempotent:** record each processed event ID and skip repeats.
- Write with the **service role** key inside this function only. Server-only env var, never client-exposed, never logged.
- Return 2xx quickly. For out-of-order events, re-fetch the subscription from Stripe instead of trusting arrival order.
- Event mapping is in the contract; don't diverge from it without flagging a contract change.
- Test mode until the owner says go live.

**Done means:** with the Stripe CLI forwarding events: checkout, renewal, failed payment, cancellation all update the row; a replayed duplicate event is a no-op; a second user can't read the first user's row and a client can't write it.
