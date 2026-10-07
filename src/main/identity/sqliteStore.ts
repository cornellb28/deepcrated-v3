// ── Track identity: SQLite-backed IdentityStore ───────────────────────────
// Takes the open handle from db.ts (same pattern as stats/ and health/), so
// schema and migrations stay in db.ts and this file is only the queries.

import type Database from 'better-sqlite3'
import { computeCanonicalTrackId, fingerprintHash, normalizeIsrc, normalizeMbid } from './canonical'
import type {
  FingerprintStatus,
  IdentityProgress,
  IdentityStore,
  LookupCacheEntry,
  LookupCandidate,
  TrackRef
} from './types'

interface IdentityRow {
  isrc: string | null
  musicbrainz_recording_id: string | null
  fingerprint_hash: string | null
}

// Recomputes and stores canonical_track_id for one track. Every write that
// can change an input goes through this, so the column cannot drift.
export function refreshCanonicalTrackId(db: Database.Database, trackId: number): string | null {
  const row = db
    .prepare(`SELECT isrc, musicbrainz_recording_id, fingerprint_hash FROM tracks WHERE id = ?`)
    .get(trackId) as IdentityRow | undefined
  if (!row) return null
  const canonical = computeCanonicalTrackId(row)
  db.prepare(`UPDATE tracks SET canonical_track_id = ? WHERE id = ?`).run(canonical, trackId)
  return canonical
}

export function createSqliteIdentityStore(db: Database.Database): IdentityStore {
  return {
    tracksNeedingTags(limit: number): TrackRef[] {
      return db
        .prepare(
          `SELECT id, filepath FROM tracks
           WHERE identity_tags_read = 0 AND missing = 0
           ORDER BY id LIMIT ?`
        )
        .all(limit) as TrackRef[]
    },

    // Whatever the file said is validated here, so a malformed tag can never
    // reach the id.
    setIdentityTags(trackId, isrc, recordingId): void {
      db.transaction(() => {
        db.prepare(
          `UPDATE tracks SET
             isrc = COALESCE(?, isrc),
             musicbrainz_recording_id = COALESCE(?, musicbrainz_recording_id),
             identity_tags_read = 1
           WHERE id = ?`
        ).run(normalizeIsrc(isrc), normalizeMbid(recordingId), trackId)
        refreshCanonicalTrackId(db, trackId)
      })()
    },

    // Only tracks whose tags have been read and that still have neither an
    // ISRC nor a recording id: a tag-borne id is always preferred, so there
    // is nothing to fingerprint for.
    tracksNeedingFingerprint(limit: number): TrackRef[] {
      return db
        .prepare(
          `SELECT id, filepath FROM tracks
           WHERE identity_tags_read = 1 AND missing = 0
             AND isrc IS NULL AND musicbrainz_recording_id IS NULL
             AND fingerprint_status IS NULL
           ORDER BY id LIMIT ?`
        )
        .all(limit) as TrackRef[]
    },

    setFingerprint(trackId, fingerprint, durationSec): void {
      const hash = fingerprintHash(fingerprint)
      if (!hash) {
        // Nothing usable came back; record that so the track leaves the list.
        db.prepare(`UPDATE tracks SET fingerprint_status = 'failed' WHERE id = ?`).run(trackId)
        return
      }
      db.transaction(() => {
        db.prepare(
          `UPDATE tracks SET
             acoustid_fingerprint = ?, fingerprint_duration = ?,
             fingerprint_hash = ?, fingerprint_status = 'done'
           WHERE id = ?`
        ).run(fingerprint, Math.round(durationSec), hash, trackId)
        refreshCanonicalTrackId(db, trackId)
      })()
    },

    setFingerprintStatus(trackId, status: FingerprintStatus): void {
      db.prepare(`UPDATE tracks SET fingerprint_status = ? WHERE id = ?`).run(status, trackId)
    },

    tracksNeedingLookup(limit, negativeCutoffMs): LookupCandidate[] {
      return db
        .prepare(
          `SELECT t.id, t.acoustid_fingerprint AS fingerprint,
                  t.fingerprint_duration, t.fingerprint_hash
           FROM tracks t
           LEFT JOIN identity_lookup_cache c ON c.fingerprint_hash = t.fingerprint_hash
           WHERE t.fingerprint_hash IS NOT NULL
             AND t.isrc IS NULL AND t.musicbrainz_recording_id IS NULL
             AND t.missing = 0
             AND (c.fingerprint_hash IS NULL
                  OR c.status = 'match'
                  OR c.looked_up_at < ?)
           ORDER BY t.id LIMIT ?`
        )
        .all(negativeCutoffMs, limit) as LookupCandidate[]
    },

    setRecordingId(trackId, recordingId): void {
      const mbid = normalizeMbid(recordingId)
      if (!mbid) return
      db.transaction(() => {
        db.prepare(
          `UPDATE tracks SET musicbrainz_recording_id = ?
           WHERE id = ? AND musicbrainz_recording_id IS NULL`
        ).run(mbid, trackId)
        refreshCanonicalTrackId(db, trackId)
      })()
    },

    getCache(hash): LookupCacheEntry | null {
      const row = db
        .prepare(
          `SELECT fingerprint_hash, recording_id, status, looked_up_at
           FROM identity_lookup_cache WHERE fingerprint_hash = ?`
        )
        .get(hash) as LookupCacheEntry | undefined
      return row ?? null
    },

    putCache(entry): void {
      db.prepare(
        `INSERT INTO identity_lookup_cache (fingerprint_hash, recording_id, status, looked_up_at)
         VALUES (@fingerprint_hash, @recording_id, @status, @looked_up_at)
         ON CONFLICT(fingerprint_hash) DO UPDATE SET
           recording_id = excluded.recording_id,
           status = excluded.status,
           looked_up_at = excluded.looked_up_at`
      ).run(entry)
    },

    progress(): IdentityProgress {
      const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
      return {
        total: one(`SELECT COUNT(*) AS n FROM tracks WHERE missing = 0`),
        tagsPending: one(
          `SELECT COUNT(*) AS n FROM tracks WHERE identity_tags_read = 0 AND missing = 0`
        ),
        fingerprintPending: one(
          `SELECT COUNT(*) AS n FROM tracks
           WHERE identity_tags_read = 1 AND missing = 0 AND isrc IS NULL
             AND musicbrainz_recording_id IS NULL AND fingerprint_status IS NULL`
        ),
        lookupPending: one(
          `SELECT COUNT(*) AS n FROM tracks
           WHERE fingerprint_hash IS NOT NULL AND isrc IS NULL
             AND musicbrainz_recording_id IS NULL AND missing = 0`
        )
      }
    },

    getCanonicalTrackId(trackId): string | null {
      const row = db.prepare(`SELECT canonical_track_id FROM tracks WHERE id = ?`).get(trackId) as
        { canonical_track_id: string | null } | undefined
      return row?.canonical_track_id ?? null
    }
  }
}
