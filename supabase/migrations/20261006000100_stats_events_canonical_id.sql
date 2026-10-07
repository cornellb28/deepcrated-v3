-- ─── stats_events: canonical_track_id on track-scoped events ──────────────
-- Track-scoped events carry payload->>'canonical_track_id', the one track
-- identifier that may leave a device: a public recording identifier,
--   isrc:<ISRC> | mbid:<MusicBrainz recording uuid> | fp:<40 hex>
-- (see src/main/identity/canonical.ts). Never a path, filename or local id.
--
-- The check is a backstop to the app-side allowlist: it rejects a track
-- event without an id, and any id that is not one of the three shapes, so a
-- path cannot be inserted in this field even by a modified client.
--
-- The track-scoped event list must match src/main/stats/schema.ts (a unit
-- test, tests/unit/stats-schema.spec.ts, fails if they drift apart).
--
-- NOT VALID: applies to every new row without scanning existing ones, so this
-- is safe to run whether or not the table already holds events.

alter table public.stats_events
  drop constraint if exists stats_events_canonical_track_id_check;

alter table public.stats_events
  add constraint stats_events_canonical_track_id_check
  check (
    event_type not in (
      'track_added_to_crate',
      'track_tagged',
      'track_played'
    )
    or (
      payload ->> 'canonical_track_id' ~
        '^(isrc:[A-Z]{2}[A-Z0-9]{3}[0-9]{7}|mbid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|fp:[0-9a-f]{40})$'
    )
  ) not valid;
