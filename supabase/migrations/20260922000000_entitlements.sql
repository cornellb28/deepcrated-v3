-- ─── public.entitlements ──────────────────────────────────────────────────
-- One row per account, created automatically at signup so no code path ever
-- has to cope with an account that has no entitlement.
--
-- Nothing in the DESKTOP app gates on this table. The desktop app is free
-- (settled 2026-09-22) and there is no LockedView/LockBadge to feed. This
-- table exists for the paid surface that is actually coming: cloud sync /
-- mobile, sold as a subscription from the payments website, with that site's
-- Stripe webhook as the only writer.
--
-- Writes are service-role only, by design. There is deliberately no INSERT
-- or UPDATE policy for authenticated users: a client that could write its
-- own `plan` column is not an entitlement, it's a suggestion.

create table if not exists public.entitlements (
  id                         uuid primary key default gen_random_uuid(),

  -- One entitlement per user. ON DELETE CASCADE so deleting an auth user
  -- does not strand a row that no one can reach or clean up.
  user_id                    uuid not null unique
                               references auth.users (id) on delete cascade,

  -- 'sync' is the cloud sync / mobile subscription. There is deliberately no
  -- 'pro' or 'corporate' here: those were the desktop tiers, retired when the
  -- desktop app became free. If a one-time desktop purchase is ever added it
  -- gets its own value and uses the one-time columns further down, which are
  -- kept for exactly that reason.
  plan                       text not null default 'free'
                               check (plan in ('free', 'sync')),

  -- ── Subscription lifecycle (the webhook's business) ──────────────────
  stripe_customer_id         text,
  stripe_subscription_id     text,

  -- Every status Stripe can put on a subscription, plus 'revoked' for a
  -- manual or refund-driven revocation that has no Stripe equivalent.
  --
  -- Accepting ALL of Stripe's values is the point: a check constraint that
  -- rejects a real status would make the webhook fail on a live event, and
  -- the failure would land at the worst possible moment — someone's card
  -- declining. Better a row that says 'past_due' than a 500 and no row.
  --
  -- What counts as entitled is NOT encoded here, deliberately: it depends on
  -- current_period_end as well as status, which no immutable constraint or
  -- generated column can express. The rule belongs in one place in the
  -- website's server code:
  --   entitled = status in ('active','trialing')
  --              or (status = 'past_due' and current_period_end > now())
  -- The grace on past_due is what keeps a retryable card from cutting
  -- someone off mid-set.
  status                     text not null default 'active'
                               check (status in (
                                 'active', 'trialing', 'past_due', 'canceled',
                                 'unpaid', 'incomplete', 'incomplete_expired',
                                 'paused', 'revoked'
                               )),

  -- When access lapses if nothing renews. Null on a free row.
  current_period_end         timestamptz,

  -- They cancelled but have paid through current_period_end. Distinct from
  -- status 'canceled', which is after the period has actually ended.
  cancel_at_period_end       boolean not null default false,

  -- ── One-time purchase (unused today) ─────────────────────────────────
  -- Kept for a future one-time desktop purchase. Nothing writes these now.
  seats                      integer not null default 1 check (seats > 0),
  stripe_checkout_session_id text,
  purchased_at               timestamptz,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- The webhook's two lookup keys. A Stripe event carries the customer or the
-- subscription id, never our user_id, so these are what it resolves a row by.
create index if not exists entitlements_stripe_customer_id_idx
  on public.entitlements (stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists entitlements_stripe_subscription_id_idx
  on public.entitlements (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- ─── RLS ──────────────────────────────────────────────────────────────────
alter table public.entitlements enable row level security;

-- Read your own row, and only your own. No INSERT/UPDATE/DELETE policy
-- exists for authenticated users on purpose (see the header): the service
-- role bypasses RLS entirely, which is how the webhook writes.
drop policy if exists "own entitlement is readable" on public.entitlements;
create policy "own entitlement is readable"
  on public.entitlements
  for select
  to authenticated
  using (user_id = auth.uid());

-- ─── updated_at ───────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists entitlements_touch_updated_at on public.entitlements;
create trigger entitlements_touch_updated_at
  before update on public.entitlements
  for each row execute function public.touch_updated_at();

-- ─── Auto-provision a free row at signup ──────────────────────────────────
-- A DB trigger rather than an app-level fallback: signup can happen without
-- the desktop app in the loop at all — Google OAuth completes in the browser,
-- the payments website will have its own signup, and an admin-created user
-- never touches our code — so the guarantee "every account has an
-- entitlements row" only actually holds if the database is the one making it.
--
-- SECURITY DEFINER because the inserting role during signup has no rights on
-- this table; `set search_path = ''` with fully-qualified names so the
-- definer's elevated rights cannot be redirected by a caller-controlled
-- search_path.
--
-- ON CONFLICT DO NOTHING keeps it idempotent: re-running this migration, or
-- any future backfill, must not fail on accounts that already have a row.
create or replace function public.provision_free_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.entitlements (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_provision_entitlement on auth.users;
create trigger on_auth_user_created_provision_entitlement
  after insert on auth.users
  for each row execute function public.provision_free_entitlement();

-- Backfill any account that predates this migration, so "every account has a
-- row" is true the moment this runs and not just for signups after it.
insert into public.entitlements (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;
