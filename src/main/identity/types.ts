// Pure types for the identity backfill and lookup. Persistence, the clock,
// the network and the child processes are all injected so the logic in
// engine.ts and lookup.ts runs in plain Node under tests/unit.

export type FingerprintStatus = 'done' | 'failed'

export interface TrackRef {
  id: number
  filepath: string
}

export interface LookupCandidate {
  id: number
  fingerprint: string
  fingerprint_duration: number
  fingerprint_hash: string
}

export type LookupStatus = 'match' | 'none' | 'ambiguous'

export interface LookupCacheEntry {
  fingerprint_hash: string
  recording_id: string | null
  status: LookupStatus
  looked_up_at: number // epoch ms
}

export interface IdentityProgress {
  total: number // tracks present on disk
  tagsPending: number
  fingerprintPending: number
  lookupPending: number
}

export interface IdentityStore {
  tracksNeedingTags(limit: number): TrackRef[]
  setIdentityTags(trackId: number, isrc: string | null, recordingId: string | null): void

  tracksNeedingFingerprint(limit: number): TrackRef[]
  setFingerprint(trackId: number, fingerprint: string, durationSec: number): void
  setFingerprintStatus(trackId: number, status: FingerprintStatus): void

  // Tracks with a fingerprint and no ISRC / recording id yet, skipping any
  // whose cached negative result is newer than `negativeCutoffMs`.
  tracksNeedingLookup(limit: number, negativeCutoffMs: number): LookupCandidate[]
  setRecordingId(trackId: number, recordingId: string): void
  getCache(fingerprintHash: string): LookupCacheEntry | null
  putCache(entry: LookupCacheEntry): void

  progress(): IdentityProgress
  getCanonicalTrackId(trackId: number): string | null
}
