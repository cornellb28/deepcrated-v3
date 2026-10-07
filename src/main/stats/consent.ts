// ── Anonymous stats: consent and the one gate ─────────────────────────────
// canCollect is the single question every piece of stats code must ask
// before it records or sends anything. It fails closed: any doubt, error or
// unknown id answers false.
//
// Consent is an append-only log (granted / withdrawn / expired, each with a
// timestamp and the version of the consent text shown). The newest row is
// the current state, so there is no second flag that can drift out of sync.

import type { ConsentAction, StatsStore } from './types'

// Bump when the wording of the Settings line or the privacy page changes in a
// way that matters. Consent given under an older version stops counting until
// the user confirms again (see reconcile).
export const CONSENT_TEXT_VERSION = 1

// Settings keys under this prefix belong to the stats system. The generic
// settings:get/set/delete IPC refuses them, so the renderer can neither flip
// consent around the audit log nor read the install id.
export const RESERVED_SETTING_PREFIX = 'stats_'

export function isReservedSettingKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(RESERVED_SETTING_PREFIX)
}

export interface ConsentState {
  enabled: boolean
  // The version the user consented under; null if never.
  textVersion: number | null
  changedAt: number | null
  currentTextVersion: number
}

export interface ConsentDeps {
  now: () => number
  uuid: () => string
}

export interface ConsentService {
  getState(): ConsentState
  isConsentActive(): boolean
  canCollect(trackId?: number | null, crateId?: number | null): boolean
  setConsent(enabled: boolean): ConsentState
  setTracksPrivate(trackIds: number[], value: boolean): void
  setCratePrivate(crateId: number, value: boolean): void
  reconcile(): void
}

export function createConsent(store: StatsStore, deps: ConsentDeps): ConsentService {
  function active(): boolean {
    const latest = store.latestConsentEvent()
    return (
      latest !== null && latest.action === 'granted' && latest.textVersion === CONSENT_TEXT_VERSION
    )
  }

  function record(action: ConsentAction): void {
    store.appendConsentEvent({ action, textVersion: CONSENT_TEXT_VERSION, at: deps.now() })
  }

  // Withdrawal and expiry are the same act as far as data goes: nothing queued
  // survives and the install id is forgotten, so a later opt-in starts fresh.
  function stopCollecting(action: 'withdrawn' | 'expired'): void {
    record(action)
    store.queuePurgeAll()
    store.clearInstallId()
  }

  const service: ConsentService = {
    getState(): ConsentState {
      const latest = store.latestConsentEvent()
      return {
        enabled: active(),
        textVersion: latest && latest.action === 'granted' ? latest.textVersion : null,
        changedAt: latest?.at ?? null,
        currentTextVersion: CONSENT_TEXT_VERSION
      }
    },

    isConsentActive: active,

    canCollect(trackId = null, crateId = null): boolean {
      try {
        if (!active()) return false
        if (trackId !== null) {
          if (!Number.isInteger(trackId)) return false
          if (store.isTrackPrivate(trackId)) return false
          // A track in any private crate is private, whichever crate it is
          // being viewed or played from.
          if (store.isTrackInPrivateCrate(trackId)) return false
        }
        if (crateId !== null) {
          if (!Number.isInteger(crateId)) return false
          if (store.isCratePrivate(crateId)) return false
        }
        return true
      } catch {
        return false
      }
    },

    setConsent(enabled: boolean): ConsentState {
      store.transaction(() => {
        const wasActive = active()
        if (enabled) {
          if (!wasActive) {
            record('granted')
            // A fresh id for every opt-in. If a stale one somehow survived,
            // replace it rather than reuse it.
            store.setInstallId(deps.uuid())
          }
        } else if (wasActive || store.latestConsentEvent()?.action === 'granted') {
          stopCollecting('withdrawn')
        } else {
          // Already off: still make sure nothing is left behind.
          store.queuePurgeAll()
          store.clearInstallId()
        }
      })
      return service.getState()
    },

    setTracksPrivate(trackIds: number[], value: boolean): void {
      store.transaction(() => {
        store.setTracksPrivate(trackIds, value)
        if (value) store.queuePurgePrivate()
      })
    },

    setCratePrivate(crateId: number, value: boolean): void {
      store.transaction(() => {
        store.setCratePrivate(crateId, value)
        if (value) store.queuePurgePrivate()
      })
    },

    // Run at startup. Consent given under an older text version no longer
    // counts, so record that and clear what it allowed.
    reconcile(): void {
      const latest = store.latestConsentEvent()
      if (latest && latest.action === 'granted' && latest.textVersion !== CONSENT_TEXT_VERSION) {
        store.transaction(() => stopCollecting('expired'))
      }
    }
  }
  return service
}
