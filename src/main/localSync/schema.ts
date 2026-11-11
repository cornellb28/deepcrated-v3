import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { readdirSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'

// ── Local (LAN) sync: data layer ──────────────────────────────────────────
// Additive only. Takes a bare connection (no Electron import) so it can be
// exercised against an empty database and a copy of a real library, the same
// split as syncSchema.ts. db.ts calls these and exposes thin wrappers.
//
// Protocol: docs/local-sync-protocol.md. Data rules: docs/sync-contract.md.
//
// Every timestamp in these tables is epoch MILLISECONDS (the wire unit), not
// the epoch seconds of the legacy app_settings / crates columns.

export const LOCAL_SYNC_SCHEMA_VERSION = 3

export const DESKTOP_ID_SETTING = 'local_sync_desktop_id'

// Lower-case v4 uuid, as the protocol requires for every id.
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value)
}

// ── Migration (user_version 3) ────────────────────────────────────────────
// CREATE ... IF NOT EXISTS throughout, so running it twice is a no-op; one
// transaction, so a failure part way leaves the database as it was.
export function applyLocalSyncSchema(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(`
      -- One row per phone ever paired. phone_id is the phone's install uuid
      -- (X-DeepCrated-Device). Pairing the same phone again replaces its
      -- token and clears revoked_at. Only a SHA-256 of the token is kept.
      CREATE TABLE IF NOT EXISTS paired_phones (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_id     TEXT    NOT NULL UNIQUE,
        display_name TEXT    NOT NULL,
        token_hash   TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at   INTEGER
      );

      -- Applied patches, so a repeated patchId replays the identical
      -- response instead of applying twice. request_hash is a SHA-256 of the
      -- request's entries: a reused patchId with different entries is a 409
      -- (patch_id_reused), which needs something to compare against.
      -- acked_at: set once the phone has shown it received the response (its
      -- next, different patchId); see prunePatchLog.
      CREATE TABLE IF NOT EXISTS sync_patch_log (
        phone_id      TEXT    NOT NULL,
        patch_id      TEXT    NOT NULL,
        request_hash  TEXT    NOT NULL,
        response_json TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        acked_at      INTEGER,
        UNIQUE (phone_id, patch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_patch_log_phone_created
        ON sync_patch_log(phone_id, created_at);

      -- A phone edit that collided with a desktop edit to the same field.
      -- The *_value columns are JSON so null, '' and 0 stay distinct.
      -- Both timestamps are kept so a per-field last-write-wins rule can be
      -- built on top later; hold-for-review only needs status/resolution.
      -- entity_id is the track's or crate's client_uuid. resolution is
      -- 'phone' or 'desktop' (whose value was kept) once resolved.
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_id          TEXT    NOT NULL,
        entity_type       TEXT    NOT NULL CHECK (entity_type IN ('track', 'crate')),
        entity_id         TEXT    NOT NULL,
        field             TEXT    NOT NULL,
        phone_value       TEXT,
        desktop_value     TEXT,
        base_value        TEXT,
        phone_timestamp   INTEGER,
        desktop_timestamp INTEGER,
        status            TEXT    NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'resolved')),
        resolution        TEXT    CHECK (resolution IS NULL OR resolution IN ('phone', 'desktop')),
        created_at        INTEGER NOT NULL,
        resolved_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status
        ON sync_conflicts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity
        ON sync_conflicts(entity_type, entity_id);

      -- Tracks and crates a phone must be sent in full (row + complete link
      -- set) on its next pull, whatever since says: entities whose patch
      -- entry came back conflict/skipped/rejected, and deletes. One row per
      -- (phone, entity); queueing again replaces op and queued_at, so a
      -- 'delete' supersedes an earlier 'upsert'. A 'delete' row is a
      -- tombstone the phone must see even if sync_tombstones is pruned.
      CREATE TABLE IF NOT EXISTS sync_outbound_queue (
        phone_id    TEXT    NOT NULL,
        entity_type TEXT    NOT NULL CHECK (entity_type IN ('track', 'crate')),
        entity_id   TEXT    NOT NULL,
        op          TEXT    NOT NULL CHECK (op IN ('upsert', 'delete')),
        queued_at   INTEGER NOT NULL,
        PRIMARY KEY (phone_id, entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_outbound_queue_phone_queued
        ON sync_outbound_queue(phone_id, queued_at);
    `)
    if (Number(db.pragma('user_version', { simple: true })) < LOCAL_SYNC_SCHEMA_VERSION) {
      db.pragma(`user_version = ${LOCAL_SYNC_SCHEMA_VERSION}`)
    }
  })
  run()
}

// ── Pre-migration backup ──────────────────────────────────────────────────
// A consistent copy next to the library (VACUUM INTO reads through the WAL,
// so no checkpoint dance). Only files with this prefix are ever pruned;
// older backups made under other names are left alone.
export const MIGRATION_BACKUP_TAG = 'backup-pre-migration-'
export const MIGRATION_BACKUPS_KEPT = 3

export function backupBeforeMigration(
  db: Database.Database,
  dbPath: string,
  options: { now?: Date; keep?: number } = {}
): string {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const dest = `${dbPath}.${MIGRATION_BACKUP_TAG}${stamp}`
  db.prepare('VACUUM INTO ?').run(dest)
  pruneMigrationBackups(dbPath, options.keep ?? MIGRATION_BACKUPS_KEPT)
  return dest
}

export function pruneMigrationBackups(dbPath: string, keep: number): string[] {
  const prefix = `${basename(dbPath)}.${MIGRATION_BACKUP_TAG}`
  const dir = dirname(dbPath)
  // ISO stamps sort chronologically as strings.
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
  const removed = backups.slice(0, Math.max(0, backups.length - keep))
  for (const name of removed) unlinkSync(join(dir, name))
  return removed
}

// ── Desktop id ────────────────────────────────────────────────────────────
// Minted once per install and never regenerated: phones pin it. If a value
// is already stored it is returned as it is, even if it looks wrong, because
// replacing it would silently unpair every phone.
export function getOrCreateDesktopId(db: Database.Database): string {
  db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s','now'))`
  ).run(DESKTOP_ID_SETTING, randomUUID())
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(DESKTOP_ID_SETTING) as {
    value: string
  }
  return row.value
}

// ── Patch log pruning ─────────────────────────────────────────────────────
// Three rules, any of which removes a row:
//   1. acked and older than ackedRetentionMs (the phone has its response, so
//      the row only guards against a very late duplicate);
//   2. older than maxAgeMs, acked or not (backstop for a phone that went
//      away mid-sync and never came back);
//   3. beyond the newest maxPerPhone rows for that phone (hard ceiling).
// The defaults keep well over the protocol's minimum of 100 per device.
export interface PatchLogPruneOptions {
  now?: number
  ackedRetentionMs?: number
  maxAgeMs?: number
  maxPerPhone?: number
}

export const PATCH_LOG_DEFAULTS = {
  ackedRetentionMs: 24 * 60 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxPerPhone: 1000
} as const

export function prunePatchLog(
  db: Database.Database,
  options: PatchLogPruneOptions = {}
): { acked: number; expired: number; overCeiling: number } {
  const now = options.now ?? Date.now()
  const ackedRetentionMs = options.ackedRetentionMs ?? PATCH_LOG_DEFAULTS.ackedRetentionMs
  const maxAgeMs = options.maxAgeMs ?? PATCH_LOG_DEFAULTS.maxAgeMs
  const maxPerPhone = options.maxPerPhone ?? PATCH_LOG_DEFAULTS.maxPerPhone

  const run = db.transaction(() => {
    const acked = db
      .prepare('DELETE FROM sync_patch_log WHERE acked_at IS NOT NULL AND created_at < ?')
      .run(now - ackedRetentionMs).changes
    const expired = db
      .prepare('DELETE FROM sync_patch_log WHERE created_at < ?')
      .run(now - maxAgeMs).changes
    const overCeiling = db
      .prepare(
        `DELETE FROM sync_patch_log WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY phone_id ORDER BY created_at DESC, rowid DESC
             ) AS rn
             FROM sync_patch_log
           ) WHERE rn > ?
         )`
      )
      .run(maxPerPhone).changes
    return { acked, expired, overCeiling }
  })
  return run()
}

// ── Crates with a phone-minted uuid ───────────────────────────────────────
// crate.create carries the phone's uuid, and later crate.add / crate.rename
// entries name it, so the crate must keep it. Idempotent: if a crate with
// that uuid exists it is returned and nothing is inserted, so a retried
// patch cannot create a duplicate.
//
// TODO(sync): a crate the DJ deleted on desktop has a tombstone for its
// uuid; a late crate.create for it would recreate it under the same uuid.
// The patch log's replay makes that unlikely; decide in the applier.
export function insertCrateWithUuid(
  db: Database.Database,
  crate: { clientUuid: string; name: string; parentCrateId: number | null; color?: string }
): { id: number; created: boolean } {
  const clientUuid = crate.clientUuid.toLowerCase()
  if (!isUuidV4(clientUuid)) throw new Error('insertCrateWithUuid: client_uuid is not a v4 uuid')
  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM crates WHERE client_uuid = ?').get(clientUuid) as
      { id: number } | undefined
    if (existing) return { id: existing.id, created: false }
    const result = db
      .prepare(
        `INSERT INTO crates (name, color, parent_crate_id, client_uuid)
         VALUES (?, ?, ?, ?)`
      )
      .run(crate.name, crate.color ?? '#7f77dd', crate.parentCrateId, clientUuid)
    return { id: Number(result.lastInsertRowid), created: true }
  })
  return run()
}
