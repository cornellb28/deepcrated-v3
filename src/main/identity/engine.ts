// ── Track identity: the backfill engine ───────────────────────────────────
// Brings every track up to date, in three phases that each pick up whatever
// is still pending, so the engine is resumable by construction (state lives
// in the database, not here):
//
//   1. tags         read ISRC / MusicBrainz recording id from the file tags
//   2. fingerprint  Chromaprint, only for tracks that have neither id
//   3. lookup       optional: fingerprint -> recording id (setting, online)
//
// Pure: persistence, the sidecar, fpcalc, the network and the clock are all
// injected, so this runs in plain Node under tests/unit.

import { NEGATIVE_CACHE_MS, TransientLookupError, type Lookup } from './lookup'
import type { IdentityProgress, IdentityStore, TrackRef } from './types'

export interface IdentityTagResult {
  filepath: string
  ok: boolean
  isrc: string | null
  musicbrainz_recording_id: string | null
}

export interface EngineDeps {
  store: IdentityStore
  now: () => number
  // Reads ISRC / recording id tags for a batch of paths.
  readTags: (filepaths: string[]) => Promise<IdentityTagResult[]>
  // null when fpcalc is not installed; the fingerprint phase is skipped.
  fingerprint: ((filepath: string) => Promise<{ fingerprint: string; duration: number }>) | null
  // null when lookup is not configured. Checked every run, so flipping the
  // setting takes effect at the next batch.
  lookup: Lookup | null
  lookupEnabled: () => boolean
  isOnline: () => boolean
  // True while something else (an import) should have the machine to itself.
  shouldPause: () => boolean
  onProgress?: (p: EngineProgress) => void
}

export type EnginePhase = 'tags' | 'fingerprint' | 'lookup' | 'idle'

export interface EngineProgress {
  phase: EnginePhase
  progress: IdentityProgress
}

export interface RunResult {
  tagsRead: number
  fingerprinted: number
  resolved: number
  paused: boolean
}

const TAG_BATCH = 200
const FP_BATCH = 20
const LOOKUP_BATCH = 20

export function createEngine(deps: EngineDeps): {
  run(signal?: { aborted: boolean }): Promise<RunResult>
} {
  const { store } = deps

  function report(phase: EnginePhase): void {
    deps.onProgress?.({ phase, progress: store.progress() })
  }

  return {
    async run(signal = { aborted: false }): Promise<RunResult> {
      const result: RunResult = { tagsRead: 0, fingerprinted: 0, resolved: 0, paused: false }
      const stop = (): boolean => {
        if (signal.aborted || deps.shouldPause()) {
          result.paused = true
          return true
        }
        return false
      }

      // 1. tags
      for (;;) {
        if (stop()) return result
        const batch: TrackRef[] = store.tracksNeedingTags(TAG_BATCH)
        if (batch.length === 0) break
        const read = await deps.readTags(batch.map((t) => t.filepath))
        const byPath = new Map(read.map((r) => [r.filepath, r]))
        for (const track of batch) {
          const r = byPath.get(track.filepath)
          // Marked read even when the file could not be (missing, unreadable):
          // otherwise it would head the list forever. A later rescan reads it
          // properly when the file is back.
          store.setIdentityTags(track.id, r?.isrc ?? null, r?.musicbrainz_recording_id ?? null)
          result.tagsRead++
        }
        report('tags')
      }

      // 2. fingerprint
      if (deps.fingerprint) {
        for (;;) {
          if (stop()) return result
          const batch = store.tracksNeedingFingerprint(FP_BATCH)
          if (batch.length === 0) break
          for (const track of batch) {
            if (stop()) return result
            try {
              const fp = await deps.fingerprint(track.filepath)
              if (!fp.fingerprint) throw new Error('empty fingerprint')
              store.setFingerprint(track.id, fp.fingerprint, fp.duration)
              result.fingerprinted++
            } catch {
              store.setFingerprintStatus(track.id, 'failed')
            }
          }
          report('fingerprint')
        }
      }

      // 3. lookup
      if (deps.lookup && deps.lookupEnabled() && deps.isOnline()) {
        for (;;) {
          if (stop() || !deps.lookupEnabled() || !deps.isOnline()) return result
          const batch = store.tracksNeedingLookup(LOOKUP_BATCH, deps.now() - NEGATIVE_CACHE_MS)
          if (batch.length === 0) break
          for (const c of batch) {
            if (stop() || !deps.lookupEnabled() || !deps.isOnline()) return result

            const cached = store.getCache(c.fingerprint_hash)
            if (cached && cached.status === 'match' && cached.recording_id) {
              store.setRecordingId(c.id, cached.recording_id)
              result.resolved++
              continue
            }

            try {
              const found = await deps.lookup.resolve(c)
              store.putCache({
                fingerprint_hash: c.fingerprint_hash,
                recording_id: found.recordingId,
                status: found.status,
                looked_up_at: deps.now()
              })
              if (found.status === 'match' && found.recordingId) {
                store.setRecordingId(c.id, found.recordingId)
                result.resolved++
              }
            } catch (err) {
              // Offline or throttled: leave everything as it is and try again
              // next run, rather than caching a "no match" that isn't true.
              if (err instanceof TransientLookupError) return result
              throw err
            }
          }
          report('lookup')
        }
      }

      report('idle')
      return result
    }
  }
}
