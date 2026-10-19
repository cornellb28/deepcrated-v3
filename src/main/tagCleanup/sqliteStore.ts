// ── Metadata Cleanup: SQLite side ─────────────────────────────────────────
// Takes the open handle from db.ts, like artist/ and stats/. Every write is
// one transaction: a track's tags, its derived column and the change log
// move together or not at all.
//
// Values are stored EXACTLY as given. setTagsForField runs values through
// normalizeTagValue, which title-cases plain genre words ("RnB" → "Rnb",
// "EDM" → "Edm"); a spelling the DJ chose must survive, so this links tags
// directly (as scripts/tag-backfill.mjs does) and derives the column the same
// way db.ts does.

import type Database from 'better-sqlite3'
import { joinValues } from '../tagFields'
import {
  CLEANUP_FIELDS,
  type CleanupRules,
  type PlannedChange,
  type TrackFieldInput
} from '../../shared/tagCleanup'

export interface CleanupTrackRow {
  input: TrackFieldInput
  title: string | null
  artist: string | null
  filepath: string
  missing: boolean
}

export interface ApplySummary {
  batchId: string
  dryRun: boolean
  tracks: number
  changes: number
  byField: Record<string, number>
  tagsCreated: string[] // "field:value"
  tagsDeleted: string[]
  files: number // tracks whose file can be written (present, not missing)
}

export interface BatchInfo {
  id: string
  createdAt: number
  source: 'library' | 'import'
  status: 'applied' | 'undone'
  filesStatus: string
  changes: number
  filesWritten: number
  examples: { field: string; before: string | null; after: string[] }[]
}

export interface UndoSummary {
  batchId: string
  dryRun: boolean
  restored: number
  skipped: { trackId: number; title: string | null; reason: string }[]
  filesToRestore: number
}

export interface FileWrite {
  changeId: number
  trackId: number
  filepath: string
  field: string
  value: string
}

export interface TagCleanupStore {
  readTracks(trackIds?: readonly number[]): CleanupTrackRow[]
  loadRules(): CleanupRules
  saveRules(rules: CleanupRules): void
  apply(
    batchId: string,
    source: 'library' | 'import',
    changes: readonly PlannedChange[],
    isCombined: (field: string, value: string) => boolean,
    dryRun: boolean
  ): ApplySummary
  listBatches(): BatchInfo[]
  undo(batchId: string, dryRun: boolean): UndoSummary
  // Files still to write for a batch, oldest change first.
  pendingFileWrites(batchId: string, limit?: number): FileWrite[]
  // Restored changes whose file was written and not yet put back.
  pendingFileRestores(batchId: string): FileWrite[]
  markFileWritten(changeId: number): void
  markFileRestored(changeId: number): void
  setFilesStatus(batchId: string, status: string): void
}

class Rollback extends Error {}

export function createSqliteTagCleanupStore(db: Database.Database): TagCleanupStore {
  const fieldList = CLEANUP_FIELDS.map((f) => `'${f}'`).join(',')

  function linkedValues(trackId: number, field: string): string[] {
    return (
      db
        .prepare(
          `SELECT g.value FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
            WHERE tt.track_id = ? AND g.field = ? ORDER BY tt.rowid`
        )
        .all(trackId, field) as { value: string }[]
    ).map((r) => r.value)
  }

  function exactTagId(field: string, value: string): { id: number; created: boolean } {
    const ins = db
      .prepare(`INSERT OR IGNORE INTO tags (field, value) VALUES (?, ?)`)
      .run(field, value)
    const row = db
      .prepare(`SELECT id FROM tags WHERE field = ? AND value = ?`)
      .get(field, value) as { id: number } | undefined
    if (!row) throw new Error(`Failed to find or create tag: ${field}/${value}`)
    return { id: row.id, created: ins.changes > 0 }
  }

  // Replaces the field's tags with `values` (exact) and sets the column.
  // `column` overrides the derived value (undo puts back what was stored).
  function setExact(
    trackId: number,
    field: string,
    values: readonly string[],
    created: Set<string>,
    column?: string | null
  ): void {
    if (!(CLEANUP_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`Not a cleanup field: ${field}`)
    }
    db.prepare(
      `DELETE FROM track_tags WHERE track_id = ? AND tag_id IN (SELECT id FROM tags WHERE field = ?)`
    ).run(trackId, field)
    for (const v of values) {
      const tag = exactTagId(field, v)
      if (tag.created) created.add(`${field}:${v}`)
      db.prepare(`INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)`).run(
        trackId,
        tag.id
      )
    }
    const value = column !== undefined ? column : joinValues(linkedValues(trackId, field), field)
    // field is checked against CLEANUP_FIELDS above, so it is safe in SQL.
    db.prepare(`UPDATE tracks SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(
      value,
      trackId
    )
  }

  return {
    readTracks(trackIds) {
      const filter = trackIds ? `WHERE id IN (${trackIds.map(() => '?').join(',') || 'NULL'})` : ''
      const tracks = db
        .prepare(
          `SELECT id, title, artist, filepath, missing, ${CLEANUP_FIELDS.join(', ')}
             FROM tracks ${filter}`
        )
        .all(...(trackIds ?? [])) as Record<string, unknown>[]
      const links = db
        .prepare(
          `SELECT tt.track_id, g.field, g.value FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
            WHERE g.field IN (${fieldList}) ORDER BY tt.rowid`
        )
        .all() as { track_id: number; field: string; value: string }[]
      const linked = new Map<string, string[]>()
      for (const l of links) {
        const k = `${l.track_id}:${l.field}`
        const list = linked.get(k)
        if (list) list.push(l.value)
        else linked.set(k, [l.value])
      }
      const out: CleanupTrackRow[] = []
      for (const t of tracks) {
        const id = t.id as number
        for (const field of CLEANUP_FIELDS) {
          const column = (t[field] as string | null) ?? null
          const tags = linked.get(`${id}:${field}`) ?? []
          if (!column && tags.length === 0) continue
          out.push({
            input: { trackId: id, field, column, linked: tags },
            title: (t.title as string | null) ?? null,
            artist: (t.artist as string | null) ?? null,
            filepath: t.filepath as string,
            missing: !!t.missing
          })
        }
      }
      return out
    },

    loadRules() {
      const delimiters: Record<string, string[]> = {}
      for (const r of db
        .prepare(`SELECT field, delimiter FROM tag_split_rules ORDER BY created_at, rowid`)
        .all() as { field: string; delimiter: string }[]) {
        ;(delimiters[r.field] ??= []).push(r.delimiter)
      }
      const rewrites: Record<string, Record<string, string[]>> = {}
      for (const r of db
        .prepare(`SELECT field, match_key, result FROM tag_rewrite_rules`)
        .all() as { field: string; match_key: string; result: string }[]) {
        ;(rewrites[r.field] ??= {})[r.match_key] = JSON.parse(r.result)
      }
      return { delimiters, rewrites }
    },

    saveRules(rules) {
      db.transaction(() => {
        for (const [field, ds] of Object.entries(rules.delimiters)) {
          for (const d of ds ?? []) {
            db.prepare(
              `INSERT OR IGNORE INTO tag_split_rules (field, delimiter) VALUES (?, ?)`
            ).run(field, d)
          }
        }
        for (const [field, map] of Object.entries(rules.rewrites)) {
          for (const [key, result] of Object.entries(map ?? {})) {
            db.prepare(
              `INSERT INTO tag_rewrite_rules (field, match_key, result) VALUES (?, ?, ?)
               ON CONFLICT(field, match_key) DO UPDATE SET result = excluded.result`
            ).run(field, key, JSON.stringify(result))
          }
        }
      })()
    },

    apply(batchId, source, changes, isCombined, dryRun) {
      const created = new Set<string>()
      const deleted: string[] = []
      const byField: Record<string, number> = {}
      const tracks = new Set<number>()
      let files = 0

      const run = db.transaction(() => {
        db.prepare(`INSERT INTO tag_cleanup_batches (id, source) VALUES (?, ?)`).run(
          batchId,
          source
        )
        const touchedFields = new Set<string>()
        for (const c of changes) {
          const track = db.prepare(`SELECT missing FROM tracks WHERE id = ?`).get(c.trackId) as
            { missing: number } | undefined
          if (!track) continue
          setExact(c.trackId, c.field, c.newTags, created)
          db.prepare(
            `INSERT INTO tag_cleanup_changes
               (batch_id, track_id, field, prev_column, prev_tags, new_tags)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            batchId,
            c.trackId,
            c.field,
            c.prevColumn,
            JSON.stringify(c.prevTags),
            JSON.stringify(c.newTags)
          )
          byField[c.field] = (byField[c.field] ?? 0) + 1
          if (!tracks.has(c.trackId) && !track.missing) files++
          tracks.add(c.trackId)
          touchedFields.add(c.field)
        }
        // Tag rows nothing uses any more: the ones this batch unlinked, and
        // old combined values ("Soul x Boogie x Jazz") in the fields it
        // cleaned. Other unused rows are not this batch's business.
        const unlinked = new Set(changes.flatMap((c) => c.prevTags.map((v) => `${c.field}:${v}`)))
        const unused = db
          .prepare(
            `SELECT id, field, value FROM tags g
              WHERE field IN (${fieldList})
                AND NOT EXISTS (SELECT 1 FROM track_tags WHERE tag_id = g.id)`
          )
          .all() as { id: number; field: string; value: string }[]
        for (const t of unused) {
          const key = `${t.field}:${t.value}`
          if (!unlinked.has(key) && !(touchedFields.has(t.field) && isCombined(t.field, t.value))) {
            continue
          }
          db.prepare(`DELETE FROM tags WHERE id = ?`).run(t.id)
          deleted.push(key)
        }
        if (dryRun) throw new Rollback()
      })
      try {
        run()
      } catch (err) {
        if (!(err instanceof Rollback)) throw err
      }
      return {
        batchId,
        dryRun,
        tracks: tracks.size,
        changes: Object.values(byField).reduce((a, b) => a + b, 0),
        byField,
        tagsCreated: [...created].sort(),
        tagsDeleted: deleted.sort(),
        files
      }
    },

    listBatches() {
      const rows = db
        .prepare(
          `SELECT b.id, b.created_at, b.source, b.status, b.files_status,
                  COUNT(c.id) AS changes, COALESCE(SUM(c.file_written), 0) AS files_written
             FROM tag_cleanup_batches b LEFT JOIN tag_cleanup_changes c ON c.batch_id = b.id
            GROUP BY b.id ORDER BY b.created_at DESC, b.rowid DESC`
        )
        .all() as {
        id: string
        created_at: number
        source: 'library' | 'import'
        status: 'applied' | 'undone'
        files_status: string
        changes: number
        files_written: number
      }[]
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        source: r.source,
        status: r.status,
        filesStatus: r.files_status,
        changes: r.changes,
        filesWritten: r.files_written,
        examples: (
          db
            .prepare(
              `SELECT field, prev_column, new_tags FROM tag_cleanup_changes
                WHERE batch_id = ? ORDER BY id LIMIT 3`
            )
            .all(r.id) as { field: string; prev_column: string | null; new_tags: string }[]
        ).map((e) => ({ field: e.field, before: e.prev_column, after: JSON.parse(e.new_tags) }))
      }))
    },

    undo(batchId, dryRun) {
      const batch = db
        .prepare(`SELECT status FROM tag_cleanup_batches WHERE id = ?`)
        .get(batchId) as { status: string } | undefined
      if (!batch) throw new Error('No such cleanup batch')
      if (batch.status !== 'applied') throw new Error('This cleanup was already undone')

      const skipped: UndoSummary['skipped'] = []
      let restored = 0
      let filesToRestore = 0
      const run = db.transaction(() => {
        const changes = db
          .prepare(
            `SELECT id, track_id, field, prev_column, prev_tags, new_tags, file_written
               FROM tag_cleanup_changes WHERE batch_id = ? ORDER BY id DESC`
          )
          .all(batchId) as {
          id: number
          track_id: number
          field: string
          prev_column: string | null
          prev_tags: string
          new_tags: string
          file_written: number
        }[]
        for (const c of changes) {
          const track = db
            .prepare(`SELECT title, ${c.field} AS col FROM tracks WHERE id = ?`)
            .get(c.track_id) as { title: string | null; col: string | null } | undefined
          if (!track) {
            skipped.push({ trackId: c.track_id, title: null, reason: 'Track was deleted' })
            continue
          }
          // Only a track still exactly as this batch left it is put back; one
          // edited since keeps the edit.
          const expected: string[] = JSON.parse(c.new_tags)
          const now = linkedValues(c.track_id, c.field)
          const same =
            now.length === expected.length &&
            now.every((v, i) => v === expected[i]) &&
            track.col === joinValues(expected, c.field)
          if (!same) {
            skipped.push({
              trackId: c.track_id,
              title: track.title,
              reason: `${c.field} was edited after the cleanup`
            })
            continue
          }
          setExact(c.track_id, c.field, JSON.parse(c.prev_tags), new Set(), c.prev_column)
          db.prepare(`UPDATE tag_cleanup_changes SET restored = 1 WHERE id = ?`).run(c.id)
          restored++
          if (c.file_written) filesToRestore++
        }
        db.prepare(
          `UPDATE tag_cleanup_batches SET status = 'undone', undone_at = strftime('%s','now')
            WHERE id = ?`
        ).run(batchId)
        if (dryRun) throw new Rollback()
      })
      try {
        run()
      } catch (err) {
        if (!(err instanceof Rollback)) throw err
      }
      return { batchId, dryRun, restored, skipped, filesToRestore }
    },

    pendingFileWrites(batchId, limit) {
      const rows = db
        .prepare(
          `SELECT c.id, c.track_id, c.field, t.filepath
             FROM tag_cleanup_changes c JOIN tracks t ON t.id = c.track_id
             JOIN tag_cleanup_batches b ON b.id = c.batch_id
            WHERE c.batch_id = ? AND b.status = 'applied' AND c.file_written = 0
              AND t.missing = 0
            ORDER BY c.id ${limit ? 'LIMIT ' + Math.max(1, Math.floor(limit)) : ''}`
        )
        .all(batchId) as { id: number; track_id: number; field: string; filepath: string }[]
      // The file gets what DeepCrated holds now, so it matches the library
      // even if a field was edited again since.
      return rows.map((r) => {
        const value = (
          db.prepare(`SELECT ${r.field} AS v FROM tracks WHERE id = ?`).get(r.track_id) as {
            v: string | null
          }
        ).v
        return {
          changeId: r.id,
          trackId: r.track_id,
          filepath: r.filepath,
          field: r.field,
          value: value ?? ''
        }
      })
    },

    pendingFileRestores(batchId) {
      return (
        db
          .prepare(
            `SELECT c.id, c.track_id, c.field, c.prev_column, t.filepath
               FROM tag_cleanup_changes c JOIN tracks t ON t.id = c.track_id
              WHERE c.batch_id = ? AND c.restored = 1 AND c.file_written = 1
                AND c.file_restored = 0 AND t.missing = 0
              ORDER BY c.id`
          )
          .all(batchId) as {
          id: number
          track_id: number
          field: string
          prev_column: string | null
          filepath: string
        }[]
      ).map((r) => ({
        changeId: r.id,
        trackId: r.track_id,
        filepath: r.filepath,
        field: r.field,
        value: r.prev_column ?? ''
      }))
    },

    markFileWritten(changeId) {
      db.prepare(`UPDATE tag_cleanup_changes SET file_written = 1 WHERE id = ?`).run(changeId)
    },
    markFileRestored(changeId) {
      db.prepare(`UPDATE tag_cleanup_changes SET file_restored = 1 WHERE id = ?`).run(changeId)
    },
    setFilesStatus(batchId, status) {
      db.prepare(`UPDATE tag_cleanup_batches SET files_status = ? WHERE id = ?`).run(
        status,
        batchId
      )
    }
  }
}
