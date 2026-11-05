# Sync contract (desktop ⇄ mobile ⇄ Supabase)

Spec for the synced tables and for how mobile edits reach desktop. Nothing in
this document is implemented as sync code yet; desktop only carries the identity and change-tracking the sync layer
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

Two directions, two rules (decided 2026-11-05):

- **Desktop → mobile (snapshot):** desktop is the source of truth. Mobile
  applies desktop's rows as they are, **without** comparing `updated_at`
  (phone stamps come from the phone's clock, which can run ahead and would
  block desktop's values). A `deleted_at` row from desktop deletes locally.
  Mobile never overwrites a track or crate (or its links) that still has an
  unsent patch entry; it keeps its local value until desktop has answered the
  patch, and pulls that row again next time. Wire format, complete link sets,
  tag merging and paging: `docs/local-sync-protocol.md`, "Pull".
- **Mobile → desktop (patch):** mobile never sends whole rows. It sends
  field-level patch entries, and desktop runs a three-way check per field.
  See *Mobile edits: field-level patches* below. Whole-row last-write-wins is
  **not** used in this direction, because it would undo desktop edits to
  fields the phone never touched.

## Mobile edits: field-level patches

The model is snapshot → edit → diff → patch, like React's virtual DOM. The
phone holds a snapshot of the synced tables, the DJ edits it, and the phone
sends desktop only what changed, each change carrying the value it was based
on.

### Transport

Local wifi first: desktop serves a small endpoint on the local network and the
phone pairs once by scanning a QR code on desktop. Free, no account plan
required. The cloud (Supabase) carries the **same** patch format later, for
syncing away from the same network; that part is a paid plan and waits on
`CLOUD_LIVE`. **TODO(sync): pairing, discovery and endpoint security are not
specified yet.**

### Patch

```jsonc
{
  "patchId": "uuid v4, minted by the phone",   // desktop applies each id at most once
  "deviceId": "uuid v4 of the phone install",
  "baseSnapshotAt": 1793836800000,             // epoch ms of the snapshot the edits were made on
  "entries": [ /* see below, in edit order */ ]
}
```

Entry kinds:

| `op` | Fields | Meaning |
|---|---|---|
| `set` | `track`, `field`, `from`, `to`, `editedAt` | Scalar field changed from the snapshot value `from` to `to` |
| `tag.add` / `tag.remove` | `track`, `field`, `value`, `editedAt` | Add or remove one tag value (by field + value, not tag uuid, so a tag the phone created resolves on desktop) |
| `crate.create` | `crate` (new uuid), `name`, `color`, `parent`, `editedAt` | New crate |
| `crate.rename` | `crate`, `from`, `to`, `editedAt` | Rename |
| `crate.delete` | `crate`, `editedAt` | Delete the crate only, never its tracks |
| `crate.add` / `crate.remove` | `crate`, `track`, `position?`, `editedAt` | Crate membership |

`track` and `crate` are `client_uuid`s. `editedAt` is epoch ms on the phone's
clock and is for display and ordering only, never for deciding a conflict.

### Fields mobile may edit (v1)

| Field | Kind |
|---|---|
| `vibe`, `venue`, `custom` tags (and custom tag fields once shipped) | `tag.add` / `tag.remove` |
| `genre`, `grouping`, `label`, `comment` | `tag.add` / `tag.remove` (tags are the source of truth; the display string is derived) |
| `energy` | `set` |
| crates and crate membership | `crate.*` |

Read-only on mobile in v1: `title`, `artist`, `remixer`, `album`, `composer`
(artist order is not on the wire, and title/artist edits can rename files on
desktop), `bpm` and key columns (analysis output). Mobile cannot delete a
track. Desktop rejects any entry outside this list.

### Three-way check on desktop

For a `set` or `crate.rename`, compare the snapshot value (`from`), the
phone's value (`to`) and desktop's current value (`now`):

| Case | Result |
|---|---|
| `now == from` | Apply `to` (only the phone changed it) |
| `now == to` | Already applied, no-op |
| otherwise | **Conflict**: both changed it. Hold for review |

`tag.add` / `tag.remove` and `crate.add` / `crate.remove` are set operations
and never conflict: adding a tag the track already has, or removing one it
doesn't, is a no-op. Entries on a track or crate that no longer exists on
desktop are skipped and reported.

### Applying

1. Reject a `patchId` already applied (kept in a local applied-patches log).
2. Run the check per entry. Apply clean entries **through the repository
   layer**, never raw SQL, so derived display strings, `sync_updated_at`
   stamps and tag write-back behave as if the DJ made the edit on desktop.
3. Write changed tags back to the audio files on the existing write-back path.
4. Hold conflicts in a "Changes from your phone" review list; the DJ picks
   phone or desktop per field.
5. Reply to the phone with each entry's outcome: `applied`, `noop`,
   `conflict`, `skipped` or `rejected`. The phone clears its queue only for
   entries it got an outcome for.
6. Send the phone a fresh snapshot, or the rows changed since its last one.

Desktop keeps the last few applied patches with the prior values so a bad
batch can be undone. **TODO(sync): retention count for undo, and the review
list's storage, are not decided.**

### Mobile queue

Mobile holds patch entries (op, target uuids, field, snapshot value, new
value, `editedAt`) in `patch_entries` (mobile migration 002); consecutive
`set`s on the same field collapse to one entry keeping the **first** `from`.
Batches are frozen before sending (migration 003), so a retry resends the
same `patchId` with the same entries. Transport and endpoints:
`docs/local-sync-protocol.md`.

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
