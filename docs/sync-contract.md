# Sync contract (desktop ⇄ mobile ⇄ Supabase)

Spec for the synced tables and for how mobile edits reach desktop. Nothing in
this document is implemented as sync code yet; desktop only carries the identity and change-tracking the sync layer
will read (`src/main/syncSchema.ts`). The mobile mirror is
`deepcrated-mobile/src/db/migrations/001_initial.ts`.

Decisions of 2026-10-09 (track identities, keys, retention, tiers, ownership)
are folded in below. **TODO(sync): none of them is implemented yet** — no
desktop schema, Supabase migration or mobile mirror exists for
`track_identities`.

## Synced tables

`tracks`, `tags`, `track_tags`, `crates`, `crate_tracks`, `track_identities`,
`track_availability`, `track_audio`.

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

### track_audio

One row per track whose audio is stored in the cloud. A live row (`deleted_at`
null) is what makes a track playable on mobile; no row, or a deleted one,
means it is not.

| Column | Type | Notes |
|---|---|---|
| track_uuid | uuid not null | → `tracks.client_uuid`; no database foreign key (may arrive before its track) |
| sha256 | text not null | hash of the uploaded audio; the object key is `u/{user_id}/{sha256}` |
| size_bytes | bigint not null | |
| content_type | text not null | |

Plus `client_uuid`, `updated_at`, `deleted_at` like every table. At most one
live row per `track_uuid`.

- **Written by desktop only, and only after the storage "complete" call
  succeeds** — never for an upload that is still in flight or failed, so a
  live row always points at an object that exists.
- **Read-only everywhere else.** Mobile and the server never write it.
- **Delete from cloud** (audio only; the track stays in the library):
  desktop sets `deleted_at` on the row. The track is then no longer playable
  on mobile.
- **Track deleted:** its `track_audio` row is tombstoned with the track, and
  the stored file stays until the 14-day purge, so "Download a copy" keeps
  working (see Delete semantics).
- Plain last-write-wins on `updated_at`, like the other tables. Its delete
  records follow the same 90-day retention (see Retention).

**Removing the stored file.** Two of a user's tracks with identical audio
share one file (same `sha256`, same key). The file is removed only when no
live `track_audio` row (`deleted_at` null) of the same user references the
same `sha256`. That check is server-side, in the storage delete function.
Desktop writes `deleted_at` first, then calls delete; delete is a no-op
while another live row still references the hash.

**Note for `deepcrate-web`:** the download-url function must still work for
a hidden object during the 14-day window, by using the version id recorded
at complete.

Artwork is not stored or synced here; that is a separate, open decision.

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

Two exceptions:

- **A track deleted on desktop**: the delete always wins, however new the
  live version (see Delete semantics).
- **`track_identities`** uses its own merge rule (see that table).

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
