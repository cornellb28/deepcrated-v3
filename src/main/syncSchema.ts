import type Database from 'better-sqlite3'

// ── Sync-ready identity and change tracking ───────────────────────────────
// Additive only: no column is dropped, renamed or retyped. Takes a bare
// connection (no Electron import) so it can be exercised against a copy of a
// real database — same split as tagFields.ts / rescanSweep.ts.
//
// What it adds, per synced table (tracks, tags, track_tags, crates,
// crate_tracks):
//   client_uuid       tags, crates, track_tags, crate_tracks (tracks has had
//                     it since the identity migration). Nullable, with a
//                     partial unique index — the same pattern as tracks.
//   sync_updated_at   epoch MILLISECONDS, on all five. Separate from the legacy
//                     updated_at columns (TEXT on tracks, epoch seconds on
//                     crates) because SQLite cannot retype a column without
//                     rebuilding the table, and a mixed-unit column is worse
//                     than a second one.
//   sync_tombstones   deletes stay HARD (the PK/UNIQUE constraints on tracks,
//                     tags and both join tables make soft delete unsafe:
//                     INSERT OR IGNORE would silently no-op against a
//                     soft-deleted row). A BEFORE DELETE trigger records the
//                     uuid instead, and the sync layer maps a tombstone to the
//                     wire's deleted_at.
//
// Stamping is done by triggers rather than at each write site: there are ~30
// of them plus raw SQL in the identity/stats/artist stores, and a trigger
// cannot be forgotten by the next one. Each UPDATE trigger compares the synced
// columns, so a rescan that rewrites identical values, or a write to a
// device-local column (filepath, missing, artwork, fingerprint), stamps
// nothing and causes no sync churn. Because they are row triggers they also
// cover the cascade-rename paths (renameTagAndCascade, deleteTagAndCascade)
// and bulk operations, stamping every affected track.

// Epoch ms with sub-second precision (strftime('%s') only has seconds).
const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`

// A v4 uuid, generated in SQL so it works in a migration backfill and in a
// trigger alike. randomblob is per-row, so every row gets its own.
const UUID_V4 = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
  substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`

// The tracks columns mobile mirrors. A change to any of these re-stamps.
const SYNCED_TRACK_COLUMNS = [
  'title',
  'artist',
  'album',
  'genre',
  'key_val',
  'year',
  'remixer',
  'grouping',
  'composer',
  'comment',
  'label',
  'bpm',
  'key_camelot',
  'key_full',
  'camelot',
  'openkey',
  'duration_sec',
  'duration_str',
  'format',
  'energy',
  'created_at',
  'added_at',
  'analyzed_at'
] as const

// Multi-value fields whose display string moved from " / " to " | ".
// album is deliberately absent — see FIELD_DELIMITERS in tagFields.ts.
const DELIMITER_MIGRATED_FIELDS = [
  'artist',
  'genre',
  'grouping',
  'label',
  'remixer',
  'composer',
  'comment'
] as const

export const SYNC_SCHEMA_VERSION = 1
export const DELIMITER_MIGRATION_VERSION = 2

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  )
}

function addColumn(db: Database.Database, table: string, name: string, type: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}

const changed = (cols: readonly string[]): string =>
  cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')

export function applySyncSchema(db: Database.Database): void {
  const run = db.transaction(() => {
    // ── Columns ──────────────────────────────────────────────────────────
    for (const table of ['tags', 'crates', 'track_tags', 'crate_tracks']) {
      addColumn(db, table, 'client_uuid', 'TEXT')
    }
    for (const table of ['tracks', 'tags', 'track_tags', 'crates', 'crate_tracks']) {
      addColumn(db, table, 'sync_updated_at', 'INTEGER')
    }

    // ── Backfill (only rows that have not got a value yet) ──────────────
    for (const table of ['tags', 'crates', 'track_tags', 'crate_tracks']) {
      db.exec(`UPDATE ${table} SET client_uuid = ${UUID_V4} WHERE client_uuid IS NULL`)
    }
    // Legacy units -> epoch ms. tracks.updated_at is UTC 'YYYY-MM-DD HH:MM:SS'.
    db.exec(`
      UPDATE tracks SET sync_updated_at =
        COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, ${NOW_MS})
        WHERE sync_updated_at IS NULL;
      UPDATE tags SET sync_updated_at = created_at * 1000 WHERE sync_updated_at IS NULL;
      UPDATE crates SET sync_updated_at = updated_at * 1000 WHERE sync_updated_at IS NULL;
      UPDATE track_tags SET sync_updated_at = applied_at * 1000 WHERE sync_updated_at IS NULL;
      UPDATE crate_tracks SET sync_updated_at = added_at * 1000 WHERE sync_updated_at IS NULL;
    `)

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_client_uuid
        ON tags(client_uuid) WHERE client_uuid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crates_client_uuid
        ON crates(client_uuid) WHERE client_uuid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_track_tags_client_uuid
        ON track_tags(client_uuid) WHERE client_uuid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crate_tracks_client_uuid
        ON crate_tracks(client_uuid) WHERE client_uuid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tracks_sync_updated ON tracks(sync_updated_at);
      CREATE INDEX IF NOT EXISTS idx_tags_sync_updated ON tags(sync_updated_at);
      CREATE INDEX IF NOT EXISTS idx_track_tags_sync_updated ON track_tags(sync_updated_at);
      CREATE INDEX IF NOT EXISTS idx_crates_sync_updated ON crates(sync_updated_at);
      CREATE INDEX IF NOT EXISTS idx_crate_tracks_sync_updated ON crate_tracks(sync_updated_at);

      -- One row per deleted synced row. row_uuid is that row's client_uuid
      -- (join rows have their own). Local-only; the sync layer pushes then
      -- prunes. A row re-created later gets a NEW uuid, so a tombstone never
      -- has to be cleared.
      CREATE TABLE IF NOT EXISTS sync_tombstones (
        table_name TEXT    NOT NULL,
        row_uuid   TEXT    NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (table_name, row_uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_tombstones_deleted_at ON sync_tombstones(deleted_at);
    `)

    // ── Triggers (dropped and recreated so a changed definition ships) ──
    const triggers: { name: string; sql: string }[] = []
    const add = (name: string, sql: string): void => {
      triggers.push({ name, sql })
    }

    // tracks: client_uuid is minted by insertTrack; the fill here is a net.
    add(
      'trg_sync_tracks_ai',
      `AFTER INSERT ON tracks
       BEGIN
         UPDATE tracks SET
           sync_updated_at = COALESCE(sync_updated_at, ${NOW_MS}),
           client_uuid = COALESCE(client_uuid, ${UUID_V4})
         WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_tracks_au',
      `AFTER UPDATE ON tracks
       WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (${changed(SYNCED_TRACK_COLUMNS)})
       BEGIN
         UPDATE tracks SET sync_updated_at = ${NOW_MS} WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_tracks_bd',
      `BEFORE DELETE ON tracks WHEN OLD.client_uuid IS NOT NULL
       BEGIN
         INSERT OR REPLACE INTO sync_tombstones (table_name, row_uuid, deleted_at)
         VALUES ('tracks', OLD.client_uuid, ${NOW_MS});
       END`
    )

    // tags
    add(
      'trg_sync_tags_ai',
      `AFTER INSERT ON tags
       BEGIN
         UPDATE tags SET
           sync_updated_at = COALESCE(sync_updated_at, ${NOW_MS}),
           client_uuid = COALESCE(client_uuid, ${UUID_V4})
         WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_tags_au',
      `AFTER UPDATE ON tags
       WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (${changed(['field', 'value', 'color'])})
       BEGIN
         UPDATE tags SET sync_updated_at = ${NOW_MS} WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_tags_bd',
      `BEFORE DELETE ON tags WHEN OLD.client_uuid IS NOT NULL
       BEGIN
         INSERT OR REPLACE INTO sync_tombstones (table_name, row_uuid, deleted_at)
         VALUES ('tags', OLD.client_uuid, ${NOW_MS});
       END`
    )

    // crates (last_exported_at and stats_private are device-local: not watched)
    add(
      'trg_sync_crates_ai',
      `AFTER INSERT ON crates
       BEGIN
         UPDATE crates SET
           sync_updated_at = COALESCE(sync_updated_at, ${NOW_MS}),
           client_uuid = COALESCE(client_uuid, ${UUID_V4})
         WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_crates_au',
      `AFTER UPDATE ON crates
       WHEN NEW.sync_updated_at IS OLD.sync_updated_at
        AND (${changed(['name', 'color', 'parent_crate_id'])})
       BEGIN
         UPDATE crates SET sync_updated_at = ${NOW_MS} WHERE id = NEW.id;
       END`
    )
    add(
      'trg_sync_crates_bd',
      `BEFORE DELETE ON crates WHEN OLD.client_uuid IS NOT NULL
       BEGIN
         INSERT OR REPLACE INTO sync_tombstones (table_name, row_uuid, deleted_at)
         VALUES ('crates', OLD.client_uuid, ${NOW_MS});
       END`
    )

    // track_tags. A merge repoints tag_id with UPDATE: the row keeps its uuid
    // and is re-stamped, so the sync layer sees it move rather than vanish.
    add(
      'trg_sync_track_tags_ai',
      `AFTER INSERT ON track_tags
       BEGIN
         UPDATE track_tags SET
           sync_updated_at = COALESCE(sync_updated_at, ${NOW_MS}),
           client_uuid = COALESCE(client_uuid, ${UUID_V4})
         WHERE rowid = NEW.rowid;
       END`
    )
    add(
      'trg_sync_track_tags_au',
      `AFTER UPDATE ON track_tags
       WHEN NEW.sync_updated_at IS OLD.sync_updated_at AND (${changed(['track_id', 'tag_id'])})
       BEGIN
         UPDATE track_tags SET sync_updated_at = ${NOW_MS} WHERE rowid = NEW.rowid;
       END`
    )
    add(
      'trg_sync_track_tags_bd',
      `BEFORE DELETE ON track_tags WHEN OLD.client_uuid IS NOT NULL
       BEGIN
         INSERT OR REPLACE INTO sync_tombstones (table_name, row_uuid, deleted_at)
         VALUES ('track_tags', OLD.client_uuid, ${NOW_MS});
       END`
    )

    // crate_tracks. reorderCrateTracks rewrites every position; the compare
    // means only rows whose position really changed are stamped.
    add(
      'trg_sync_crate_tracks_ai',
      `AFTER INSERT ON crate_tracks
       BEGIN
         UPDATE crate_tracks SET
           sync_updated_at = COALESCE(sync_updated_at, ${NOW_MS}),
           client_uuid = COALESCE(client_uuid, ${UUID_V4})
         WHERE rowid = NEW.rowid;
       END`
    )
    add(
      'trg_sync_crate_tracks_au',
      `AFTER UPDATE ON crate_tracks
       WHEN NEW.sync_updated_at IS OLD.sync_updated_at
        AND (${changed(['crate_id', 'track_id', 'position'])})
       BEGIN
         UPDATE crate_tracks SET sync_updated_at = ${NOW_MS} WHERE rowid = NEW.rowid;
       END`
    )
    add(
      'trg_sync_crate_tracks_bd',
      `BEFORE DELETE ON crate_tracks WHEN OLD.client_uuid IS NOT NULL
       BEGIN
         INSERT OR REPLACE INTO sync_tombstones (table_name, row_uuid, deleted_at)
         VALUES ('crate_tracks', OLD.client_uuid, ${NOW_MS});
       END`
    )

    for (const { name, sql } of triggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      db.exec(`CREATE TRIGGER ${name} ${sql}`)
    }
  })
  run()

  if (Number(db.pragma('user_version', { simple: true })) < SYNC_SCHEMA_VERSION) {
    db.pragma(`user_version = ${SYNC_SCHEMA_VERSION}`)
  }
}

// One-time data pass: " / " -> " | " in the display columns of every
// multi-value field except album. The previous values are copied into
// _delimiter_backup_v2 first so it can be reversed (see rollback in
// docs/sync-contract.md). DB only — files on disk are NOT rewritten here;
// that is a separate, opt-in step.
//
// TODO(delimiter): write the new delimiter back to the audio files for the
// tracks changed here (the existing artist/tag write path). Until then a file
// still holds " / " and the DB " | "; both are accepted when splitting, so
// nothing breaks, but the file and the column differ.
export function migrateDelimiter(db: Database.Database): { rowsChanged: number } {
  if (Number(db.pragma('user_version', { simple: true })) >= DELIMITER_MIGRATION_VERSION) {
    return { rowsChanged: 0 }
  }
  let rowsChanged = 0
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _delimiter_backup_v2 (
        track_id INTEGER NOT NULL,
        field    TEXT    NOT NULL,
        value    TEXT,
        PRIMARY KEY (track_id, field)
      )
    `)
    for (const field of DELIMITER_MIGRATED_FIELDS) {
      db.prepare(
        `INSERT OR IGNORE INTO _delimiter_backup_v2 (track_id, field, value)
         SELECT id, ?, ${field} FROM tracks WHERE ${field} LIKE '% / %'`
      ).run(field)
      rowsChanged += db
        .prepare(
          `UPDATE tracks SET ${field} = replace(${field}, ' / ', ' | ') WHERE ${field} LIKE '% / %'`
        )
        .run().changes
    }
  })
  run()
  db.pragma(`user_version = ${DELIMITER_MIGRATION_VERSION}`)
  return { rowsChanged }
}
