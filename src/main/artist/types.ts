// Persistence and side effects for artist cleanup, injected so service.ts runs
// in plain Node under tests/unit (the same split as stats/ and identity/).

import type { ArtistTagEntry, Confidence, CleanReason, LibrarySpelling } from './clean'

export type SuggestionStatus = 'pending' | 'accepted' | 'kept' | 'edited' | 'dismissed'

export interface ArtistTrack {
  id: number
  filepath: string
  // tracks.artist as it stands (the derived display string).
  artist: string | null
  // The artist as first imported, never overwritten.
  artist_raw: string | null
}

export interface NewSuggestion {
  track_id: number
  raw: string
  suggested: string
  confidence: Confidence
  reason: CleanReason | 'write-failed'
}

export interface SuggestionRow extends NewSuggestion {
  id: number
  status: SuggestionStatus
}

export interface SuggestionGroup {
  raw: string
  suggested: string
  confidence: Confidence
  reason: string
  trackCount: number
}

export interface JournalEntry {
  batch_id: string
  track_id: number
  prev_column: string | null
  prev_tags: string[]
  file_written: boolean
}

export interface ReclaimTrack {
  id: number
  filepath: string
  artistColumn: string | null
  // Artist tag values in order; empty when the track has none.
  tagValues: string[]
}

export interface ArtistStore {
  transaction<T>(fn: () => T): T

  getTrack(id: number): ArtistTrack | null
  setArtistRawIfNull(id: number, raw: string): void
  getArtistTagValues(id: number): string[]
  // Replaces the track's artist tags and re-derives tracks.artist.
  setArtistTags(id: number, values: string[]): string | null
  // Writes tracks.artist directly (only for restoring a previous state).
  setTrackArtistColumn(id: number, value: string | null): void

  artistTagPool(): ArtistTagEntry[]
  librarySpellings(): LibrarySpelling[]
  liveTracksWithArtist(): ReclaimTrack[]

  keepRules(): string[]
  addKeepRule(raw: string): void

  insertSuggestion(row: NewSuggestion): void
  pendingGroups(): SuggestionGroup[]
  pendingForRaw(raw: string): SuggestionRow[]
  setSuggestionStatus(ids: number[], status: SuggestionStatus): void
  pendingCount(): number

  journalAppend(entry: JournalEntry): void
  journalAll(): JournalEntry[]
  journalClear(): void

  // Removes an artist tag no track carries any more (left behind when its
  // tracks were moved onto a cleaned name). Never touches a tag in use.
  deleteOrphanArtistTag(value: string): void

  getSetting(key: string): string | null
}

export type WriteArtistResult = { ok: true } | { ok: false; error: string }
// Writes the artist string to the audio file. Never throws.
export type WriteArtistFn = (filepath: string, artist: string) => Promise<WriteArtistResult>
