import { createHash } from 'crypto'
import { readFile, stat, open } from 'fs/promises'
import type { MissingTrackCandidate } from './db'

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

// client_uuid first (strong signal, survives a filename/location change) —
// then size + duration, which narrows the missing pool to "plausible"
// candidates but can easily still leave more than one (two rips of the
// same track, a full album where every track shares a runtime, etc). Ties
// are broken by partial_hash, computed lazily right here (not for every
// candidate — only once, for the file actually being matched, and only
// because a tie actually happened). filename is the last resort, and only
// a resort: if the hash still doesn't narrow it to exactly one — because
// the tied rows predate this column and never got a hash stored, or
// because they somehow also hash the same — a matching filename among
// what's left is a reasonable tiebreak, but genuine, unresolved ambiguity
// returns null (a new row) rather than guessing at which existing track to
// overwrite the identity of.
export async function findReconcileMatch(
  candidate: {
    filepath: string
    filename: string
    client_uuid: string | null
    file_size_bytes: number | null
    duration_sec: number | null
  },
  pool: MissingTrackCandidate[]
): Promise<MissingTrackCandidate | null> {
  if (candidate.client_uuid) {
    const byUuid = pool.find((m) => m.client_uuid === candidate.client_uuid)
    if (byUuid) return byUuid
  }

  if (candidate.file_size_bytes == null || candidate.duration_sec == null) return null

  const bySizeAndDuration = pool.filter(
    (m) =>
      m.file_size_bytes === candidate.file_size_bytes &&
      m.duration_sec != null &&
      Math.abs(m.duration_sec - (candidate.duration_sec as number)) <=
        FINGERPRINT_DURATION_TOLERANCE_SEC
  )
  if (bySizeAndDuration.length === 0) return null
  if (bySizeAndDuration.length === 1) return bySizeAndDuration[0]

  // A real tie — worth the read.
  const candidateHash = await computePartialHash(candidate.filepath)
  const byHash = candidateHash
    ? bySizeAndDuration.filter((m) => m.partial_hash === candidateHash)
    : []
  if (byHash.length === 1) return byHash[0]

  const stillTied = byHash.length > 1 ? byHash : bySizeAndDuration
  const byFilename = stillTied.filter((m) => m.filename === candidate.filename)
  return byFilename.length === 1 ? byFilename[0] : null
}
