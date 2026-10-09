// ── Artist-name cleanup: SQLite-backed ArtistStore ────────────────────────
// Takes the open handle from db.ts, like stats/ and identity/. The tag write
// itself (setTagsForField) is injected: it lives in db.ts, which imports this.

import type Database from 'better-sqlite3'
import { splitValue } from '../tagFields'
import type { ArtistTagEntry, LibrarySpelling } from './clean'
import type {
  ArtistStore,
  ArtistTrack,
  JournalEntry,
  NewSuggestion,
  ReclaimTrack,
  SuggestionGroup,
  SuggestionRow,
  SuggestionStatus
} from './types'

export interface SqliteArtistDeps {
  setTagsForField: (trackId: number, field: string, values: string[]) => string | null
  getSetting: (key: string) => string | null
}

export function createSqliteArtistStore(
  db: Database.Database,
  deps: SqliteArtistDeps
): ArtistStore {
  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },

    getTrack(id: number): ArtistTrack | null {
      return (
        (db.prepare(`SELECT id, filepath, artist, artist_raw FROM tracks WHERE id = ?`).get(id) as
          ArtistTrack | undefined) ?? null
      )
    },

    setArtistRawIfNull(id: number, raw: string): void {
      db.prepare(`UPDATE tracks SET artist_raw = ? WHERE id = ? AND artist_raw IS NULL`).run(
        raw,
        id
      )
    },

    getArtistTagValues(id: number): string[] {
      return (
        db
          .prepare(
            `SELECT g.value FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
              WHERE tt.track_id = ? AND g.field = 'artist' ORDER BY tt.rowid`
          )
          .all(id) as { value: string }[]
      ).map((r) => r.value)
    },

    setArtistTags(id: number, values: string[]): string | null {
      return deps.setTagsForField(id, 'artist', values)
    },

    setTrackArtistColumn(id: number, value: string | null): void {
      db.prepare(`UPDATE tracks SET artist = ?, updated_at = datetime('now') WHERE id = ?`).run(
        value,
        id
      )
    },

    artistTagPool(): ArtistTagEntry[] {
      return db
        .prepare(
          `SELECT g.value AS value, COUNT(tt.track_id) AS trackCount
             FROM tags g LEFT JOIN track_tags tt ON tt.tag_id = g.id
            WHERE g.field = 'artist'
              -- A tag that exists only because an import attached a raw name
              -- still waiting for a decision is not yet a name anyone chose,
              -- so it must not become what later imports are matched against.
              AND g.value NOT IN (SELECT raw FROM artist_suggestions WHERE status = 'pending')
            GROUP BY g.id`
        )
        .all() as ArtistTagEntry[]
    },

    // Spellings as they stand in tracks.artist, split on the library's " | " (legacy " / " still accepted).
    librarySpellings(): LibrarySpelling[] {
      const rows = db
        .prepare(
          `SELECT artist, COUNT(*) AS n FROM tracks
            WHERE missing = 0 AND TRIM(COALESCE(artist, '')) <> ''
            GROUP BY artist`
        )
        .all() as { artist: string; n: number }[]
      const counts = new Map<string, number>()
      for (const row of rows) {
        for (const part of splitValue('artist', row.artist)) {
          counts.set(part, (counts.get(part) ?? 0) + row.n)
        }
      }
      return [...counts].map(([raw, count]) => ({ raw, count }))
    },

    liveTracksWithArtist(): ReclaimTrack[] {
      const tracks = db
        .prepare(
          `SELECT id, filepath, artist FROM tracks
            WHERE missing = 0 AND TRIM(COALESCE(artist, '')) <> '' ORDER BY id`
        )
        .all() as { id: number; filepath: string; artist: string | null }[]
      const tagRows = db
        .prepare(
          `SELECT tt.track_id AS id, g.value AS value
             FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
            WHERE g.field = 'artist' ORDER BY tt.rowid`
        )
        .all() as { id: number; value: string }[]
      const byTrack = new Map<number, string[]>()
      for (const r of tagRows) byTrack.set(r.id, [...(byTrack.get(r.id) ?? []), r.value])
      return tracks.map((t) => ({
        id: t.id,
        filepath: t.filepath,
        artistColumn: t.artist,
        tagValues: byTrack.get(t.id) ?? []
      }))
    },

    keepRules(): string[] {
      return (db.prepare(`SELECT raw FROM artist_keep_rules`).all() as { raw: string }[]).map(
        (r) => r.raw
      )
    },
    addKeepRule(raw: string): void {
      db.prepare(`INSERT OR IGNORE INTO artist_keep_rules (raw) VALUES (?)`).run(raw)
    },

    insertSuggestion(row: NewSuggestion): void {
      // OR IGNORE against UNIQUE(track_id, raw): a pending row is not
      // duplicated and a resolved one is not re-opened.
      db.prepare(
        `INSERT OR IGNORE INTO artist_suggestions (track_id, raw, suggested, confidence, reason)
         VALUES (@track_id, @raw, @suggested, @confidence, @reason)`
      ).run(row)
    },

    pendingGroups(): SuggestionGroup[] {
      return db
        .prepare(
          `SELECT s.raw AS raw, s.suggested AS suggested, s.confidence AS confidence,
                  s.reason AS reason, COUNT(*) AS trackCount
             FROM artist_suggestions s JOIN tracks t ON t.id = s.track_id
            WHERE s.status = 'pending' AND t.missing = 0
            GROUP BY s.raw, s.suggested
            ORDER BY CASE s.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                     COUNT(*) DESC, s.raw`
        )
        .all() as SuggestionGroup[]
    },

    pendingForRaw(raw: string): SuggestionRow[] {
      return db
        .prepare(
          `SELECT id, track_id, raw, suggested, confidence, reason, status
             FROM artist_suggestions WHERE status = 'pending' AND raw = ?`
        )
        .all(raw) as SuggestionRow[]
    },

    setSuggestionStatus(ids: number[], status: SuggestionStatus): void {
      const upd = db.prepare(`UPDATE artist_suggestions SET status = ? WHERE id = ?`)
      for (const id of ids) upd.run(status, id)
    },

    pendingCount(): number {
      return (
        db
          .prepare(
            `SELECT COUNT(DISTINCT s.track_id) AS n FROM artist_suggestions s
               JOIN tracks t ON t.id = s.track_id
              WHERE s.status = 'pending' AND t.missing = 0`
          )
          .get() as { n: number }
      ).n
    },

    journalAppend(e: JournalEntry): void {
      db.prepare(
        `INSERT INTO artist_clean_journal (batch_id, track_id, prev_column, prev_tags, file_written)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        e.batch_id,
        e.track_id,
        e.prev_column,
        JSON.stringify(e.prev_tags),
        e.file_written ? 1 : 0
      )
    },

    deleteOrphanArtistTag(value: string): void {
      db.prepare(
        `DELETE FROM tags WHERE field = 'artist' AND value = ?
            AND NOT EXISTS (SELECT 1 FROM track_tags WHERE tag_id = tags.id)`
      ).run(value)
    },
    journalAll(): JournalEntry[] {
      return (
        db
          .prepare(
            `SELECT batch_id, track_id, prev_column, prev_tags, file_written
                      FROM artist_clean_journal ORDER BY id`
          )
          .all() as {
          batch_id: string
          track_id: number
          prev_column: string | null
          prev_tags: string
          file_written: number
        }[]
      ).map((r) => ({
        batch_id: r.batch_id,
        track_id: r.track_id,
        prev_column: r.prev_column,
        prev_tags: JSON.parse(r.prev_tags) as string[],
        file_written: r.file_written === 1
      }))
    },
    journalClear(): void {
      db.prepare(`DELETE FROM artist_clean_journal`).run()
    },

    getSetting: (key) => deps.getSetting(key)
  }
}
