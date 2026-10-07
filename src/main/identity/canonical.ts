// ── Track identity: normalizers and the canonical ID ──────────────────────
// canonical_track_id is the one track identifier that may leave the device
// (in anonymous stats). It is built only from public recording identifiers,
// never from a path, filename or local id, and is prefixed so the three
// namespaces cannot collide:
//
//   isrc:USRC17607839            from the file's ISRC tag
//   mbid:<recording uuid>        a MusicBrainz recording id (tag or lookup)
//   fp:<40 hex>                  a hash of the Chromaprint fingerprint
//
// Priority is ISRC, then MusicBrainz recording id, then fingerprint hash.
//
// Caveats worth knowing, because they limit what cross-DJ aggregation can
// claim: an ISRC is not a perfect key (tags are often blank or wrong, and
// some remixes reuse the original's), and a fingerprint hash only matches
// near-identical audio — the same song encoded differently fingerprints
// differently. `mbid:` is the strongest cross-DJ key; `fp:` is the weakest
// and the prefix lets the receiving side treat it that way.

import { createHash } from 'crypto'

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FP_HASH_PATTERN = /^[0-9a-f]{40}$/

// Every shape computeCanonicalTrackId can return. The stats allowlist uses
// this to validate the field, so a path cannot fit it.
export const CANONICAL_ID_PATTERN =
  /^(?:isrc:[A-Z]{2}[A-Z0-9]{3}\d{7}|mbid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|fp:[0-9a-f]{40})$/

// Tags may hold several values joined by '/', ';', ',', whitespace or NUL,
// and ISRCs are often written with hyphens (US-RC1-76-07839). Returns the
// first value that is a valid ISRC once normalized, else null.
export function normalizeIsrc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  for (const part of raw.split(/[\s,;/\0]+/)) {
    const candidate = part.replace(/-/g, '').toUpperCase()
    if (ISRC_PATTERN.test(candidate)) return candidate
  }
  return null
}

export function normalizeMbid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const candidate = raw.trim().toLowerCase()
  return MBID_PATTERN.test(candidate) ? candidate : null
}

// A stable 40-hex digest of the fingerprint string. The raw fingerprint is
// kept locally (the AcoustID lookup needs it); only this hash can ever
// become part of an id.
export function fingerprintHash(fingerprint: unknown): string | null {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 40)
}

export interface IdentityInputs {
  isrc?: string | null
  musicbrainz_recording_id?: string | null
  fingerprint_hash?: string | null
}

// Inputs are re-validated here rather than trusted: whatever a tag or an API
// returned must pass the same pattern before it can become an id.
export function computeCanonicalTrackId(inputs: IdentityInputs): string | null {
  const isrc = normalizeIsrc(inputs.isrc)
  if (isrc) return `isrc:${isrc}`
  const mbid = normalizeMbid(inputs.musicbrainz_recording_id)
  if (mbid) return `mbid:${mbid}`
  const fp = inputs.fingerprint_hash
  if (typeof fp === 'string' && FP_HASH_PATTERN.test(fp)) return `fp:${fp}`
  return null
}
