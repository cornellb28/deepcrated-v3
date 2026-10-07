// ── Anonymous stats: the queue ────────────────────────────────────────────
// enqueueStat is the only way an event enters the queue. In order it checks
// consent and privacy (canCollect), validates against the allowlist, floors
// the timestamp to the hour, and enforces the size cap. Anything that fails
// is dropped silently: stats are best-effort and must never surface an error
// to the feature that raised them.

import type { ConsentService } from './consent'
import {
  CANONICAL_ID_FIELD,
  EVENT_SPECS,
  hourFloorIso,
  isValidAppVersion,
  validateEvent
} from './schema'
import type { StatsStore } from './types'

export const MAX_QUEUE_SIZE = 5000
export const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface EnqueueContext {
  trackId?: number | null
  crateId?: number | null
}

export interface QueueDeps {
  now: () => number
  appVersion: string
}

export interface StatsQueue {
  enqueueStat(eventType: string, payload: unknown, ctx?: EnqueueContext): boolean
}

export function createStatsQueue(
  store: StatsStore,
  consent: ConsentService,
  deps: QueueDeps
): StatsQueue {
  return {
    enqueueStat(eventType, payload, ctx = {}): boolean {
      try {
        const trackId = ctx.trackId ?? null
        const crateId = ctx.crateId ?? null

        if (!consent.canCollect(trackId, crateId)) return false

        // A track-scoped event is stamped with the track's canonical id here,
        // from the database, replacing anything the caller put in the payload.
        // No id yet (not read, not fingerprinted) means no event: a local id
        // or path is never a substitute.
        let withIdentity = payload
        if (
          typeof eventType === 'string' &&
          Object.prototype.hasOwnProperty.call(EVENT_SPECS, eventType) &&
          EVENT_SPECS[eventType as keyof typeof EVENT_SPECS].scope === 'track' &&
          typeof payload === 'object' &&
          payload !== null &&
          !Array.isArray(payload)
        ) {
          if (trackId === null) return false
          const canonical = store.getCanonicalTrackId(trackId)
          if (!canonical) return false
          withIdentity = { ...payload, [CANONICAL_ID_FIELD]: canonical }
        }

        const checked = validateEvent(eventType, withIdentity)
        if (!checked.ok) return false

        if (!isValidAppVersion(deps.appVersion)) return false

        const installId = store.getInstallId()
        if (!installId) return false

        store.transaction(() => {
          store.queueInsert({
            anon_install_id: installId,
            event_type: checked.eventType,
            payload: JSON.stringify(checked.payload),
            app_version: deps.appVersion,
            created_at: hourFloorIso(deps.now()),
            track_id: trackId,
            crate_id: crateId
          })
          store.queueDeleteOlderThan(new Date(deps.now() - MAX_EVENT_AGE_MS).toISOString())
          store.queueTrimToCap(MAX_QUEUE_SIZE)
        })
        return true
      } catch {
        return false
      }
    }
  }
}
