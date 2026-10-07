import type {
  ConsentEvent,
  NewQueuedStat,
  QueuedStat,
  StatsStore
} from '../../src/main/stats/types'

// In-memory StatsStore with the same semantics as the SQLite one: an unknown
// track or crate reads as private, crate privacy is inherited from ancestors,
// and a private crate covers the tracks in it.
export class FakeStatsStore implements StatsStore {
  consent: ConsentEvent[] = []
  installId: string | null = null
  lastUpload: number | null = null
  tracks = new Map<number, { private: boolean; canonical: string | null }>()
  crates = new Map<number, { parent: number | null; private: boolean }>()
  membership: { crate: number; track: number }[] = []
  rows: (QueuedStat & {
    next_attempt_at: number
    track_id: number | null
    crate_id: number | null
  })[] = []
  private nextId = 1
  throwOnRead = false

  // Every fake track gets a valid ISRC-based canonical id unless told otherwise.
  addTrack(
    id: number,
    isPrivate = false,
    canonical: string | null = `isrc:USRC176078${String(id).padStart(2, '0')}`
  ): this {
    this.tracks.set(id, { private: isPrivate, canonical })
    return this
  }
  getCanonicalTrackId(trackId: number): string | null {
    return this.tracks.get(trackId)?.canonical ?? null
  }
  addCrate(id: number, parent: number | null = null, isPrivate = false): this {
    this.crates.set(id, { parent, private: isPrivate })
    return this
  }
  put(crate: number, track: number): this {
    this.membership.push({ crate, track })
    return this
  }

  transaction<T>(fn: () => T): T {
    return fn()
  }
  latestConsentEvent(): ConsentEvent | null {
    if (this.throwOnRead) throw new Error('db unavailable')
    return this.consent[this.consent.length - 1] ?? null
  }
  appendConsentEvent(event: ConsentEvent): void {
    this.consent.push(event)
  }
  getInstallId(): string | null {
    return this.installId
  }
  setInstallId(id: string): void {
    this.installId = id
  }
  clearInstallId(): void {
    this.installId = null
  }

  isTrackPrivate(id: number): boolean {
    const t = this.tracks.get(id)
    return t === undefined || t.private
  }
  private crateChainPrivate(id: number): boolean {
    let cur: number | null = id
    const seen = new Set<number>()
    while (cur !== null) {
      const c = this.crates.get(cur)
      if (!c || seen.has(cur)) return true
      if (c.private) return true
      seen.add(cur)
      cur = c.parent
    }
    return false
  }
  isCratePrivate(id: number): boolean {
    return this.crateChainPrivate(id)
  }
  isTrackInPrivateCrate(trackId: number): boolean {
    return this.membership.some((m) => m.track === trackId && this.crateChainPrivate(m.crate))
  }
  setTracksPrivate(ids: number[], value: boolean): void {
    for (const id of ids) {
      const t = this.tracks.get(id)
      if (t) t.private = value
    }
  }
  setCratePrivate(id: number, value: boolean): void {
    const c = this.crates.get(id)
    if (c) c.private = value
  }

  queueInsert(row: NewQueuedStat): void {
    this.rows.push({ ...row, id: this.nextId++, attempts: 0, next_attempt_at: 0 })
  }
  queueCount(): number {
    return this.rows.length
  }
  queueTrimToCap(cap: number): void {
    if (this.rows.length <= cap) return
    const keep = [...this.rows]
      .sort((a, b) =>
        a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1
      )
      .slice(0, cap)
      .map((r) => r.id)
    this.rows = this.rows.filter((r) => keep.includes(r.id))
  }
  queueDeleteOlderThan(iso: string): void {
    this.rows = this.rows.filter((r) => r.created_at >= iso)
  }
  queueDue(nowMs: number, limit: number): QueuedStat[] {
    return this.rows
      .filter((r) => r.next_attempt_at <= nowMs)
      .sort((a, b) =>
        a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1
      )
      .slice(0, limit)
  }
  queueDelete(ids: number[]): void {
    this.rows = this.rows.filter((r) => !ids.includes(r.id))
  }
  queueMarkFailed(ids: number[], nextAttemptMs: number): void {
    for (const r of this.rows) {
      if (ids.includes(r.id)) {
        r.attempts += 1
        r.next_attempt_at = nextAttemptMs
      }
    }
  }
  queuePurgeAll(): void {
    this.rows = []
  }
  queuePurgePrivate(): void {
    this.rows = this.rows.filter((r) => {
      if (
        r.track_id !== null &&
        (this.isTrackPrivate(r.track_id) || this.isTrackInPrivateCrate(r.track_id))
      )
        return false
      if (r.crate_id !== null && this.isCratePrivate(r.crate_id)) return false
      return true
    })
  }
  getLastUploadAt(): number | null {
    return this.lastUpload
  }
  setLastUploadAt(ms: number): void {
    this.lastUpload = ms
  }
}
