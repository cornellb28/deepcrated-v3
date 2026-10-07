import {
  computeCanonicalTrackId,
  fingerprintHash,
  normalizeIsrc,
  normalizeMbid
} from '../../src/main/identity/canonical'
import type {
  FingerprintStatus,
  IdentityProgress,
  IdentityStore,
  LookupCacheEntry,
  LookupCandidate,
  TrackRef
} from '../../src/main/identity/types'

interface Row {
  id: number
  filepath: string
  missing: boolean
  tagsRead: boolean
  isrc: string | null
  mbid: string | null
  fp: string | null
  fpDuration: number | null
  fpHash: string | null
  fpStatus: FingerprintStatus | null
}

// In-memory IdentityStore with the same selection rules as the SQLite one.
export class FakeIdentityStore implements IdentityStore {
  rows: Row[] = []
  cache = new Map<string, LookupCacheEntry>()

  add(filepath: string, init: Partial<Row> = {}): number {
    const id = this.rows.length + 1
    this.rows.push({
      id,
      filepath,
      missing: false,
      tagsRead: false,
      isrc: null,
      mbid: null,
      fp: null,
      fpDuration: null,
      fpHash: null,
      fpStatus: null,
      ...init
    })
    return id
  }

  row(id: number): Row {
    return this.rows.find((r) => r.id === id) as Row
  }

  tracksNeedingTags(limit: number): TrackRef[] {
    return this.rows
      .filter((r) => !r.tagsRead && !r.missing)
      .slice(0, limit)
      .map((r) => ({ id: r.id, filepath: r.filepath }))
  }

  setIdentityTags(id: number, isrc: string | null, mbid: string | null): void {
    const r = this.row(id)
    r.isrc = normalizeIsrc(isrc) ?? r.isrc
    r.mbid = normalizeMbid(mbid) ?? r.mbid
    r.tagsRead = true
  }

  tracksNeedingFingerprint(limit: number): TrackRef[] {
    return this.rows
      .filter((r) => r.tagsRead && !r.missing && !r.isrc && !r.mbid && r.fpStatus === null)
      .slice(0, limit)
      .map((r) => ({ id: r.id, filepath: r.filepath }))
  }

  setFingerprint(id: number, fingerprint: string, durationSec: number): void {
    const r = this.row(id)
    const hash = fingerprintHash(fingerprint)
    if (!hash) {
      r.fpStatus = 'failed'
      return
    }
    r.fp = fingerprint
    r.fpDuration = Math.round(durationSec)
    r.fpHash = hash
    r.fpStatus = 'done'
  }

  setFingerprintStatus(id: number, status: FingerprintStatus): void {
    this.row(id).fpStatus = status
  }

  tracksNeedingLookup(limit: number, negativeCutoffMs: number): LookupCandidate[] {
    return this.rows
      .filter((r) => {
        if (!r.fpHash || r.isrc || r.mbid || r.missing) return false
        const c = this.cache.get(r.fpHash)
        return !c || c.status === 'match' || c.looked_up_at < negativeCutoffMs
      })
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        fingerprint: r.fp as string,
        fingerprint_duration: r.fpDuration as number,
        fingerprint_hash: r.fpHash as string
      }))
  }

  setRecordingId(id: number, recordingId: string): void {
    const r = this.row(id)
    const mbid = normalizeMbid(recordingId)
    if (mbid && !r.mbid) r.mbid = mbid
  }

  getCache(hash: string): LookupCacheEntry | null {
    return this.cache.get(hash) ?? null
  }

  putCache(entry: LookupCacheEntry): void {
    this.cache.set(entry.fingerprint_hash, entry)
  }

  progress(): IdentityProgress {
    const present = this.rows.filter((r) => !r.missing)
    return {
      total: present.length,
      tagsPending: present.filter((r) => !r.tagsRead).length,
      fingerprintPending: present.filter(
        (r) => r.tagsRead && !r.isrc && !r.mbid && r.fpStatus === null
      ).length,
      lookupPending: present.filter((r) => r.fpHash && !r.isrc && !r.mbid).length
    }
  }

  getCanonicalTrackId(id: number): string | null {
    const r = this.row(id)
    return computeCanonicalTrackId({
      isrc: r.isrc,
      musicbrainz_recording_id: r.mbid,
      fingerprint_hash: r.fpHash
    })
  }
}
