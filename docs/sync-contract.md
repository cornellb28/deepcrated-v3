# Sync contract (desktop ⇄ mobile ⇄ Supabase)

Spec for the Supabase tables. Nothing in this document is implemented as sync
code yet; desktop only carries the identity and change-tracking the sync layer
will read (`src/main/syncSchema.ts`). The mobile mirror is
`deepcrated-mobile/src/db/migrations/001_initial.ts`.

Decisions of 2026-10-09 (track identities, keys, retention, tiers, ownership)
are folded in below. **TODO(sync): none of them is implemented yet** — no
desktop schema, Supabase migration or mobile mirror exists for
`track_identities`.

## Synced tables

`tracks`, `tags`, `track_tags`, `crates`, `crate_tracks`, `track_identities`,
`track_availability`.

Not synced, on either side: `filepath`, `filename`, `folder_id`, `folders`,
`library_roots`, `partial_hash`, `missing`, `last_seen_at`, artwork columns,
`waveform`, `boards`/`board_id`, `needs_sync`, `pending_changes`, `plays`,
`stats_*`, `last_exported_at`, `last_modified`, watcher state. Changing only
these never produces a sync change. (`missing` reaches other devices only as
`track_availability`, below — never as a `tracks` column.)

Track identity is synced only through the separate `track_identities` table
(see below), never as columns on `tracks`. These identity columns stay
device-local: `canonical_track_id` (each device computes it from the synced
inputs), `acoustid_fingerprint`, `fingerprint_duration`, `fingerprint_status`,
`fingerprint_hash` (only its keyed form, `fingerprint_key`, is sent),
`identity_tags_read`, and the `identity_lookup_cache` table.

## Conventions

| Rule | Value |
|---|---|
| Row identity | `client_uuid`, UUID v4, lower-case, minted by the creating device, never reassigned |
| Local ids | Integer `id` is device-local and never sent |
| Timestamps on the wire | **epoch milliseconds**, `bigint` |
| Last-write-wins key | `updated_at` (mobile name) = desktop `sync_updated_at` |
| Deletes | Wire: `deleted_at` (epoch ms) set on the row. Desktop: hard delete + `sync_tombstones` row (see below) |
| Multi-value delimiter | `" | "` (space, pipe, space), always |

### Timestamp mapping

Desktop's legacy columns are *not* epoch ms and are not used for sync:

| Desktop column | Unit | Use |
|---|---|---|
| `tracks.updated_at` | TEXT `YYYY-MM-DD HH:MM:SS` UTC | legacy, ignore |
| `crates.updated_at` | epoch seconds | legacy, ignore |
| `*.sync_updated_at` (all five tables) | **epoch ms** | sent as `updated_at` |

Other timestamp columns are converted **at sync time** by the desktop sync
layer:

| Wire field | Desktop source | Conversion |
|---|---|---|
| `tracks.added_at` | `tracks.added_at` TEXT UTC | parse, ×1000 |
| `tracks.analyzed_at` | `tracks.analyzed_at` TEXT UTC | parse, ×1000 |
| `tracks.created_at` | `tracks.created_at` INTEGER | **TODO(sync): unit unverified** |
| `tags.created_at` | seconds | ×1000 |
| `track_tags.applied_at` | seconds | ×1000 |
| `crates.created_at` | seconds | ×1000 |
| `crate_tracks.added_at` | seconds | ×1000 |

`sync_updated_at` is bumped by database triggers whenever a **synced** column
changes value. Writing an identical value (a rescan) or a device-local column
does not bump it.

## Tables

`updated_at` and `deleted_at` below are on the wire; on desktop the first is
`sync_updated_at` and the second is derived from `sync_tombstones`.
Every table also has `client_uuid` (unique), `updated_at` (bigint, not null),
`deleted_at` (bigint, nullable).

### tracks

| Column | Type | Notes |
|---|---|---|
| title | text not null default '' | |
| artist | text | **derived** display string, see Delimiter rule |
| album | text | single-valued; may contain a literal `" | "` |
| genre, remixer, grouping, composer, comment, label | text | derived display strings |
| key_val | text | |
| year | text | |
| bpm | real | |
| key_camelot, key_full, camelot, openkey | text | |
| duration_sec | real | |
| duration_str | text | |
| format | text | |
| energy | integer | |
| created_at | bigint | see mapping |
| added_at | bigint not null | |
| analyzed_at | bigint | |

Desktop watched columns (a change to any re-stamps): all of the above.

### tags

| Column | Type | Notes |
|---|---|---|
| field | text not null | `artist, genre, label, vibe, venue, custom, comment, grouping, remixer, composer, album` |
| value | text not null | |
| color | text not null default `#7f77dd` | |
| created_at | bigint not null | |

Uniqueness: `(field, value)` among **live** rows (`deleted_at is null`), as a
partial unique index, so a deleted tag does not block re-creating it.
Desktop enforces `UNIQUE(field, value)` outright; it hard-deletes, so the two
agree.

### track_tags

| Column | Type | Notes |
|---|---|---|
| track_uuid | uuid not null | → `tracks.client_uuid` |
| tag_uuid | uuid not null | → `tags.client_uuid` |
| applied_at | bigint not null | |

No database foreign keys on the uuids: a pull can deliver a join row before
its track or tag.

### crates

| Column | Type | Notes |
|---|---|---|
| name | text not null | |
| color | text not null default `#7f77dd` | |
| parent_crate_uuid | uuid | → `crates.client_uuid`; null = top level |
| created_at | bigint not null | |

Desktop stores `parent_crate_id`; the sync layer resolves it to the parent's
uuid. A parent may arrive after its child.

### track_identities

A track's public recording identifiers, kept in their own table rather than
on `tracks`. The identity backfill writes in the background; if these were
watched `tracks` columns, a backfill stamp could make a device's stale copy
of a track win last-write-wins over a newer edit made elsewhere.

| Column | Type | Notes |
|---|---|---|
| track_uuid | uuid not null | → `tracks.client_uuid`; no database foreign key (may arrive before its track) |
| isrc | text | from the file's tags |
| musicbrainz_recording_id | text | from the tags or the optional online lookup |
| recording_id_source | text | `tag` or `lookup`; null when there is no recording id |
| fingerprint_key | text | per-account keyed hash, see Key handling |

Plus `client_uuid`, `updated_at`, `deleted_at` like every table. At most one
live row per `track_uuid`.

Deleting a track also deletes its `track_identities` row, and that delete is
recorded in `sync_tombstones` like any other synced row.

**`fingerprint_key`** = HMAC(account key, `fingerprint_hash`). The raw
`fingerprint_hash` and `acoustid_fingerprint` never leave the device. Keying
per account means a synced row cannot be joined to the `fp:` id that
anonymous stats carries, while matching a user's own tracks across their
own devices still works (same account, same key version).

**Merge rule** (every client applies exactly this, field by field):

1. A tag-sourced value beats a lookup-sourced one.
2. A non-empty value beats an empty one.
3. Within the same source, the later `updated_at` wins (tie: the larger
   `client_uuid`, as everywhere else).

Identity values are facts, not edits, so plain row-level last-write-wins
does not apply to this table.

**Key handling.** The server issues each signed-in device a **versioned** key
derived from a master secret. The master secret lives in Vercel environment
settings, never in the database or any client. Devices store their key with
`safeStorage`. Each `fingerprint_key` records the key version it was made
with, so the key can be rotated: after a rotation devices re-key their rows,
and rows of an old version are not compared with rows of a new one.
**TODO(sync): issuing endpoint, derivation and the version column are not
designed in detail yet.**

**Matching.** A shared ISRC, recording id or `fingerprint_key` is a
suggestion, shown as "probably the same". It never merges, deletes or
relinks anything on its own: ISRCs get reused on remixes, and a fingerprint
only matches near-identical audio.

**Paid features** (cross-device recognition, cloud duplicates, restore) use
only tag-sourced ids (`isrc`, and `musicbrainz_recording_id` where
`recording_id_source = 'tag'`) plus `fingerprint_key`, until AcoustID
commercial terms are sorted. Lookup-sourced recording ids still sync, but no
paid feature may depend on them. Local features may use either.

### track_availability

Whether desktop can currently find a track's audio file. Other devices use
it to show a track as unavailable (moved, on an unplugged drive, deleted
from disk outside DeepCrated) without guessing.

| Column | Type | Notes |
|---|---|---|
| track_uuid | uuid not null | → `tracks.client_uuid`; no database foreign key (may arrive before its track) |
| available | boolean not null | `true` when desktop finds the file; desktop's `tracks.missing = 0` |

Plus `client_uuid`, `updated_at`, `deleted_at` like every table. At most one
live row per `track_uuid`.

- **Written by desktop only, and only when availability changes** — a file
  going missing or coming back. A rescan or watcher pass that finds the same
  state as before writes nothing, so scans do not churn sync.
- **Read-only everywhere else.** Mobile and the server never write it.
- **Separate from `tracks`** so an availability change never bumps
  `tracks.updated_at`: a desktop that has not yet pulled a metadata edit
  made on mobile must not win last-write-wins on `tracks` just because a
  drive was unplugged.
- Plain last-write-wins on `updated_at`.
- Deleting a track also deletes its `track_availability` row, recorded in
  `sync_tombstones` like any other synced row.

**TODO(sync): with more than one desktop, the last desktop to write wins;
per-device availability is not modelled.**

### crate_tracks

| Column | Type | Notes |
|---|---|---|
| crate_uuid | uuid not null | → `crates.client_uuid` |
| track_uuid | uuid not null | → `tracks.client_uuid` |
| position | integer not null | gapped (1000, 2000, …); sort ascending |
| added_at | bigint not null | |

## Join-row identity

Join rows have their **own `client_uuid`**, like every other row. Desktop
stores it on `track_tags` and `crate_tracks`; desktop's integer foreign keys
(`track_id`, `tag_id`, `crate_id`) are unchanged and the sync layer resolves
`track_uuid` / `tag_uuid` / `crate_uuid` by lookup.

Because two devices can independently create the *same* pair and mint
different uuids, the server must also enforce uniqueness on the pair among live
rows:

```sql
unique (track_uuid, tag_uuid)  where deleted_at is null   -- track_tags
unique (crate_uuid, track_uuid) where deleted_at is null  -- crate_tracks
```

Proposed rule on a pair collision: keep the row with the later `updated_at`
(tie: the larger `client_uuid`), and soft-delete the other so the delete syncs
back. Every client must apply the same rule.
**TODO(sync): proposed, not decided or implemented.**

A tag merge on desktop re-points an existing `track_tags` row to the surviving
tag (`tag_uuid` changes, `client_uuid` is kept, `updated_at` is bumped) or, if
the track already had the surviving tag, deletes it (tombstone).

## Delete semantics

- **Wire / Supabase / mobile**: soft delete — set `deleted_at` (epoch ms) and
  bump `updated_at`. A delete is just a newer version of the row. Clients
  need the tombstone to learn of the delete, so the server only removes it on
  the schedule in Retention below: the row's content (and any stored audio)
  after 14 days, the bare delete record (`client_uuid`, `deleted_at`,
  `updated_at`) after 90.
- **Desktop**: still hard-deletes (its `PRIMARY KEY` / `UNIQUE` constraints
  would make `INSERT OR IGNORE` silently no-op against a soft-deleted row).
  `BEFORE DELETE` triggers record `sync_tombstones(table_name, row_uuid,
  deleted_at)` for every synced table — including rows removed by foreign-key
  cascade (deleting a track, tag, or crate, and sub-crates).
- The desktop sync layer pushes each tombstone as `deleted_at` on that uuid,
  then prunes pushed tombstones. **TODO(sync): pruning and push are not
  implemented; `sync_tombstones` currently only grows.**
- A deleted-then-recreated thing is a **new** uuid. A deleted uuid is never
  reused or brought back, even after its delete record has expired.
- **A track deleted on desktop is never undeleted.** No device, the server
  included, can bring it back: a live version of that track arriving from
  anywhere loses to desktop's delete, whatever its `updated_at` (see
  Conflict resolution). Re-adding the file on desktop creates a new track.
- **Until the 14-day purge**, mobile still lists a track deleted on desktop,
  marked as deleted, with two actions only:
  - **Download a copy** — saves the stored audio to the phone (only where the
    plan stores audio, and only until the purge);
  - **Remove from cloud now** — purges its content and stored audio at once,
    keeping only the bare delete record (the same end state as the 14-day
    purge, just earlier).

  Mobile cannot edit, re-tag, crate or restore it.
- **Pull of a remote delete** onto desktop is a hard delete of the local row.
  That fires the tombstone trigger, so the sync layer must delete the
  tombstone it just caused or it will echo the delete back.
  **TODO(sync): echo suppression.**

## Delimiter rule

Multi-value text columns (`artist`, `genre`, `grouping`, `label`, `remixer`,
`composer`, `comment`) are **derived display strings**: the `tags` rows
attached via `track_tags` are the source of truth, joined with `" | "`.

- Write with `" | "` only.
- Never split on a comma, ampersand, bare slash, ` x `, `feat.` or `;` —
  "Tyler, The Creator", "Drum & Bass" and "AC/DC" are single values.
- Desktop also **reads** the legacy `" / "` when splitting, so rows and files
  written by older builds still split. It is never written.
- **`album` is the exception.** It is single-valued and real album names contain
  `" | "` ("DMS | Spinser Tracy"), so it is never split on `" | "`. Desktop
  still joins a (rare) multi-value album with `" / "`.
- Multi-artist order is `track_tags` insertion order on desktop and is not
  represented on the wire; `tracks.artist` carries the order. Mobile should
  treat `tracks.artist` as the display value and not re-derive it from tags.
  **TODO(sync): if mobile ever edits artist tags, order needs a `position`.**

Existing data was migrated once (`user_version` 2): `" / "` → `" | "` in those
columns, with the previous values kept in `_delimiter_backup_v2`.
**TODO(delimiter): audio files on disk still hold `" / "` until rewritten.**

## Conflict resolution

Per-row last-write-wins on `updated_at`. Ties: the larger `client_uuid` string
wins, so every client picks the same winner. A row with `deleted_at` set
wins over an older live version, and loses to a live version with a newer
`updated_at`. Two exceptions:

- **A track deleted on desktop**: the delete always wins, however new the
  live version (see Delete semantics).
- **`track_identities`** uses its own merge rule (see that table).

## Retention

Decided 2026-10-09. This closes the account contract's open question on the
grace period before cloud data is deleted.

| Case | Rule |
|---|---|
| Deleted track | Content and stored audio purged from the cloud **14 days** after `deleted_at` |
| Delete records | The bare record (uuid + timestamps) kept **90 days**, then removed |
| Device offline > 90 days | Must do a **full re-check** against the server before syncing again: it may have missed deletes whose records have since expired, so it cannot rely on incremental pull |
| Canceled subscription | Full access until the end of the paid period, then **60 days read-only** with a warning email, then cloud data is deleted |
| Deleted account | Purged after **60 days**, with an option to delete immediately |

**TODO(sync): none of these jobs exist yet** (purge, record expiry, the
read-only state, the warning email, the full re-check).

## Tiers

Decided 2026-10-09. Local features stay free and are never gated.

| Plan | Price | Audio storage | What it adds |
|---|---|---|---|
| Free | — | None | Desktop only. No cloud sync, no mobile |
| Sync | **$10/month or $100/year** | **10 GB** (Cloudflare R2) | Cross-device tags and metadata, cloud duplicates |
| Library | Monthly per the account contract; yearly TBD | 250 GB | Everything in Sync |
| Touring | Monthly per the account contract; yearly TBD | 1 TB | Everything in Sync |

**Conflicts with the account contract (v4, 2026-10-08)**, which still says
Sync is $5/month with no audio upload or cloud storage, and has no annual
billing. It also caps any annual discount at 10%; $100/year against
$10/month is about 17% off, so that cap has to change too. That contract (an
identical copy in `deepcrated-web`) is the source of truth for plans,
prices and caps until it is updated, and its margin guardrail must be
re-checked for 10 GB on Sync before it is. **TODO(contract): update the
account contract in both repos.** Library and Touring prices are unchanged
there.

## Schema ownership

`deepcrated-web` owns **all** Supabase migrations, including `stats_events`.
**TODO(ownership): `stats_events` still lives in this repo**
(`supabase/migrations/20261006000000_stats_events.sql`,
`20261006000100_stats_events_canonical_id.sql`) and moves to `deepcrated-web`.
`tests/unit/stats-schema.spec.ts` reads those files to check them against the
allowlist, so that test needs a new source when they move.

## Desktop schema reference

Added by `applySyncSchema` (`user_version` 1), additive only:

| Table | Added |
|---|---|
| tags, crates, track_tags, crate_tracks | `client_uuid TEXT` + partial unique index `WHERE client_uuid IS NOT NULL` |
| all five | `sync_updated_at INTEGER` (epoch ms) + index |
| new | `sync_tombstones(table_name, row_uuid, deleted_at, PK(table_name,row_uuid))` |
| per table | `AFTER INSERT` (fills uuid/stamp), `AFTER UPDATE` (stamps on synced-column change), `BEFORE DELETE` (tombstone) triggers |

Backfill: uuids are random v4; `sync_updated_at` = the legacy value × 1000
(tracks: parsed from `updated_at`; tags: `created_at`; crates: `updated_at`;
track_tags: `applied_at`; crate_tracks: `added_at`).

`tracks.client_uuid` predates this migration and is untouched. Note it is
also written to the audio file's `CRATECLOUD_ID` tag, which is how a track
survives a rename or move.

## Rollback

The migration is additive; older builds ignore the new columns, triggers and
table. The app copies `library.db` to `library.db.backup-pre-sync-<timestamp>`
before migrating.

1. **Preferred**: quit the app and restore that backup file.
2. **In place**: drop the triggers named `trg_sync_*`, drop `sync_tombstones`,
   drop the `idx_*_client_uuid` and `idx_*_sync_updated` indexes, then
   `ALTER TABLE … DROP COLUMN` for `client_uuid` / `sync_updated_at` on the
   tables above, and set `PRAGMA user_version = 0`.
3. **Delimiter only**:
   `UPDATE tracks SET <field> = b.value FROM _delimiter_backup_v2 b WHERE
   tracks.id = b.track_id AND b.field = '<field>'` for each field, then
   `PRAGMA user_version = 1`. Note the old build's `DISPLAY_DELIMITER` is
   `" / "`, so run this together with the code rollback.
