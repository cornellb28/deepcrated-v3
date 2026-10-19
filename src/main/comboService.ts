// ── Find combos: the main-process side ────────────────────────────────────
// Database → candidates → the pure scorer (shared/combos.ts). Runs in the
// main process, so the renderer's UI thread never does the work. One indexed
// query narrows the library (BPM window incl. half/double time, compatible
// keys) to at most CANDIDATE_LIMIT rows; only those are scored. Everything
// is local: no network.

import {
  getComboCandidates,
  getCrateIdsForTracks,
  getMatchTrack,
  getTrackTagsForTracks,
  type MatchCandidateRow
} from './db'
import { splitValue } from './tagFields'
import { tagKeysFor } from '../shared/tagKeys'
import {
  comboBpmRanges,
  comboKeyFilter,
  normalizeComboSettings,
  rankCombos,
  type ComboResult,
  type ComboSettings,
  type ComboTrack
} from '../shared/combos'
import { parseCamelot } from '../shared/trackMatch'
import { toEnergy } from '../shared/energy'

export const COMBO_CANDIDATE_LIMIT = 500
export const COMBO_RESULT_LIMIT = 30

// Fields whose values count as "tags" for the shared-tag bonus. Genre has
// its own bonus.
const TAG_COLUMNS = ['grouping', 'comment', 'label', 'remixer'] as const

export interface ComboItem extends ComboResult {
  title: string | null
  artist: string | null
  bpm: number | null
  key_camelot: string | null
  energy: number | null
  artwork_hash: string | null
}

export type CombosResponse =
  | { status: 'not-found' }
  | {
      status: 'ok'
      settings: ComboSettings
      source: {
        id: number
        title: string | null
        bpm: number | null
        key_camelot: string | null
        energy: number | null
        missing: string[]
      }
      results: ComboItem[]
      // How many candidates were scored (the database's cut).
      considered: number
    }

function comboTrack(
  row: MatchCandidateRow,
  extra: Map<number, { field: string; value: string }[]>,
  crates: Map<number, number[]>
): ComboTrack {
  const linked = extra.get(row.id) ?? []
  const fromColumns = TAG_COLUMNS.flatMap((f) => splitValue(f, row[f]))
  return {
    id: row.id,
    bpm: row.bpm && row.bpm > 0 ? row.bpm : null,
    key: parseCamelot(row.key_camelot) ? row.key_camelot : null,
    energy: toEnergy(row.energy),
    genres: tagKeysFor(splitValue('genre', row.genre)),
    tags: tagKeysFor([
      ...fromColumns,
      ...linked.filter((t) => t.field !== 'genre').map((t) => t.value)
    ]),
    crateIds: crates.get(row.id) ?? []
  }
}

export function findCombos(trackId: number, settingsInput: unknown): CombosResponse {
  const settings = normalizeComboSettings(settingsInput)
  const sourceRow = getMatchTrack(trackId)
  if (!sourceRow) return { status: 'not-found' }

  const sourceBpm = sourceRow.bpm && sourceRow.bpm > 0 ? sourceRow.bpm : null
  const rows = getComboCandidates(
    trackId,
    sourceBpm,
    sourceBpm ? comboBpmRanges(sourceBpm, settings) : [],
    comboKeyFilter(sourceRow.key_camelot, settings),
    COMBO_CANDIDATE_LIMIT
  )
  const ids = [trackId, ...rows.map((r) => r.id)]
  const tags = getTrackTagsForTracks(ids)
  const byTrack = new Map(ids.map((id) => [id, tags[id] ?? []]))
  const crates = getCrateIdsForTracks(ids)

  const source = comboTrack(sourceRow, byTrack, crates)
  const ranked = rankCombos(
    source,
    rows.map((r) => comboTrack(r, byTrack, crates)),
    settings,
    COMBO_RESULT_LIMIT
  )
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const missing: string[] = []
  if (!source.key) missing.push('key')
  if (!source.bpm) missing.push('bpm')
  if (source.energy === null) missing.push('energy')

  return {
    status: 'ok',
    settings,
    source: {
      id: sourceRow.id,
      title: sourceRow.title,
      bpm: source.bpm,
      key_camelot: source.key,
      energy: source.energy,
      missing
    },
    results: ranked.map((r) => {
      const row = rowById.get(r.id)!
      return {
        ...r,
        title: row.title,
        artist: row.artist,
        bpm: row.bpm,
        key_camelot: row.key_camelot,
        energy: toEnergy(row.energy),
        artwork_hash: row.artwork_hash
      }
    }),
    considered: rows.length
  }
}
