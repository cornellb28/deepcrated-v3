-- ─── public.stats_events ──────────────────────────────────────────────────
-- Opt-in anonymous usage stats from the desktop app. Written only after the
-- user turns on "Contribute anonymous stats", and deliberately separate from
-- accounts:
--
--   * No user_id column and no foreign key to auth.users. The only identifier
--     is anon_install_id, a random UUID generated on the device at opt-in and
--     discarded on opt-out. It is not derived from anything about the user.
--   * Inserts are open to the `anon` role only. The desktop app sends the
--     publishable key and NO user token for these requests, so the database
--     sees `anon`, never `authenticated`. A signed-in session cannot write
--     here even by accident, which is what keeps rows from being tied to an
--     account.
--   * No SELECT, UPDATE or DELETE for any client role. Only the service role
--     (analysis jobs, never the app) can read.
--   * Timestamps are floored to the hour, and there is no server-side
--     received_at, so row timing is no finer than the client's.
--
-- The event_type list below must match src/main/stats/schema.ts; a unit test
-- (tests/unit/stats-schema.spec.ts) fails if they drift apart.
--
-- Known limitation: anyone holding the publishable key can insert rows, so
-- the constraints below are the only validation. Rate limiting belongs at the
-- edge (Supabase project settings / a WAF rule), not in this table.

create table if not exists public.stats_events (
  id               bigint generated always as identity primary key,

  anon_install_id  uuid        not null,

  event_type       text        not null
    check (event_type in (
      'app_session',
      'crate_created',
      'track_added_to_crate',
      'track_tagged',
      'track_played'
    )),

  -- Field-level validation happens in the app against the allowlist; here
  -- the payload is only required to be a small JSON object.
  payload          jsonb       not null
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1024),

  app_version      text        not null
    check (length(app_version) <= 32
           and app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),

  -- The hour the event happened in, UTC. Anything finer is rejected.
  created_at       timestamptz not null
    check (created_at = date_trunc('hour', created_at))
);

create index if not exists stats_events_type_created_idx
  on public.stats_events (event_type, created_at);

alter table public.stats_events enable row level security;

-- Start from nothing, then grant exactly INSERT to anon. `authenticated` gets
-- no grant and no policy on purpose (see the header).
revoke all on public.stats_events from public, anon, authenticated;
grant insert on public.stats_events to anon;

drop policy if exists stats_events_anon_insert on public.stats_events;
create policy stats_events_anon_insert
  on public.stats_events
  for insert
  to anon
  with check (true);
