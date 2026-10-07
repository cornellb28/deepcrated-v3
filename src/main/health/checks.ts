// ── Crate Health: the built-in checks ────────────────────────────────────
// Each check is either a rule over the rules.ts format or, where a rule
// cannot express it (duplicates need to compare rows with each other), a
// named query. Both produce the same two things from ONE SQL fragment — the
// ids of the failing tracks — and the count is simply COUNT over that same
// query. That is what guarantees a dashboard box can never say 128 while the
// list under it holds 130.
//
// Read-only. No schema, index or data change; no automatic fixing.
//
// Pure of Electron and of db.ts: the functions take a better-sqlite3
// handle, so tests run them against an in-memory database.

import type Database from 'better-sqlite3'
import { compileRule, type RuleGroup } from './rules'

export type HealthCheckId =
  | 'missing_artwork'
  | 'missing_key'
  | 'missing_bpm'
  | 'missing_genre'
  | 'missing_artist'
  | 'no_tags'
  | 'duplicates'
  | 'inconsistent_artist'
  | 'unreadable_audio'
  | 'missing_file'

interface BaseCheck {
  id: HealthCheckId
  label: string
  // What the DJ does about it, shown in the queue header.
  hint: string
}

interface RuleCheck extends BaseCheck {
  kind: 'rule'
  rule: RuleGroup
}

interface QueryCheck extends BaseCheck {
  kind: 'query'
  // SELECT of failing track ids, in the order the queue should show them.
  idsSql: string
}

export type HealthCheck = RuleCheck | QueryCheck

// Every check but "missing file" looks only at tracks whose file exists: a
// missing file can't have its tags edited or be analyzed, and counting it
// under every other check would inflate them all.
const LIVE = { field: 'missing', op: 'eq', value: 0 } as const

function liveRule(...rules: RuleGroup['rules']): RuleGroup {
  return { combine: 'all', rules: [LIVE, ...rules] }
}

// A "missing X" for a tag-backed field means the derived column is empty AND
// there is no tag of that field: a track is only flagged when it is truly
// bare, so a genre that exists as a tag but whose column has not been
// written yet is not a false alarm.
function bareField(field: 'genre' | 'artist'): RuleGroup['rules'][number] {
  return {
    combine: 'all',
    rules: [
      { field, op: 'is_empty' },
      { field: `tag.${field}`, op: 'is_empty' }
    ]
  }
}

// Duplicates: two live tracks are a candidate pair if they share a
// normalised artist + title, or the same byte size and (rounded) duration.
// Pairs the DJ has dismissed (dismissed_duplicate_pairs, either order) are
// not surfaced: a track stays flagged while it still has at least one
// partner in its group it has not been dismissed against.
//
// Built from window-function group sizes, NOT a pairwise self-join. The
// self-join version was measured on a 51k-track copy and did not finish in
// 60 seconds (the planner fell back to a nested loop); this grouping is one
// sort per key. The dismissed table is joined from its own side, so its cost
// follows how many pairs were dismissed, not the library size.
//
// TODO(health): nothing writes dismissed_duplicate_pairs yet — the dismiss
// action belongs with the duplicate review UI, not this read-only slice.
// TODO(health): size+duration rounds to whole seconds, so two copies that
// straddle a rounding boundary are missed; revisit with a tolerance if real
// libraries show it.
const DUPLICATE_IDS_SQL = `
  WITH keyed AS (
    SELECT id, artist, title,
      CASE WHEN TRIM(COALESCE(artist, '')) <> '' AND TRIM(COALESCE(title, '')) <> ''
        THEN LOWER(TRIM(artist)) || char(31) || LOWER(TRIM(title)) END AS name_key,
      CASE WHEN COALESCE(file_size_bytes, 0) > 0 AND duration_sec IS NOT NULL
        THEN file_size_bytes || ':' || CAST(ROUND(duration_sec) AS INTEGER) END AS size_key
    FROM tracks
    WHERE missing = 0
  ),
  sized AS (
    SELECT id, 'n' AS kind, name_key AS gk,
      COUNT(*) OVER (PARTITION BY name_key) AS n
    FROM keyed WHERE name_key IS NOT NULL
    UNION ALL
    SELECT id, 's', size_key, COUNT(*) OVER (PARTITION BY size_key)
    FROM keyed WHERE size_key IS NOT NULL
  ),
  members AS (SELECT id, kind, gk, n FROM sized WHERE n > 1),
  dismissed AS (
    SELECT m.id, m.kind, m.gk, COUNT(*) AS d
    FROM dismissed_duplicate_pairs p
    JOIN members m ON m.id = p.track_id_a
    JOIN members o ON o.id = p.track_id_b AND o.kind = m.kind AND o.gk = m.gk
    GROUP BY m.id, m.kind, m.gk
    UNION ALL
    SELECT m.id, m.kind, m.gk, COUNT(*)
    FROM dismissed_duplicate_pairs p
    JOIN members m ON m.id = p.track_id_b
    JOIN members o ON o.id = p.track_id_a AND o.kind = m.kind AND o.gk = m.gk
    GROUP BY m.id, m.kind, m.gk
  ),
  flagged AS (
    SELECT m.id FROM members m
    LEFT JOIN (SELECT id, kind, gk, SUM(d) AS d FROM dismissed GROUP BY id, kind, gk) x
      ON x.id = m.id AND x.kind = m.kind AND x.gk = m.gk
    WHERE m.n - 1 > COALESCE(x.d, 0)
  )
  SELECT k.id FROM keyed k
  WHERE k.id IN (SELECT id FROM flagged)
  ORDER BY LOWER(COALESCE(k.artist, '')), LOWER(COALESCE(k.title, '')), k.id
`

export const HEALTH_CHECKS: readonly HealthCheck[] = [
  {
    id: 'missing_artwork',
    kind: 'rule',
    label: 'Missing artwork',
    hint: 'Add art from the inspector, or re-import if the file has art embedded.',
    rule: liveRule({ field: 'artwork_hash', op: 'is_empty' })
  },
  {
    id: 'missing_key',
    kind: 'rule',
    label: 'Missing key',
    hint: 'Analysis fills these in — select them and run it.',
    rule: liveRule({ field: 'key_camelot', op: 'is_empty' })
  },
  {
    id: 'missing_bpm',
    kind: 'rule',
    label: 'Missing BPM',
    hint: 'Analysis fills these in — select them and run it.',
    rule: liveRule({ field: 'bpm', op: 'is_empty' })
  },
  {
    id: 'missing_genre',
    kind: 'rule',
    label: 'Missing genre',
    hint: 'Set a genre in the inspector, or tag several at once with bulk edit.',
    rule: liveRule(bareField('genre'))
  },
  {
    id: 'missing_artist',
    kind: 'rule',
    label: 'Missing artist',
    hint: 'Set an artist in the inspector, or tag several at once with bulk edit.',
    rule: liveRule(bareField('artist'))
  },
  {
    id: 'no_tags',
    kind: 'rule',
    label: 'No tags at all',
    hint: 'Tag these from the inspector, or several at once with bulk edit.',
    rule: liveRule({ field: 'tag.any', op: 'is_empty' })
  },
  {
    id: 'duplicates',
    kind: 'query',
    label: 'Possible duplicates',
    hint: 'Same artist and title, or the same size and length. Listed side by side.',
    idsSql: DUPLICATE_IDS_SQL
  },
  {
    id: 'inconsistent_artist',
    kind: 'query',
    label: 'Inconsistent artist names',
    hint: 'Spelled differently from an artist you already have ("Notorious BIG" vs "The Notorious B.I.G."). Review the suggestions to change, edit or keep each.',
    // Tracks with a suggestion still waiting in the artist-cleanup inbox.
    idsSql: `
      SELECT t.id FROM tracks t
      WHERE t.missing = 0
        AND EXISTS (SELECT 1 FROM artist_suggestions s
                    WHERE s.track_id = t.id AND s.status = 'pending')
      ORDER BY LOWER(COALESCE(t.artist, '')), t.id`
  },
  {
    id: 'unreadable_audio',
    kind: 'rule',
    label: 'Unreadable or damaged audio',
    hint: 'Analysis found these files cut off, damaged or undecodable. Re-download or re-rip them, or remove them from the library (⋮ menu) — delete the file only if you have a good copy.',
    rule: liveRule({ field: 'analysis_error', op: 'is_not_empty' })
  },
  {
    id: 'missing_file',
    kind: 'rule',
    label: 'Missing or moved files',
    hint: 'The file is gone from disk. Relink it by re-importing the folder it moved to.',
    rule: { combine: 'all', rules: [{ field: 'missing', op: 'eq', value: 1 }] }
  }
]

// Fix actions offered in a check's queue header. The renderer renders whatever
// is listed here and decides what each id does.
//
// inconsistent_artist -> opens the artist-name review and re-clean (this is
// where the artist cleanup hooks in).
//
// TODO(health): MusicBrainz auto-fill and any other fixer registers here per
// check id the same way (see Metadata Cleanup). Nothing else fixes anything
// automatically.
export interface HealthFixAction {
  id: string
  label: string
}
export const HEALTH_FIX_ACTIONS: Partial<Record<HealthCheckId, readonly HealthFixAction[]>> = {
  inconsistent_artist: [{ id: 'review-artist-names', label: 'Review artist names…' }]
}

export function isHealthCheckId(value: unknown): value is HealthCheckId {
  return typeof value === 'string' && HEALTH_CHECKS.some((c) => c.id === value)
}

// ── SQL for one check ────────────────────────────────────────────────────

interface IdsQuery {
  sql: string
  params: (string | number)[]
}

export function idsQueryFor(check: HealthCheck): IdsQuery {
  if (check.kind === 'query') return { sql: check.idsSql, params: [] }
  const where = compileRule(check.rule, 't')
  return {
    sql: `SELECT t.id FROM tracks t WHERE ${where.sql} ORDER BY t.id`,
    params: where.params
  }
}

// ── Public service ───────────────────────────────────────────────────────

export interface HealthCheckResult {
  id: HealthCheckId
  label: string
  hint: string
  count: number
  fixActions: readonly HealthFixAction[]
}

// The overall indicator counts every check except "missing file": those
// tracks are reported on their own and excluded from all the others.
export interface HealthSummary {
  // Tracks whose file exists — the population every check but "missing
  // file" is measured against.
  liveTracks: number
  // Live tracks failing at least one check, counted once however many.
  flaggedTracks: number
  checks: HealthCheckResult[]
}

export function getHealthSummary(db: Database.Database): HealthSummary {
  // Each check's query runs exactly ONCE and everything else is derived from
  // its ids: the count is the id list's length (so it cannot differ from the
  // queue), and the overall indicator is a Set union in JS. Running the
  // duplicates query a second time inside a SQL UNION was measured at an
  // extra ~200 ms on a 51k-track copy, all of it blocking the main process.
  const flagged = new Set<number>()
  const checks: HealthCheckResult[] = HEALTH_CHECKS.map((check) => {
    const { sql, params } = idsQueryFor(check)
    const ids = db
      .prepare(sql)
      .pluck()
      .all(...params) as number[]
    if (check.id !== 'missing_file') for (const id of ids) flagged.add(id)
    return {
      id: check.id,
      label: check.label,
      hint: check.hint,
      count: ids.length,
      fixActions: HEALTH_FIX_ACTIONS[check.id] ?? []
    }
  })

  const live = db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE missing = 0`).get() as {
    n: number
  }
  return { liveTracks: live.n, flaggedTracks: flagged.size, checks }
}

// Ids of the tracks failing a check, in display order. The renderer resolves
// them against its own store, so rows stay live (edits, selection, menus)
// without a second copy of the track data crossing IPC.
export function getHealthQueue(db: Database.Database, checkId: HealthCheckId): number[] {
  const check = HEALTH_CHECKS.find((c) => c.id === checkId)
  if (!check) throw new Error(`Unknown health check "${String(checkId)}"`)
  const { sql, params } = idsQueryFor(check)
  return (db.prepare(sql).all(...params) as { id: number }[]).map((r) => r.id)
}
