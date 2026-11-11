import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applySyncSchema, migrateDelimiter } from '../../src/main/syncSchema'
import {
  applyLocalSyncSchema,
  backupBeforeMigration,
  getOrCreateDesktopId,
  insertCrateWithUuid,
  isUuidV4,
  prunePatchLog,
  LOCAL_SYNC_SCHEMA_VERSION,
  MIGRATION_BACKUP_TAG
} from '../../src/main/localSync/schema'

// The local-sync data layer (src/main/localSync/schema.ts) against an empty
// database, a populated fixture library run through the real sync migration,
// and (when LOCAL_SYNC_LIBRARY_COPY points at one) a copy of a real library.
// Never point that variable at a working library: the test migrates it.

const LOCAL_SYNC_TABLES = [
  'paired_phones',
  'sync_patch_log',
  'sync_conflicts',
  'sync_outbound_queue'
]

// The subset of db.ts's schema the sync migrations touch, with every column
// their triggers name.
function makeLibrary(path = ':memory:'): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filepath TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '', artist TEXT DEFAULT '', album TEXT, genre TEXT,
      key_val TEXT DEFAULT '', year TEXT, remixer TEXT, grouping TEXT, composer TEXT,
      comment TEXT, label TEXT, created_at INTEGER, bpm REAL, key_camelot TEXT,
      key_full TEXT, camelot TEXT, openkey TEXT, duration_sec REAL, duration_str TEXT,
      format TEXT, energy INTEGER, analyzed_at TEXT, client_uuid TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, field TEXT NOT NULL, value TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7f77dd',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), UNIQUE(field, value)
    );
    CREATE TABLE track_tags (
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (track_id, tag_id)
    );
    CREATE TABLE crates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7f77dd',
      parent_crate_id INTEGER REFERENCES crates(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_exported_at INTEGER, stats_private INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE crate_tracks (
      crate_id INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (crate_id, track_id)
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `)
  return db
}

function populate(db: Database.Database): void {
  const track = db.prepare("INSERT INTO tracks (filepath, title, genre) VALUES (?, ?, 'House')")
  for (let i = 1; i <= 20; i++) track.run(`/music/${i}.mp3`, `Track ${i}`)
  db.exec(`
    INSERT INTO tags (field, value) VALUES ('genre', 'House'), ('vibe', 'Warm');
    INSERT INTO track_tags (track_id, tag_id) SELECT id, 1 FROM tracks;
    INSERT INTO crates (name) VALUES ('Friday'), ('Warmup');
    INSERT INTO crates (name, parent_crate_id) VALUES ('Friday Late', 1);
    INSERT INTO crate_tracks (crate_id, track_id, position) SELECT 1, id, id * 1000 FROM tracks WHERE id <= 5;
    INSERT INTO app_settings (key, value) VALUES ('sidebar_genres_open', 'true');
  `)
}

// The real startup order in db.ts.
function migrateAll(db: Database.Database): void {
  applySyncSchema(db)
  migrateDelimiter(db)
  applyLocalSyncSchema(db)
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name)
}

function counts(db: Database.Database, tables: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tables) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  }
  return out
}

const userVersion = (db: Database.Database): number =>
  Number(db.pragma('user_version', { simple: true }))

let dir: string
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-sync-schema-'))
})
test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── Migration ─────────────────────────────────────────────────────────────

test('migration on an empty database creates the four tables and sets user_version 3', () => {
  const db = makeLibrary()
  migrateAll(db)
  expect(tableNames(db)).toEqual(expect.arrayContaining(LOCAL_SYNC_TABLES))
  expect(userVersion(db)).toBe(LOCAL_SYNC_SCHEMA_VERSION)
  expect(counts(db, LOCAL_SYNC_TABLES)).toEqual({
    paired_phones: 0,
    sync_patch_log: 0,
    sync_conflicts: 0,
    sync_outbound_queue: 0
  })
})

test('migration on a populated library adds tables and changes no existing row', () => {
  const db = makeLibrary()
  populate(db)
  applySyncSchema(db)
  migrateDelimiter(db)
  const existing = ['tracks', 'tags', 'track_tags', 'crates', 'crate_tracks', 'app_settings']
  const before = counts(db, existing)
  const crateRows = db.prepare('SELECT * FROM crates ORDER BY id').all()
  const trackRows = db.prepare('SELECT * FROM tracks ORDER BY id').all()

  applyLocalSyncSchema(db)

  expect(counts(db, existing)).toEqual(before)
  expect(db.prepare('SELECT * FROM crates ORDER BY id').all()).toEqual(crateRows)
  expect(db.prepare('SELECT * FROM tracks ORDER BY id').all()).toEqual(trackRows)
  expect(userVersion(db)).toBe(LOCAL_SYNC_SCHEMA_VERSION)
  expect((db.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check).toBe(
    'ok'
  )
})

test('running the migration twice is a no-op the second time', () => {
  const db = makeLibrary()
  populate(db)
  migrateAll(db)
  db.prepare(
    `INSERT INTO paired_phones (phone_id, display_name, token_hash, created_at)
     VALUES ('a1b2c3d4-0000-4000-8000-000000000001', 'iPhone', 'h', 1)`
  ).run()
  const schemaBefore = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()

  migrateAll(db)

  expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
    schemaBefore
  )
  expect(counts(db, ['paired_phones'])).toEqual({ paired_phones: 1 })
  expect(userVersion(db)).toBe(LOCAL_SYNC_SCHEMA_VERSION)
})

test('the migration never lowers a newer user_version', () => {
  const db = makeLibrary()
  migrateAll(db)
  db.pragma('user_version = 7')
  applyLocalSyncSchema(db)
  expect(userVersion(db)).toBe(7)
})

test('sync_patch_log rejects a second row for the same phone and patch', () => {
  const db = makeLibrary()
  migrateAll(db)
  const insert = db.prepare(
    `INSERT INTO sync_patch_log (phone_id, patch_id, request_hash, response_json, created_at)
     VALUES (?, ?, 'h', '{}', 1)`
  )
  insert.run('phone-a', 'patch-1')
  insert.run('phone-b', 'patch-1')
  expect(() => insert.run('phone-a', 'patch-1')).toThrow(/UNIQUE/)
})

test('sync_outbound_queue keeps one row per phone and entity, a delete replacing an upsert', () => {
  const db = makeLibrary()
  migrateAll(db)
  const queue = db.prepare(
    `INSERT INTO sync_outbound_queue (phone_id, entity_type, entity_id, op, queued_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (phone_id, entity_type, entity_id)
       DO UPDATE SET op = excluded.op, queued_at = excluded.queued_at`
  )
  queue.run('phone-a', 'crate', 'c1', 'upsert', 1)
  queue.run('phone-a', 'crate', 'c1', 'delete', 2)
  expect(db.prepare('SELECT op, queued_at FROM sync_outbound_queue').all()).toEqual([
    { op: 'delete', queued_at: 2 }
  ])
  expect(() => queue.run('phone-a', 'folder', 'f1', 'upsert', 3)).toThrow(/CHECK/)
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM sync_outbound_queue WHERE phone_id = 'x' ORDER BY queued_at"
    )
    .all() as { detail: string }[]
  expect(plan.map((p) => p.detail).join(' ')).toContain('idx_sync_outbound_queue_phone_queued')
})

test('sync_conflicts only takes known statuses and resolutions', () => {
  const db = makeLibrary()
  migrateAll(db)
  const insert = db.prepare(
    `INSERT INTO sync_conflicts (phone_id, entity_type, entity_id, field, status, resolution, created_at)
     VALUES ('p', 'track', 't', 'energy', ?, ?, 1)`
  )
  insert.run('pending', null)
  insert.run('resolved', 'desktop')
  expect(() => insert.run('maybe', null)).toThrow(/CHECK/)
  expect(() => insert.run('resolved', 'both')).toThrow(/CHECK/)
})

// ── Backup ────────────────────────────────────────────────────────────────

test('the pre-migration backup is a full copy and only the newest few are kept', () => {
  const dbPath = join(dir, 'library.db')
  const db = makeLibrary(dbPath)
  db.pragma('journal_mode = WAL')
  populate(db)
  // Backups made under another name are never pruned.
  writeFileSync(join(dir, 'library.db.backup-pre-sync-2026-10-09T15-34-39-287Z'), 'old')

  for (let day = 1; day <= 5; day++) {
    backupBeforeMigration(db, dbPath, { now: new Date(Date.UTC(2026, 10, day)), keep: 3 })
  }
  const backups = readdirSync(dir)
    .filter((n) => n.includes(MIGRATION_BACKUP_TAG))
    .sort()
  expect(backups).toEqual([
    'library.db.backup-pre-migration-2026-11-03T00-00-00-000Z',
    'library.db.backup-pre-migration-2026-11-04T00-00-00-000Z',
    'library.db.backup-pre-migration-2026-11-05T00-00-00-000Z'
  ])
  expect(existsSync(join(dir, 'library.db.backup-pre-sync-2026-10-09T15-34-39-287Z'))).toBe(true)

  const copy = new Database(join(dir, backups[2]), { readonly: true })
  expect(counts(copy, ['tracks', 'crates'])).toEqual({ tracks: 20, crates: 3 })
  copy.close()
  db.close()
})

// ── Desktop id ────────────────────────────────────────────────────────────

test('the desktop id is a v4 uuid that survives closing and reopening the library', () => {
  const dbPath = join(dir, 'library.db')
  const first = makeLibrary(dbPath)
  migrateAll(first)
  const id = getOrCreateDesktopId(first)
  expect(isUuidV4(id)).toBe(true)
  expect(getOrCreateDesktopId(first)).toBe(id)
  first.close()

  // A restart: same file, migrations run again.
  const again = new Database(dbPath)
  migrateAll(again)
  expect(getOrCreateDesktopId(again)).toBe(id)
  again.close()
})

test('an existing desktop id is never replaced, even an odd-looking one', () => {
  const db = makeLibrary()
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('local_sync_desktop_id', 'legacy-id')"
  ).run()
  expect(getOrCreateDesktopId(db)).toBe('legacy-id')
})

// ── insertCrateWithUuid ───────────────────────────────────────────────────

const PHONE_CRATE = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b'

test('insertCrateWithUuid keeps the given uuid', () => {
  const db = makeLibrary()
  migrateAll(db)
  const { id, created } = insertCrateWithUuid(db, {
    clientUuid: PHONE_CRATE,
    name: 'Phone crate',
    parentCrateId: null
  })
  expect(created).toBe(true)
  expect(
    db.prepare('SELECT name, client_uuid, sync_updated_at FROM crates WHERE id = ?').get(id)
  ).toEqual({
    name: 'Phone crate',
    client_uuid: PHONE_CRATE,
    sync_updated_at: expect.any(Number)
  })
})

test('insertCrateWithUuid is idempotent: a retry returns the existing crate', () => {
  const db = makeLibrary()
  migrateAll(db)
  const first = insertCrateWithUuid(db, {
    clientUuid: PHONE_CRATE,
    name: 'Phone crate',
    parentCrateId: null
  })
  const retry = insertCrateWithUuid(db, {
    clientUuid: PHONE_CRATE.toUpperCase(),
    name: 'Renamed?',
    parentCrateId: null
  })
  expect(retry).toEqual({ id: first.id, created: false })
  expect(db.prepare('SELECT COUNT(*) AS n, MAX(name) AS name FROM crates').get()).toEqual({
    n: 1,
    name: 'Phone crate'
  })
})

test('insertCrateWithUuid refuses a value that is not a v4 uuid', () => {
  const db = makeLibrary()
  migrateAll(db)
  expect(() =>
    insertCrateWithUuid(db, { clientUuid: 'not-a-uuid', name: 'x', parentCrateId: null })
  ).toThrow(/v4 uuid/)
  expect(counts(db, ['crates'])).toEqual({ crates: 0 })
})

test('crates inserted the old way still get a fresh uuid from the trigger', () => {
  const db = makeLibrary()
  migrateAll(db)
  db.prepare(
    "INSERT INTO crates (name, color, parent_crate_id) VALUES ('Desktop', '#7f77dd', NULL)"
  ).run()
  const row = db.prepare('SELECT client_uuid FROM crates').get() as { client_uuid: string }
  expect(isUuidV4(row.client_uuid)).toBe(true)
})

// ── Patch log pruning ─────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 11)

function logRow(
  db: Database.Database,
  phone: string,
  patch: string,
  ageMs: number,
  acked: boolean
): void {
  db.prepare(
    `INSERT INTO sync_patch_log (phone_id, patch_id, request_hash, response_json, created_at, acked_at)
     VALUES (?, ?, 'h', '{}', ?, ?)`
  ).run(phone, patch, NOW - ageMs, acked ? NOW - ageMs + 1000 : null)
}

const remaining = (db: Database.Database): string[] =>
  (
    db.prepare('SELECT patch_id FROM sync_patch_log ORDER BY patch_id').all() as {
      patch_id: string
    }[]
  ).map((r) => r.patch_id)

test('pruning drops acked rows past the short window and keeps unacked ones', () => {
  const db = makeLibrary()
  migrateAll(db)
  logRow(db, 'p', 'acked-old', 2 * DAY, true)
  logRow(db, 'p', 'acked-fresh', HOUR, true)
  logRow(db, 'p', 'unacked-old', 2 * DAY, false)

  expect(prunePatchLog(db, { now: NOW })).toEqual({ acked: 1, expired: 0, overCeiling: 0 })
  expect(remaining(db)).toEqual(['acked-fresh', 'unacked-old'])
})

test('pruning drops anything past the 30-day backstop, acked or not', () => {
  const db = makeLibrary()
  migrateAll(db)
  logRow(db, 'p', 'ancient-unacked', 31 * DAY, false)
  logRow(db, 'p', 'recent-unacked', 29 * DAY, false)

  expect(prunePatchLog(db, { now: NOW })).toEqual({ acked: 0, expired: 1, overCeiling: 0 })
  expect(remaining(db)).toEqual(['recent-unacked'])
})

test('pruning enforces the per-phone ceiling on the oldest rows only, phone by phone', () => {
  const db = makeLibrary()
  migrateAll(db)
  for (let i = 0; i < 6; i++) logRow(db, 'busy', `busy-${i}`, (10 - i) * HOUR, false)
  logRow(db, 'quiet', 'quiet-0', 20 * HOUR, false)

  expect(prunePatchLog(db, { now: NOW, maxPerPhone: 4 })).toEqual({
    acked: 0,
    expired: 0,
    overCeiling: 2
  })
  expect(remaining(db)).toEqual(['busy-2', 'busy-3', 'busy-4', 'busy-5', 'quiet-0'])
})

test('pruning with the defaults keeps far more than the protocol minimum of 100', () => {
  const db = makeLibrary()
  migrateAll(db)
  for (let i = 0; i < 150; i++)
    logRow(db, 'p', `patch-${String(i).padStart(3, '0')}`, i * 60_000, false)
  expect(prunePatchLog(db, { now: NOW })).toEqual({ acked: 0, expired: 0, overCeiling: 0 })
  expect(remaining(db)).toHaveLength(150)
})

// ── A copy of a real library (opt-in) ─────────────────────────────────────

const realCopy = process.env.LOCAL_SYNC_LIBRARY_COPY

test('migration on a copy of a real library', () => {
  test.skip(!realCopy, 'set LOCAL_SYNC_LIBRARY_COPY to a COPY of a library.db')
  const db = new Database(realCopy as string)
  const synced = ['tracks', 'tags', 'track_tags', 'crates', 'crate_tracks', 'app_settings']
  const before = counts(db, synced)

  migrateAll(db)
  migrateAll(db)

  expect(counts(db, synced)).toEqual(before)
  expect(tableNames(db)).toEqual(expect.arrayContaining(LOCAL_SYNC_TABLES))
  expect(userVersion(db)).toBe(LOCAL_SYNC_SCHEMA_VERSION)
  expect((db.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check).toBe(
    'ok'
  )
  db.close()
})
