-- ─── entitlements: price id + the cloud/mobile tier vocabulary ────────────
-- An evolution of 20260922000000_entitlements.sql, not a replacement. That
-- migration already shaped this table for a recurring subscription
-- (stripe_subscription_id, status accepting every Stripe value,
-- current_period_end, cancel_at_period_end, RLS = own-row SELECT only).
-- This one changes two things and nothing else.
--
-- Still true, and still the point: NOTHING in the desktop app gates on this
-- table. The desktop app is free. This tracks the cloud/mobile subscription
-- sold from the payments website, whose Stripe webhook is the only writer.

-- ── 1. stripe_price_id ───────────────────────────────────────────────────
-- Which price (not just which product) the subscription is on. The webhook
-- writes it; it is what tells 'cloud_mobile' from 'cloud_mobile_plus' when
-- a plan changes mid-period, and what a later proration or upgrade path
-- reads. Deliberately un-indexed: Stripe events carry the customer or
-- subscription id, never the price, so nothing looks a row up by this.
alter table public.entitlements
  add column if not exists stripe_price_id text;

-- ── 2. The plan vocabulary ───────────────────────────────────────────────
-- ⚠ PROVISIONAL NAMES. 'cloud_mobile' and 'cloud_mobile_plus' are
-- placeholders agreed 2026-09-23 while the tier lineup is still being
-- decided, and they WILL change. Nothing downstream should branch on a
-- specific paid value: treat "not 'free'" as "on a paid tier" and read the
-- name for display only. The desktop app's plan.ts does exactly that, and
-- falls back to showing the raw value if it meets one it does not know.
--
-- 'sync' was the previous single paid value. Nothing can have written it —
-- the webhook that writes `plan` does not exist yet, and the signup trigger
-- only ever inserts 'free' — but the remap below runs first anyway, so this
-- migration cannot fail on a row that somehow has it.
update public.entitlements
  set plan = 'cloud_mobile'
  where plan = 'sync';

alter table public.entitlements
  drop constraint if exists entitlements_plan_check;

alter table public.entitlements
  add constraint entitlements_plan_check
  check (plan in ('free', 'cloud_mobile', 'cloud_mobile_plus'));

-- Everything else is deliberately untouched:
--   status       — keeps all 9 Stripe values and `not null default 'active'`.
--                  A narrower check would make the webhook throw on a live
--                  event (unpaid / incomplete_expired / paused are real),
--                  and the event most likely to hit it is a declining card.
--   purchased_at — unused but kept, as the hook for a one-time purchase.
--   seats        — kept; may matter for a multi-device/family cloud tier.
--   RLS          — unchanged: authenticated users SELECT their own row,
--                  writes via the service role from the future webhook.
