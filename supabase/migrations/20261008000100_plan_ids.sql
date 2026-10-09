-- Final plan ids (pricing model, 2026-10-08): free | sync | library | touring.
-- Replaces the provisional cloud_mobile / cloud_mobile_plus, which are being
-- removed. No rows hold the retired ids, so no data migration is needed.
--
-- The constraint is dropped and re-added rather than altered in place:
-- Postgres has no ALTER for a CHECK expression.

alter table public.entitlements
  drop constraint if exists entitlements_plan_check;

alter table public.entitlements
  add constraint entitlements_plan_check
  check (plan in ('free', 'sync', 'library', 'touring'));
