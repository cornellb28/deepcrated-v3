// ── Anonymous stats: the app-facing surface ───────────────────────────────
// Wires the pure modules to the real database. All stats code elsewhere in
// the app goes through canCollect / enqueueStat from here. This file has no
// network or env dependency (see runtime.ts for the uploader), so the
// integration probe can load it.

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { getStatsStore } from '../db'
import { createConsent } from './consent'
import { createStatsQueue } from './queue'

const store = getStatsStore()

export const consent = createConsent(store, { now: () => Date.now(), uuid: randomUUID })
export const statsQueue = createStatsQueue(store, consent, {
  now: () => Date.now(),
  appVersion: app.getVersion()
})
export { store as statsStore }

// The gate. Every future piece of stats code asks this first.
export const canCollect = consent.canCollect
export const enqueueStat = statsQueue.enqueueStat

// Thin JSON-friendly wrappers, used by the IPC handlers and the probe.
export const statsGetConsent = (): ReturnType<typeof consent.getState> => consent.getState()
export const statsSetConsent = (enabled: boolean): ReturnType<typeof consent.setConsent> =>
  consent.setConsent(enabled)
export const statsSetTracksPrivate = (ids: number[], value: boolean): void =>
  consent.setTracksPrivate(ids, value)
export const statsSetCratePrivate = (id: number, value: boolean): void =>
  consent.setCratePrivate(id, value)
export const statsQueueCount = (): number => store.queueCount()
export const statsInstallId = (): string | null => store.getInstallId()
// Test-only read of what is queued, so the probe can assert on payloads.
export const statsQueuedPayloads = (): string[] =>
  store.queueDue(Number.MAX_SAFE_INTEGER, 10_000).map((r) => r.payload)
