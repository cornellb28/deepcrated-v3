import { joinValues, splitValue } from '../../src/main/tagFields'
import type { ArtistTagEntry, LibrarySpelling } from '../../src/main/artist/clean'
import type {
  ArtistStore,
  ArtistTrack,
  JournalEntry,
  NewSuggestion,
  ReclaimTrack,
  SuggestionGroup,
  SuggestionRow,
  SuggestionStatus
} from '../../src/main/artist/types'

interface TrackRow {
  id: number
  filepath: string
  artist: string | null
  artist_raw: string | null
  missing: boolean
  tags: string[] // artist tag values, in order
}

// In-memory ArtistStore with the same rules as the SQLite one: tags are the
// source of truth, tracks.artist is re-derived from them, and the pool leaves
// out a tag that exists only as a pending suggestion's raw name.
export class FakeArtistStore implements ArtistStore {
  tracks = new Map<number, TrackRow>()
  // tags that exist with no track (orphans left behind, or seeded)
  looseTags = new Set<string>()
  keep = new Set<string>()
  suggestions: (SuggestionRow & { status: SuggestionStatus })[] = []
  journal: JournalEntry[] = []
  settings = new Map<string, string>()
  private nextSuggestionId = 1

  addTrack(id: number, artist: string | null, init: Partial<TrackRow> = {}): this {
    this.tracks.set(id, {
      id,
      filepath: `/music/${id}.mp3`,
      artist,
      artist_raw: null,
      missing: false,
      tags: [],
      ...init
    })
    return this
  }

  // A track that already carries these artist tags (as the DJ's own do).
  tag(id: number, ...values: string[]): this {
    const t = this.tracks.get(id) as TrackRow
    t.tags = values
    t.artist = joinValues(values)
    return this
  }

  row(id: number): TrackRow {
    return this.tracks.get(id) as TrackRow
  }

  allTagValues(): Set<string> {
    const all = new Set<string>(this.looseTags)
    for (const t of this.tracks.values()) for (const v of t.tags) all.add(v)
    return all
  }

  transaction<T>(fn: () => T): T {
    return fn()
  }

  getTrack(id: number): ArtistTrack | null {
    const t = this.tracks.get(id)
    return t ? { id: t.id, filepath: t.filepath, artist: t.artist, artist_raw: t.artist_raw } : null
  }
  setArtistRawIfNull(id: number, raw: string): void {
    const t = this.row(id)
    if (t.artist_raw === null) t.artist_raw = raw
  }
  getArtistTagValues(id: number): string[] {
    return [...this.row(id).tags]
  }
  setArtistTags(id: number, values: string[]): string | null {
    const t = this.row(id)
    t.tags = values.map((v) => v.trim()).filter((v) => v !== '')
    t.artist = joinValues(t.tags)
    return t.artist
  }
  setTrackArtistColumn(id: number, value: string | null): void {
    this.row(id).artist = value
  }

  artistTagPool(): ArtistTagEntry[] {
    const pendingRaws = new Set(
      this.suggestions.filter((s) => s.status === 'pending').map((s) => s.raw)
    )
    const counts = new Map<string, number>()
    for (const v of this.looseTags) counts.set(v, 0)
    for (const t of this.tracks.values())
      for (const v of t.tags) counts.set(v, (counts.get(v) ?? 0) + 1)
    return [...counts]
      .filter(([value]) => !pendingRaws.has(value))
      .map(([value, trackCount]) => ({ value, trackCount }))
  }
  librarySpellings(): LibrarySpelling[] {
    const counts = new Map<string, number>()
    for (const t of this.tracks.values()) {
      if (t.missing) continue
      for (const p of splitValue('artist', t.artist)) counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    return [...counts].map(([raw, count]) => ({ raw, count }))
  }
  liveTracksWithArtist(): ReclaimTrack[] {
    return [...this.tracks.values()]
      .filter((t) => !t.missing && (t.artist ?? '').trim() !== '')
      .map((t) => ({
        id: t.id,
        filepath: t.filepath,
        artistColumn: t.artist,
        tagValues: [...t.tags]
      }))
  }

  keepRules(): string[] {
    return [...this.keep]
  }
  addKeepRule(raw: string): void {
    this.keep.add(raw)
  }

  insertSuggestion(row: NewSuggestion): void {
    if (this.suggestions.some((s) => s.track_id === row.track_id && s.raw === row.raw)) return
    this.suggestions.push({ ...row, id: this.nextSuggestionId++, status: 'pending' })
  }
  pendingGroups(): SuggestionGroup[] {
    const groups = new Map<string, SuggestionGroup>()
    for (const s of this.suggestions.filter((x) => x.status === 'pending')) {
      const key = `${s.raw}\u0000${s.suggested}`
      const g = groups.get(key) ?? {
        raw: s.raw,
        suggested: s.suggested,
        confidence: s.confidence,
        reason: s.reason,
        trackCount: 0
      }
      g.trackCount++
      groups.set(key, g)
    }
    return [...groups.values()]
  }
  pendingForRaw(raw: string): SuggestionRow[] {
    return this.suggestions.filter((s) => s.status === 'pending' && s.raw === raw)
  }
  setSuggestionStatus(ids: number[], status: SuggestionStatus): void {
    for (const s of this.suggestions) if (ids.includes(s.id)) s.status = status
  }
  pendingCount(): number {
    return new Set(this.suggestions.filter((s) => s.status === 'pending').map((s) => s.track_id))
      .size
  }

  journalAppend(entry: JournalEntry): void {
    this.journal.push(entry)
  }
  journalAll(): JournalEntry[] {
    return [...this.journal]
  }
  journalClear(): void {
    this.journal = []
  }

  deleteOrphanArtistTag(value: string): void {
    const inUse = [...this.tracks.values()].some((t) => t.tags.includes(value))
    if (!inUse) this.looseTags.delete(value)
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }
}
