import { createHash } from 'crypto'
import { readFile, stat, open } from 'fs/promises'
import type { MissingTrackCandidate } from './db'
import { computeCanonicalTrackId } from './identity/canonical'

// Shared by the folder-import/live-add reconcile pass in index.ts and the
// Serato history/database importer — both need "does this file match a
// track we already know about" and neither should carry its own copy of the
// fingerprinting rules.

// Encoder/container rounding tolerance for the fingerprint fallback's
// duration comparison — not an exact-match field like size or filename.
export const FINGERPRINT_DURATION_TOLERANCE_SEC = 0.5

// A 64KB slice ~40% into the file — cheap (one small read, not a full-file
// hash) but, combined with an already-exact size+duration match, more than
// enough to tell two genuinely different tracks apart. Deliberately NOT the
// head or tail of the file: write_tags (sidecar/analyze.py) rewrites the
// ID3v2/APEv2/MP4 metadata containers that live there, so a hash taken from
// either end would go stale the moment a track gets its BPM/key written
// back — exactly the case reconcile most needs to survive. Only ever called
// lazily, when size+duration alone left more than one candidate — see
// findReconcileMatch. Stored on every track at insert time regardless (see
// index.ts's buildTrackData callers): a track can't be hashed once it's gone
// missing, so the value has to already be sitting on the row before that
// happens, not computed on demand for the missing side.
export const PARTIAL_HASH_BYTES = 65536

export async function computePartialHash(filepath: string): Promise<string | null> {
  try {
    const { size } = await stat(filepath)
    if (size <= PARTIAL_HASH_BYTES) {
      const buffer = await readFile(filepath)
      return createHash('sha256').update(buffer).digest('hex')
    }
    const offset = Math.floor(size * 0.4)
    const handle = await open(filepath, 'r')
    try {
      const buffer = Buffer.alloc(PARTIAL_HASH_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, PARTIAL_HASH_BYTES, offset)
      return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

// How far apart two durations may be for a canonical-id match to be trusted
// without asking. Looser than the size+duration rule (a re-encode or a tag
// rewrite shifts padding a little), but tight enough that a remix sharing
// the original's ISRC — common — is not quietly relinked onto it.
export const CANONICAL_DURATION_TOLERANCE_SEC = 2

export interface ReconcileCandidate {
  filepath: string
  filename: string
  client_uuid: string | null
  file_size_bytes: number | null
  duration_sec: number | null
  // From the tags read at import (ISRC / MusicBrainz recording id). A file
  // that was just found has no fingerprint yet, so this is never an fp: id.
  canonical_track_id?: string | null
}

// The candidate for a file just read at import. Its canonical id is built
// from the ISRC / recording id in its tags, by the same rule the identity
// backfill uses for the stored column, so the two compare like for like.
export function reconcileCandidateFor(data: {
  filepath: string
  filename: string
  client_uuid: string | null
  file_size_bytes: number | null
  duration_sec: number | null
  isrc?: string | null
  musicbrainz_recording_id?: string | null
}): ReconcileCandidate {
  return {
    filepath: data.filepath,
    filename: data.filename,
    client_uuid: data.client_uuid,
    file_size_bytes: data.file_size_bytes,
    duration_sec: data.duration_sec,
    canonical_track_id: computeCanonicalTrackId({
      isrc: data.isrc,
      musicbrainz_recording_id: data.musicbrainz_recording_id
    })
  }
}

export type ReconcileOutcome =
  | { kind: 'match'; track: MissingTrackCandidate }
  // Only the canonical-id step produces this: the file is probably one of
  // these tracks, but which one (or whether at all) is the DJ's call.
  | { kind: 'ambiguous'; candidates: MissingTrackCandidate[] }
  | { kind: 'none' }

function canonicalKey(id: string | null | undefined): string | null {
  const trimmed = typeof id === 'string' ? id.trim() : ''
  return trimmed === '' ? null : trimmed
}

// client_uuid first (strong signal, survives a filename/location change) —
// then size + duration, which narrows the missing pool to "plausible"
// candidates but can easily still leave more than one (two rips of the
// same track, a full album where every track shares a runtime, etc).
//
// canonical_track_id comes next, in two places. In a size+duration tie it
// settles it only if exactly one tied row shares the file's id. When
// size+duration found nothing at all (the file was re-encoded, or its tags
// rewritten, which changes its size) it is a fallback over the whole pool:
// exactly one row with that id AND a duration within
// CANONICAL_DURATION_TOLERANCE_SEC is a match; anything else that shares
// the id is 'ambiguous' and goes to the DJ, never guessed at — ISRCs get
// reused on remixes.
//
// Remaining ties are broken by partial_hash, computed lazily right here
// (not for every candidate — only once, for the file actually being
// matched, and only because a tie actually happened). filename is the last
// resort, and only a resort: if the hash still doesn't narrow it to exactly
// one — because the tied rows predate this column and never got a hash
// stored, or because they somehow also hash the same — a matching filename
// among what's left is a reasonable tiebreak, but genuine, unresolved
// ambiguity returns 'none' (a new row) rather than guessing at which
// existing track to overwrite the identity of.
export async function reconcileFile(
  candidate: ReconcileCandidate,
  pool: MissingTrackCandidate[]
): Promise<ReconcileOutcome> {
  if (candidate.client_uuid) {
    const byUuid = pool.find((m) => m.client_uuid === candidate.client_uuid)
    if (byUuid) return { kind: 'match', track: byUuid }
  }

  const canonical = canonicalKey(candidate.canonical_track_id)
  const sharesCanonical = (m: MissingTrackCandidate): boolean =>
    canonical !== null && canonicalKey(m.canonical_track_id) === canonical

  if (candidate.file_size_bytes != null && candidate.duration_sec != null) {
    const bySizeAndDuration = pool.filter(
      (m) =>
        m.file_size_bytes === candidate.file_size_bytes &&
        m.duration_sec != null &&
        Math.abs(m.duration_sec - (candidate.duration_sec as number)) <=
          FINGERPRINT_DURATION_TOLERANCE_SEC
    )
    if (bySizeAndDuration.length === 1) return { kind: 'match', track: bySizeAndDuration[0] }

    if (bySizeAndDuration.length > 1) {
      // A tie the canonical id can settle without reading the file.
      const tiedByCanonical = bySizeAndDuration.filter(sharesCanonical)
      if (tiedByCanonical.length === 1) return { kind: 'match', track: tiedByCanonical[0] }

      // A real tie — worth the read.
      const candidateHash = await computePartialHash(candidate.filepath)
      const byHash = candidateHash
        ? bySizeAndDuration.filter((m) => m.partial_hash === candidateHash)
        : []
      if (byHash.length === 1) return { kind: 'match', track: byHash[0] }

      const stillTied = byHash.length > 1 ? byHash : bySizeAndDuration
      const byFilename = stillTied.filter((m) => m.filename === candidate.filename)
      return byFilename.length === 1 ? { kind: 'match', track: byFilename[0] } : { kind: 'none' }
    }
  }

  // Nothing (or nothing measurable) by size+duration: the canonical fallback.
  if (canonical === null) return { kind: 'none' }
  const byCanonical = pool.filter(sharesCanonical)
  if (byCanonical.length === 0) return { kind: 'none' }
  if (byCanonical.length === 1) {
    const only = byCanonical[0]
    const durationAgrees =
      candidate.duration_sec != null &&
      only.duration_sec != null &&
      Math.abs(only.duration_sec - candidate.duration_sec) <= CANONICAL_DURATION_TOLERANCE_SEC
    if (durationAgrees) return { kind: 'match', track: only }
  }
  return { kind: 'ambiguous', candidates: byCanonical }
}

// The match-or-nothing view of reconcileFile, for callers with no way to
// ask the DJ (the Serato importer only identifies rows, never relinks).
// An ambiguous outcome is "no match" here, exactly as before canonical ids.
export async function findReconcileMatch(
  candidate: ReconcileCandidate,
  pool: MissingTrackCandidate[]
): Promise<MissingTrackCandidate | null> {
  const outcome = await reconcileFile(candidate, pool)
  return outcome.kind === 'match' ? outcome.track : null
}
