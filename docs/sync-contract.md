# Sync contract (desktop ⇄ mobile ⇄ Supabase)

Spec for the Supabase tables. Nothing in this document is implemented as sync
code yet; desktop only carries the identity and change-tracking the sync layer
will read (`src/main/syncSchema.ts`). The mobile mirror is
`deepcrated-mobile/src/db/migrations/001_initial.ts`.

## Synced tables

`tracks`, `tags`, `track_tags`, `crates`, `crate_tracks`.

Not synced, on either side: `filepath`, `filename`, `folder_id`, `folders`,
`library_roots`, `partial_hash`, `missing`, `last_seen_at`, artwork columns,
`waveform`, identity/fingerprint columns, `boards`/`board_id`, `needs_sync`,
`pending_changes`, `plays`, `stats_*`, `last_exported_at`, `last_modified`,
watcher state. Changing only these never produces a sync change.

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
  bump `updated_at`. A delete is just a newer version of the row. Never
  hard-delete on the server; clients need the tombstone to learn of the delete.
- **Desktop**: still hard-deletes (its `PRIMARY KEY` / `UNIQUE` constraints
  would make `INSERT OR IGNORE` silently no-op against a soft-deleted row).
  `BEFORE DELETE` triggers record `sync_tombstones(table_name, row_uuid,
  deleted_at)` for every synced table — including rows removed by foreign-key
  cascade (deleting a track, tag, or crate, and sub-crates).
- The desktop sync layer pushes each tombstone as `deleted_at` on that uuid,
  then prunes pushed tombstones. **TODO(sync): pruning and push are not
  implemented; `sync_tombstones` currently only grows.**
- A deleted-then-recreated thing is a **new** uuid. Tombstones are never
  cleared.
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
`updated_at`.

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
