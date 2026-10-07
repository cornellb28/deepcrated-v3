// ── Anonymous stats: shared types ─────────────────────────────────────────
// Everything under src/main/stats/ except sqliteStore.ts and index.ts is pure:
// no electron, no better-sqlite3, no fetch. Persistence, the clock and the
// network are all injected, which is what lets tests/unit exercise the
// consent rules and the uploader in plain Node.

export type ConsentAction = 'granted' | 'withdrawn' | 'expired'

export interface ConsentEvent {
  action: ConsentAction
  textVersion: number
  // epoch ms
  at: number
}

export interface QueuedStat {
  id: number
  anon_install_id: string
  event_type: string
  payload: string // JSON, already validated
  app_version: string
  created_at: string // ISO, hour-aligned
  attempts: number
}

export interface NewQueuedStat {
  anon_install_id: string
  event_type: string
  payload: string
  app_version: string
  created_at: string
  // Local-only. Never uploaded; they exist so that marking a track or crate
  // private can purge what is already queued for it.
  track_id: number | null
  crate_id: number | null
}

export interface StatsStore {
  transaction<T>(fn: () => T): T

  // consent audit log (append-only; the newest row is the current state)
  latestConsentEvent(): ConsentEvent | null
  appendConsentEvent(event: ConsentEvent): void

  // anonymous install id — device-local, never exposed over IPC
  getInstallId(): string | null
  setInstallId(id: string): void
  clearInstallId(): void

  // The track's shareable id, or null if it has none yet.
  getCanonicalTrackId(trackId: number): string | null

  // privacy flags. An unknown id reads as private: fail closed.
  isTrackPrivate(trackId: number): boolean
  isCratePrivate(crateId: number): boolean // the crate or any ancestor
  isTrackInPrivateCrate(trackId: number): boolean
  setTracksPrivate(trackIds: number[], value: boolean): void
  setCratePrivate(crateId: number, value: boolean): void

  // queue
  queueInsert(row: NewQueuedStat): void
  queueCount(): number
  queueTrimToCap(cap: number): void
  queueDeleteOlderThan(isoCutoff: string): void
  queueDue(nowMs: number, limit: number): QueuedStat[]
  queueDelete(ids: number[]): void
  queueMarkFailed(ids: number[], nextAttemptMs: number): void
  queuePurgeAll(): void
  queuePurgePrivate(): void

  getLastUploadAt(): number | null
  setLastUploadAt(ms: number): void
}
