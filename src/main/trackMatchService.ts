// ── Track Match: the main-process side ────────────────────────────────────
// Glue between the database and the pure scorer (src/shared/trackMatch.ts).
// better-sqlite3 runs on this thread, so the library is never scored whole:
// one indexed SQL query pre-filters by BPM window (with half/double time) and
// compatible keys, capped at CANDIDATE_LIMIT, and only those are scored.

import {
  getMatchCandidates,
  getMatchPreviewTrackId,
  getMatchTrack,
  getMixProfileRow,
  getTagCoverage,
  getTrackTagsForTracks,
  saveMixProfileRow,
  type MatchCandidateRow
} from './db'
import { splitValue } from './tagFields'
import {
  bpmRanges,
  normalizeProfile,
  preFilterKeys,
  PROFILE_VERSION,
  rankCandidates,
  type Direction,
  type MatchTrack,
  type MixProfile,
  type TrackTags
} from '../shared/trackMatch'

export const CANDIDATE_LIMIT = 200
export const RESULT_LIMIT = 20
// Below this share of tagged tracks the library is a cold start: key + BPM.
export const COLD_START_COVERAGE = 0.2

// Tag fields with no tracks column: read from track_tags.
const TAG_ONLY_FIELDS = ['vibe', 'venue', 'custom'] as const
type TagOnlyField = (typeof TAG_ONLY_FIELDS)[number]
type TagOnlyValues = Partial<Record<TagOnlyField, string[]>>
const URL_LIKE = /:\/\/|^www\.|\.(com|net|org|ru|info)\b/i

// ── The profile ───────────────────────────────────────────────────────────

export type ProfileState = 'defaults' | 'skipped' | 'completed'

export interface StoredProfile {
  profile: MixProfile
  state: ProfileState
  updatedAt: number | null
}

export function loadMixProfile(): StoredProfile {
  const row = getMixProfileRow()
  if (!row) return { profile: normalizeProfile(null), state: 'defaults', updatedAt: null }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(row.profile_json)
  } catch {
    // A corrupt row reads as defaults rather than breaking matching.
  }
  return { profile: normalizeProfile(parsed), state: row.survey_state, updatedAt: row.updated_at }
}

// "Skip" saves the defaults with state 'skipped'.
export function saveMixProfile(input: unknown, state: 'skipped' | 'completed'): StoredProfile {
  const profile = normalizeProfile(input)
  const row = saveMixProfileRow(JSON.stringify(profile), PROFILE_VERSION, state)
  return { profile, state: row.survey_state, updatedAt: row.updated_at }
}

// ── Tracks as the scorer sees them ────────────────────────────────────────

function tagsOf(row: MatchCandidateRow, extras: TagOnlyValues): TrackTags {
  return {
    genre: splitValue('genre', row.genre),
    grouping: splitValue('grouping', row.grouping),
    label: splitValue('label', row.label),
    remixer: splitValue('remixer', row.remixer),
    // URL-like comment values (download-site stamps left in real files) are
    // noise, not tags.
    comment: splitValue('comment', row.comment).filter((v) => !URL_LIKE.test(v)),
    composer: splitValue('composer', row.composer),
    vibe: extras.vibe ?? [],
    venue: extras.venue ?? [],
    custom: extras.custom ?? []
  }
}

function extraTags(ids: number[]): Map<number, TagOnlyValues> {
  const byTrack = getTrackTagsForTracks(ids) as Record<number, { field: string; value: string }[]>
  const out = new Map<number, TagOnlyValues>()
  for (const id of ids) {
    const values: TagOnlyValues = {}
    for (const t of byTrack[id] ?? []) {
      if (!(TAG_ONLY_FIELDS as readonly string[]).includes(t.field)) continue
      const field = t.field as TagOnlyField
      ;(values[field] ??= []).push(t.value)
    }
    out.set(id, values)
  }
  return out
}

function toMatchTrack(row: MatchCandidateRow, extras: TagOnlyValues): MatchTrack {
  return {
    id: row.id,
    artist: row.artist,
    bpm: row.bpm,
    key: row.key_camelot,
    energy: row.energy,
    tags: tagsOf(row, extras)
  }
}

// ── Related tracks ────────────────────────────────────────────────────────

export interface RelatedItem {
  id: number
  title: string | null
  artist: string | null
  artwork_hash: string | null
  score: number
  reasons: string[]
}

export type RelatedResult =
  | {
      status: 'ok'
      results: RelatedItem[]
      coldStart: boolean
      // Lift/Drop used BPM because the source has no energy.
      directionByBpm: boolean
      candidatesScored: number
    }
  | { status: 'needs-key-bpm' }
  | { status: 'not-found' }

export function getRelatedTracks(
  trackId: number,
  direction: Direction = 'similar',
  profileOverride?: unknown
): RelatedResult {
  const sourceRow = getMatchTrack(trackId)
  if (!sourceRow) return { status: 'not-found' }
  const profile =
    profileOverride === undefined ? loadMixProfile().profile : normalizeProfile(profileOverride)
  if (!sourceRow.bpm || sourceRow.bpm <= 0) return { status: 'needs-key-bpm' }
  const keys = preFilterKeys(sourceRow.key_camelot, profile)
  if (keys === null && profile.keyMode !== 'loose') return { status: 'needs-key-bpm' }

  const rows = getMatchCandidates(
    trackId,
    sourceRow.bpm,
    profile.halfDouble,
    bpmRanges(sourceRow.bpm, profile),
    keys,
    CANDIDATE_LIMIT
  )
  const extras = extraTags([trackId, ...rows.map((r) => r.id)])
  const coverage = getTagCoverage()
  const coldStart = coverage.total === 0 || coverage.tagged / coverage.total < COLD_START_COVERAGE

  const outcome = rankCandidates(
    toMatchTrack(sourceRow, extras.get(trackId) ?? {}),
    rows.map((r) => toMatchTrack(r, extras.get(r.id) ?? {})),
    profile,
    { direction, coldStart, limit: RESULT_LIMIT }
  )
  if (outcome.status !== 'ok') return { status: 'needs-key-bpm' }

  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    status: 'ok',
    coldStart,
    directionByBpm: direction !== 'similar' && typeof sourceRow.energy !== 'number',
    candidatesScored: rows.length,
    results: outcome.results.map((r) => {
      const row = byId.get(r.id)!
      return {
        id: r.id,
        title: row.title,
        artist: row.artist,
        artwork_hash: row.artwork_hash,
        score: Math.round(r.score * 1000) / 1000,
        reasons: r.reasons
      }
    })
  }
}

// The survey's last screen: suggestions for one of the DJ's own tracks,
// scored with the answers as they stand (not yet saved).
export function previewRelated(profileDraft: unknown): {
  source: { id: number; title: string | null; artist: string | null } | null
  result: RelatedResult | null
} {
  const id = getMatchPreviewTrackId()
  if (id === null) return { source: null, result: null }
  const row = getMatchTrack(id)!
  return {
    source: { id, title: row.title, artist: row.artist },
    result: getRelatedTracks(id, 'similar', profileDraft)
  }
}
