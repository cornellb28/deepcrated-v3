import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  getTrackByFilepath,
  getMissingTracks,
  fillTrackFieldsIfEmpty,
  setTrackAddedAt,
  insertCrate,
  addTracksToCrate,
  reorderCrateTracks,
  getAllCrates,
  insertPlaysBatch,
  isPathUnder,
  type SeratoPlayInsert,
  type MissingTrackCandidate
} from '../db'
import { findReconcileMatch } from '../reconcile'
import { getVolumeInfo, type VolumeInfo } from '../serato'
import { readSeratoTracks, defaultDatabaseVPath, type SeratoTrackEntry } from './seratoDatabase'
import { readSubcratesDir } from './seratoCrates'
import { listSessionFiles, readSessionPlays } from './seratoHistory'

// ── Orchestrator: chunkReader + the three format layers + the existing
// reconcile pipeline + crates/plays writes, all tied together. Never writes
// anything under `_Serato_` itself — every db.ts call this file makes is
// scoped to CrateCloud's own tables.

export interface SeratoLibraryLocation {
  seratoDir: string
  volume: VolumeInfo
}

// Read-only mirror of serato.ts's findSubcratesDir resolution — detection
// must never create `_Serato_` (that function's mkdir is exactly what makes
// it a writer; this one only ever checks what's already there).
export function detectSeratoLibrary(
  folderPath: string,
  libraryOverridePath: string | null
): SeratoLibraryLocation | null {
  const volume = getVolumeInfo(folderPath)
  const seratoDir =
    volume.isBootVolume && libraryOverridePath
      ? libraryOverridePath
      : volume.isBootVolume
        ? join(homedir(), 'Music', '_Serato_')
        : join(volume.root, '_Serato_')
  if (!existsSync(join(seratoDir, 'database V2'))) return null
  return { seratoDir, volume }
}

export interface SeratoImportTally {
  dbEntriesRead: number
  dbEntriesMatched: number
  fieldsFilledByField: Record<string, number>
  addedAtFilled: number
  cratesCreated: number
  crateTracksLinked: number
  crateUnresolvedPaths: number
  playsImported: number
  playsUnresolvedPaths: number
  // Capped sample across both crate and history unresolved paths — enough
  // to eyeball a volume-root resolution problem without holding every miss.
  unresolvedPathSamples: string[]
}

function emptyTally(): SeratoImportTally {
  return {
    dbEntriesRead: 0,
    dbEntriesMatched: 0,
    fieldsFilledByField: {},
    addedAtFilled: 0,
    cratesCreated: 0,
    crateTracksLinked: 0,
    crateUnresolvedPaths: 0,
    playsImported: 0,
    playsUnresolvedPaths: 0,
    unresolvedPathSamples: []
  }
}

const UNRESOLVED_SAMPLE_CAP = 25

function recordUnresolved(tally: SeratoImportTally, path: string): void {
  if (tally.unresolvedPathSamples.length < UNRESOLVED_SAMPLE_CAP) {
    tally.unresolvedPathSamples.push(path)
  }
}

// Exact path match first (the common case — folder import just inserted
// these rows with this same resolved path), falling back to the existing
// fingerprint reconcile scoped to this root's missing pool. The fallback
// only ever *identifies* a row for field-filling purposes — it never calls
// relinkTrack, since a Serato-recorded path being stale is not evidence
// that CrateCloud's current filepath for that track is wrong.
async function resolveSeratoTrack(
  resolvedPath: string,
  missingPool: MissingTrackCandidate[]
): Promise<Track | null> {
  const direct = getTrackByFilepath(resolvedPath)
  if (direct) return direct

  const match = await findReconcileMatch(
    {
      filepath: resolvedPath,
      filename: resolvedPath.split('/').pop() ?? resolvedPath,
      client_uuid: null,
      file_size_bytes: null,
      duration_sec: null
    },
    missingPool
  )
  if (!match) return null
  return getTrackByFilepath(match.filepath) ?? null
}

function seratoFieldsToCandidates(entry: SeratoTrackEntry): Record<string, unknown> {
  return {
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    genre: entry.genre,
    year: entry.year,
    comment: entry.comment,
    label: entry.label,
    remixer: entry.remixer,
    composer: entry.composer,
    grouping: entry.grouping,
    bpm: entry.bpm,
    key_full: entry.key,
    duration_sec: entry.durationSec,
    duration_str: null, // Serato's tlen is already captured as durationSec; no need to also fake-format it
    file_size_bytes: entry.fileSizeBytes
  }
}

// freshlyInsertedTrackIds: tracks just inserted by the folder-import pass
// this Serato import is chained to (their added_at is a meaningless "now,"
// not a real added date) — see the tracks table's NOT NULL DEFAULT.
// Anything not in this set already had a real added_at from an earlier
// session, and Serato's date is left alone, matching the "fill empty, never
// clobber" rule.
async function importDatabaseV2(
  location: SeratoLibraryLocation,
  folderPath: string,
  rootId: number,
  tally: SeratoImportTally,
  freshlyInsertedTrackIds: ReadonlySet<number>
): Promise<void> {
  const missingPool = getMissingTracks(rootId)
  const databaseVPath = defaultDatabaseVPath(location.seratoDir)

  for await (const entry of readSeratoTracks(databaseVPath)) {
    tally.dbEntriesRead++
    const resolvedPath = join(location.volume.root, entry.relativePath)
    if (!isPathUnder(resolvedPath, folderPath)) continue

    const track = await resolveSeratoTrack(resolvedPath, missingPool)
    if (!track) continue
    tally.dbEntriesMatched++

    const filled = fillTrackFieldsIfEmpty(track.id, seratoFieldsToCandidates(entry))
    for (const field of filled) {
      tally.fieldsFilledByField[field] = (tally.fieldsFilledByField[field] ?? 0) + 1
    }

    if (entry.addedAtEpochSec && freshlyInsertedTrackIds.has(track.id)) {
      setTrackAddedAt(track.id, entry.addedAtEpochSec)
      tally.addedAtFilled++
    }
  }
}

// Ensures every ancestor in nameParts exists as a real crate row (Serato's
// "Parent%%Child" filename convention doesn't guarantee a standalone
// "Parent.crate" ever existed — CrateCloud's nesting needs a real
// parent_crate_id chain regardless), reusing one across every crate import
// in this job that shares the same ancestor path.
function findOrCreateCratePath(
  nameParts: string[],
  cache: Map<string, number>,
  tally: SeratoImportTally
): number | null {
  let parentId: number | null = null
  let pathKey = ''
  for (const name of nameParts) {
    pathKey += `/${name}`
    const cached = cache.get(pathKey)
    if (cached !== undefined) {
      parentId = cached
      continue
    }
    const id = insertCrate(name, parentId)
    tally.cratesCreated++
    cache.set(pathKey, id)
    parentId = id
  }
  return parentId
}

async function importCrates(
  location: SeratoLibraryLocation,
  folderPath: string,
  rootId: number,
  tally: SeratoImportTally
): Promise<void> {
  const subcratesDir = join(location.seratoDir, 'Subcrates')
  const crateFiles = await readSubcratesDir(subcratesDir)
  if (crateFiles.length === 0) return

  const missingPool = getMissingTracks(rootId)
  const existing = getAllCrates()
  const cache = new Map<string, number>()
  // Seed the cache from crates that already exist (by name + parent chain)
  // so re-running the import reuses them instead of creating duplicates.
  const byId = new Map(existing.map((c) => [c.id, c]))
  for (const crate of existing) {
    const chain: string[] = [crate.name]
    let cursor = crate.parent_crate_id
    while (cursor !== null) {
      const parent = byId.get(cursor)
      if (!parent) break
      chain.unshift(parent.name)
      cursor = parent.parent_crate_id
    }
    cache.set(`/${chain.join('/')}`, crate.id)
  }

  for (const crateFile of crateFiles) {
    const orderedTrackIds: number[] = []
    for (const relativePath of crateFile.relativePaths) {
      const resolvedPath = join(location.volume.root, relativePath)
      if (!isPathUnder(resolvedPath, folderPath)) continue
      const track = await resolveSeratoTrack(resolvedPath, missingPool)
      if (!track) {
        tally.crateUnresolvedPaths++
        recordUnresolved(tally, resolvedPath)
        continue
      }
      orderedTrackIds.push(track.id)
    }
    if (orderedTrackIds.length === 0) continue

    const crateId = findOrCreateCratePath(crateFile.nameParts, cache, tally)
    if (crateId === null) continue
    addTracksToCrate(crateId, orderedTrackIds)
    reorderCrateTracks(crateId, orderedTrackIds)
    tally.crateTracksLinked += orderedTrackIds.length
  }
}

async function importHistory(
  location: SeratoLibraryLocation,
  folderPath: string,
  rootId: number,
  tally: SeratoImportTally
): Promise<void> {
  const sessionFiles = await listSessionFiles(location.seratoDir)
  if (sessionFiles.length === 0) return

  const missingPool = getMissingTracks(rootId)
  const plays: SeratoPlayInsert[] = []

  for (const sessionFile of sessionFiles) {
    for await (const play of readSessionPlays(sessionFile)) {
      // History stores an already-absolute path (unlike pfil/ptrk) — see
      // seratoHistory.ts. No volume-root join needed.
      if (!isPathUnder(play.absolutePath, folderPath)) continue
      const track = await resolveSeratoTrack(play.absolutePath, missingPool)
      if (!track) {
        tally.playsUnresolvedPaths++
        recordUnresolved(tally, play.absolutePath)
        continue
      }
      plays.push({
        track_id: track.id,
        filepath: play.absolutePath,
        played_at: play.playedAtEpochSec,
        duration_played_sec: play.durationPlayedSec,
        source: 'serato'
      })
    }
  }

  if (plays.length > 0) {
    tally.playsImported += insertPlaysBatch(plays)
  }
}

export async function runSeratoImport(
  location: SeratoLibraryLocation,
  folderPath: string,
  rootId: number,
  freshlyInsertedTrackIds: ReadonlySet<number>,
  onStage: (stage: 'database' | 'crates' | 'history') => void
): Promise<SeratoImportTally> {
  const tally = emptyTally()

  onStage('database')
  await importDatabaseV2(location, folderPath, rootId, tally, freshlyInsertedTrackIds)

  onStage('crates')
  await importCrates(location, folderPath, rootId, tally)

  onStage('history')
  await importHistory(location, folderPath, rootId, tally)

  return tally
}

// TODO(serato-import): incremental history re-sync on launch — re-scan only
// Sessions/*.session files whose mtime changed since the last import instead
// of re-reading every session every time. insertPlaysBatch's dedupe index
// already makes a full re-scan safe, just wasteful on a large history.
// TODO(serato-import): Windows `_Serato_` locations — detectSeratoLibrary
// inherits serato.ts's getVolumeInfo, which only knows the macOS
// /Volumes/<name> mount convention plus the boot volume (see its own TODO).
// TODO(serato-import): Serato colored-tags — not imported anywhere here;
// defer until we've confirmed where Serato stores per-track color (database
// V2's `ulbl` field decodes as a packed color-ish u32 in the real file this
// was verified against, but its exact semantics — track color vs. label
// color vs. something else — haven't been confirmed).
