// ── Anonymous stats: SQLite-backed StatsStore ─────────────────────────────
// Takes the open handle from db.ts (same pattern as health/), so the schema
// and migrations stay in db.ts and this file is only the queries.

import type Database from 'better-sqlite3'
import type { ConsentEvent, NewQueuedStat, QueuedStat, StatsStore } from './types'

const INSTALL_ID_KEY = 'stats_install_id'
const LAST_UPLOAD_KEY = 'stats_last_upload_at'

// A crate plus every crate nested under it (parent_crate_id chain).
const PRIVATE_CRATES_CTE = `
  WITH RECURSIVE pc(id) AS (
    SELECT id FROM crates WHERE stats_private = 1
    UNION
    SELECT c.id FROM crates c JOIN pc ON c.parent_crate_id = pc.id
  )
`

export function createSqliteStatsStore(db: Database.Database): StatsStore {
  const getSetting = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
  const putSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `)
  const delSetting = db.prepare(`DELETE FROM app_settings WHERE key = ?`)

  function readSetting(key: string): string | null {
    const row = getSetting.get(key) as { value: string | null } | undefined
    return row?.value ?? null
  }

  const latestConsent = db.prepare(
    `SELECT action, text_version, at FROM consent_events ORDER BY id DESC LIMIT 1`
  )
  const insertConsent = db.prepare(
    `INSERT INTO consent_events (action, text_version, at) VALUES (?, ?, ?)`
  )

  const trackPrivate = db.prepare(`SELECT stats_private FROM tracks WHERE id = ?`)
  const trackInPrivateCrate = db.prepare(`
    ${PRIVATE_CRATES_CTE}
    SELECT 1 FROM crate_tracks WHERE track_id = ? AND crate_id IN (SELECT id FROM pc) LIMIT 1
  `)
  // Walks up from the crate: private if it or any ancestor is flagged.
  const crateChainPrivate = db.prepare(`
    WITH RECURSIVE chain(id, parent_crate_id, stats_private) AS (
      SELECT id, parent_crate_id, stats_private FROM crates WHERE id = ?
      UNION
      SELECT c.id, c.parent_crate_id, c.stats_private
      FROM crates c JOIN chain ON c.id = chain.parent_crate_id
    )
    SELECT (SELECT COUNT(*) FROM chain) AS found,
           (SELECT COUNT(*) FROM chain WHERE stats_private = 1) AS priv
  `)
  const setTrackFlag = db.prepare(`UPDATE tracks SET stats_private = ? WHERE id = ?`)
  const setCrateFlag = db.prepare(`UPDATE crates SET stats_private = ? WHERE id = ?`)

  const insertStat = db.prepare(`
    INSERT INTO stats_queue
      (anon_install_id, event_type, payload, app_version, created_at, track_id, crate_id)
    VALUES
      (@anon_install_id, @event_type, @payload, @app_version, @created_at, @track_id, @crate_id)
  `)

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },

    latestConsentEvent(): ConsentEvent | null {
      const row = latestConsent.get() as
        { action: ConsentEvent['action']; text_version: number; at: number } | undefined
      return row ? { action: row.action, textVersion: row.text_version, at: row.at } : null
    },
    appendConsentEvent(e: ConsentEvent): void {
      insertConsent.run(e.action, e.textVersion, e.at)
    },

    getInstallId: () => readSetting(INSTALL_ID_KEY),
    setInstallId(id: string): void {
      putSetting.run(INSTALL_ID_KEY, id)
    },
    clearInstallId(): void {
      delSetting.run(INSTALL_ID_KEY)
    },

    getCanonicalTrackId(trackId: number): string | null {
      const row = db.prepare(`SELECT canonical_track_id FROM tracks WHERE id = ?`).get(trackId) as
        { canonical_track_id: string | null } | undefined
      return row?.canonical_track_id ?? null
    },

    isTrackPrivate(trackId: number): boolean {
      const row = trackPrivate.get(trackId) as { stats_private: number } | undefined
      return row === undefined || row.stats_private === 1
    },
    isCratePrivate(crateId: number): boolean {
      const row = crateChainPrivate.get(crateId) as { found: number; priv: number }
      return row.found === 0 || row.priv > 0
    },
    isTrackInPrivateCrate(trackId: number): boolean {
      return trackInPrivateCrate.get(trackId) !== undefined
    },
    setTracksPrivate(trackIds: number[], value: boolean): void {
      for (const id of trackIds) setTrackFlag.run(value ? 1 : 0, id)
    },
    setCratePrivate(crateId: number, value: boolean): void {
      setCrateFlag.run(value ? 1 : 0, crateId)
    },

    queueInsert(row: NewQueuedStat): void {
      insertStat.run(row)
    },
    queueCount(): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM stats_queue`).get() as { n: number }).n
    },
    queueTrimToCap(cap: number): void {
      db.prepare(
        `DELETE FROM stats_queue WHERE id IN (
           SELECT id FROM stats_queue ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
         )`
      ).run(cap)
    },
    queueDeleteOlderThan(isoCutoff: string): void {
      db.prepare(`DELETE FROM stats_queue WHERE created_at < ?`).run(isoCutoff)
    },
    queueDue(nowMs: number, limit: number): QueuedStat[] {
      return db
        .prepare(
          `SELECT id, anon_install_id, event_type, payload, app_version, created_at, attempts
           FROM stats_queue WHERE next_attempt_at <= ? ORDER BY created_at, id LIMIT ?`
        )
        .all(nowMs, limit) as QueuedStat[]
    },
    queueDelete(ids: number[]): void {
      const del = db.prepare(`DELETE FROM stats_queue WHERE id = ?`)
      for (const id of ids) del.run(id)
    },
    queueMarkFailed(ids: number[], nextAttemptMs: number): void {
      const upd = db.prepare(
        `UPDATE stats_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`
      )
      for (const id of ids) upd.run(nextAttemptMs, id)
    },
    queuePurgeAll(): void {
      db.prepare(`DELETE FROM stats_queue`).run()
    },
    queuePurgePrivate(): void {
      db.prepare(
        `${PRIVATE_CRATES_CTE}
         DELETE FROM stats_queue
         WHERE track_id IN (SELECT id FROM tracks WHERE stats_private = 1)
            OR crate_id IN (SELECT id FROM pc)
            OR track_id IN (SELECT track_id FROM crate_tracks WHERE crate_id IN (SELECT id FROM pc))`
      ).run()
    },

    getLastUploadAt(): number | null {
      const v = readSetting(LAST_UPLOAD_KEY)
      return v === null ? null : Number(v)
    },
    setLastUploadAt(ms: number): void {
      putSetting.run(LAST_UPLOAD_KEY, String(ms))
    }
  }
}
