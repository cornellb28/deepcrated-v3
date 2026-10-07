import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage, protocol } from 'electron'
import { join, extname, basename, dirname, relative, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { rename, stat, unlink, mkdir, readdir, readFile, open } from 'fs/promises'
import { createReadStream, createWriteStream, type Stats } from 'fs'
import { startWatcher, stopWatcher, stopAllWatchers, setWatcherCallbacks } from './libraryWatcher'
import { isUnchanged, normalizeMtime, withTrailingSep } from './rescan'
import {
  CALLBACK_PROTOCOLS,
  getAuthState,
  signOut,
  signInInBrowser,
  createAccountInBrowser,
  cancelBrowserAuth,
  reopenAuthBrowser,
  openAuthDestination,
  completeHandoffCallback,
  restoreSession,
  refreshAccountState,
  type AuthDestination,
  setAuthStateListener,
  stopSessionRefresh
} from './auth'
import { sweepTracks, sweepFolders } from './rescanSweep'
import {
  storeArtwork,
  artworkPathFor,
  sweepOrphanedArtwork,
  migrateArtworkToContentAddressed
} from './artwork'
import {
  insertTrack,
  insertTracksBatch,
  getAllTracks,
  getHealthSummary,
  getHealthQueue,
  setTrackAnalysisError,
  getTrackById,
  getTracksByIds,
  updateTrackMeta,
  markTrackMissing,
  getTrackScanIndex,
  markTracksSeenByIds,
  setRootLastScannedAt,
  deleteTrack,
  getAllTags,
  getMostUsedTags,
  addRoot,
  removeRoot,
  applyTag,
  removeTag,
  getTrackTags,
  getTrackTagsForTracks,
  getTagTracks,
  checkCandidates,
  confirmPendingImport,
  getPendingImports,
  getAllCrates,
  insertCrate,
  renameCrate,
  moveCrateParent,
  deleteCrate,
  addTracksToCrate,
  removeTracksFromCrate,
  getCrateTracks,
  getAllCrateTrackIds,
  reorderCrateTracks,
  touchCrateExported,
  getAllBoards,
  getTracksByColumn,
  updateBoardId,
  getSetting,
  setSetting,
  deleteSetting,
  getTracksByBoardId,
  findOrCreateTag,
  setTagsForField,
  renameTagAndCascade,
  deleteTagAndCascade,
  getUnanalyzedTracks,
  setTrackArtworkHash,
  updateTrackFilepath,
  getMissingTracks,
  relinkTrack,
  markTrackAnalyzed,
  insertPendingChange,
  getPendingChanges,
  acceptPendingChange,
  ignorePendingChange,
  getTrackByFilepath,
  getAllRoots,
  ensureFolderTree,
  ensureFolderForDirectory,
  notifyFoldersChanged,
  getFolderIdByRelativePath,
  markFolderMissing,
  deleteFolderCascade,
  folderEvents,
  getFolderTree,
  getFolderTrackCounts,
  getTracksByFolder,
  backfillTrackFolderIds,
  isPathUnder
} from './db'
import {
  analyzeFile,
  readTagsFast,
  type AnalysisStage,
  type EditTagsBatchItem,
  type EditTagsResult
} from './sidecar'
import { editTagsResolvingIdConflicts, queueTagWrites, writeTagsForFile } from './tagWrites'
import {
  exportCrateToSerato,
  isSeratoRunning,
  buildCrateFileBaseName,
  type CrateExportSettings
} from './serato'
import { computePartialHash, findReconcileMatch } from './reconcile'
import { isHealthCheckId } from './health/checks'
import type { AnalysisIssue } from './analysisIssue'
import {
  runSeratoImport,
  detectSeratoLibrary,
  type SeratoLibraryLocation,
  type SeratoImportTally
} from './serato/seratoImport'
import { checkBuildStatus } from './staleBuild'
import { applyFolderRename, planFolderRename } from './folderRename'
import { expectMove, cancelExpectation } from './expectedChanges'
import { buildFilename, type TemplateTrack } from './filenameTemplate'
import { resolveCollisionName } from './movePaths'
import {
  statsGetConsent,
  statsSetConsent,
  statsSetTracksPrivate,
  statsSetCratePrivate
} from './stats'
import { isReservedSettingKey } from './stats/consent'
import {
  startIdentityBackfill,
  kickIdentity,
  getIdentityStatus
} from './identity/runtime'
import { artistCleaner, processNewArtists, setArtistCleanSender } from './artist/runtime'
import { startStatsUploader, flushStatsOnQuit, shouldFlushOnQuit } from './stats/runtime'

// Raise file handle limit for large libraries
try {
  execSync('ulimit -n 4096')
} catch {
  /* ignore on Windows */
}

// console.log('DB path:', join(app.getPath('userData'), 'cratecloud', 'library.db'))

// ── Walk a folder and find all audio files ──────────────────────────────────────────────
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg'])

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff'
}

// ── Import job state (in-memory only) ────────────────────────────────────────────────────
// TODO: persist import jobs (id, folderPath, filepaths, nextIndex) to a DB table so a
// cancelled/interrupted job can be resumed after an app restart. This was proposed and
// explicitly deferred — needs a schema change and separate approval. As-is, resume only
// works within the same running app session (job state lives in `jobs` below).
type ImportPhase = 'counting' | 'parsing' | 'sweeping' | 'done' | 'cancelled' | 'error'

interface ImportProgressPayload {
  jobId: string
  phase: ImportPhase
  scanned: number
  total: number
  found: number
  skipped: number
  currentFolder: string
  estimateSeconds?: number
  // The folder passed to runFolderImport — job.folderPath was always tracked
  // internally (needed for resume) but never put on the wire until the
  // "Open folder" action needed a way to resolve which folder to navigate to
  // without a second IPC round trip.
  folderPath: string
  // Of `found`, how many were relinked to an existing (missing) track row
  // instead of inserted as new — see findReconcileMatch.
  relinked: number
  // Files the walk found exactly where the DB already had them, with an
  // unchanged size and mtime — no tag read, just a last_seen_at stamp.
  unchanged: number
  // Rows the sweep marked missing because the walk never saw their file.
  // Only ever non-zero on a rescan (job.rescan), and never a deletion.
  swept: number
  // True when this run is a rescan rather than a first import — the renderer
  // words the progress line differently ("Rescanning" vs "Importing") and
  // only a rescan can report a non-zero `swept`.
  rescan: boolean
}

interface ImportJob {
  type: 'import'
  id: string
  folderPath: string
  filepaths: string[]
  relativeDirs: string[] // every directory the Pass 1 walk visited, relative to folderPath
  folderIdByRelPath?: Map<string, number> // set once via ensureFolderTree, reused across resumes
  nextIndex: number
  scanned: number
  found: number
  skipped: number
  relinked: number
  unchanged: number
  swept: number
  total: number
  // Set by the rescan entry points only. Turns on the sweep at the end of
  // Pass 2 — a plain import must never sweep, because it walks one folder
  // and knows nothing about what is or isn't on disk outside it.
  rescan: boolean
  cancelRequested: boolean
  status: ImportPhase
  batchThroughputs: number[] // files/sec, rolling window — used for the ETA
  // Ids of rows genuinely INSERTed this job (not relinked) — the Serato
  // import chained after this job uses this to decide which tracks' added_at
  // is still a meaningless "just now" default versus a real prior value.
  insertedTrackIds: number[]
  // Set once the folder-import dialog's "Import Serato data" checkbox was
  // checked — read after the job reaches 'done' to chain runSeratoImport.
  importSeratoData: boolean
}

// ── Move job state (in-memory only) ──────────────────────────────────────
type MovePhase = 'running' | 'done' | 'cancelled' | 'error'

interface MoveFailure {
  trackId: number
  filepath: string
  error: string
}

interface MoveProgressPayload {
  jobId: string
  phase: MovePhase
  done: number
  total: number
  currentFile: string
  bytesCopied: number // current file only, cross-device copies only
  totalBytes: number // current file only, cross-device copies only; 0 for a rename
  crossDevice: boolean // true once any EXDEV fallback has occurred in this job
  failed: MoveFailure[]
}

interface MoveJob {
  type: 'move'
  id: string
  trackIds: number[]
  destAbsolutePath: string
  cancelRequested: boolean
  status: MovePhase
  doneCount: number
  currentFile: string
  bytesCopied: number
  totalBytes: number
  crossDevice: boolean
  failed: MoveFailure[]
  lastEmitAt: number
}

// ── Copy-into-folder job state (drag-and-drop from Finder) ───────────────
// Deliberately not a MoveJob: it copies arbitrary dropped paths that have no
// track row yet (never a rename, the source must survive), and finishes by
// calling into the same import path dialogs use — importSingleFile or
// runFolderImport — rather than updateTrackFilepath. The two share the
// streaming-copy primitive (streamCopyWithProgress) and the throttled-emit
// pattern, not the job shape itself.
type CopyPhase = 'running' | 'done' | 'cancelled' | 'error'

interface CopyFailure {
  sourcePath: string
  error: string
}

interface CopyProgressPayload {
  jobId: string
  phase: CopyPhase
  done: number
  total: number
  currentFile: string
  bytesCopied: number
  totalBytes: number
  failed: CopyFailure[]
  // True for a FolderView Finder-drop (move-in-place); false for the
  // EmptyView/Board drop paths that never call this job. Purely a label
  // switch for the renderer — the underlying job is identical either way.
  deleteSource: boolean
}

interface CopyJob {
  type: 'copy'
  id: string
  destAbsolutePath: string
  // Built once at the start of the run (stat/walk is async, so it can't be
  // known at job-creation time) — one entry per file to copy, expanded from
  // the dropped paths (a dropped directory expands to every file in its tree).
  plan: { source: string; dest: string }[]
  hadDirectory: boolean
  cancelRequested: boolean
  status: CopyPhase
  doneCount: number
  currentFile: string
  bytesCopied: number
  totalBytes: number
  failed: CopyFailure[]
  copiedFilePaths: string[] // successfully copied, non-directory-drop case only
  lastEmitAt: number
  // When true, each file is moved (rename, falling back to stream-copy +
  // verify + unlink on EXDEV) instead of copied — same control flow as
  // moveOneTrackFile, just not keyed by trackId since a dropped file has no
  // track row yet.
  deleteSource: boolean
}

// ── Crate export job state (in-memory only) ──────────────────────────────
// Deliberately coarse-grained (per-crate, not per-track) — writing a .crate
// file is fast, so "progress" here is really "which crate in this batch are
// we on," mainly useful for the "Export all crates" case.
type ExportPhase = 'running' | 'done' | 'error'

interface ExportFailure {
  crateId: number
  crateName: string
  error: string
}

interface ExportProgressPayload {
  jobId: string
  phase: ExportPhase
  done: number
  total: number
  currentCrateName: string
  volumesWritten: number
  missingSkipped: number
  exportedCrateNames: string[]
  failed: ExportFailure[]
}

interface ExportJob {
  type: 'export'
  id: string
  crateIds: number[]
  status: ExportPhase
  doneCount: number
  currentCrateName: string
  volumesWritten: number
  missingSkipped: number
  exportedCrateNames: string[]
  failed: ExportFailure[]
}

// ── Serato import job state (in-memory only) ──────────────────────────────
// Chained after a folder-import job that had "Import Serato data" checked —
// see maybeRunSeratoImport. Coarse-grained like ExportJob: three stages
// (database/crates/history), not per-file progress, since each stage is
// itself already a single streamed pass rather than something worth
// reporting file-by-file.
type SeratoImportPhase = 'running' | 'done' | 'error'
type SeratoImportStage = 'database' | 'crates' | 'history'

interface SeratoImportProgressPayload {
  jobId: string
  phase: SeratoImportPhase
  stage: SeratoImportStage
  tally: SeratoImportTally
  error?: string
}

interface SeratoImportJob {
  type: 'seratoImport'
  id: string
  status: SeratoImportPhase
  stage: SeratoImportStage
  tally: SeratoImportTally
  error?: string
}

// ── Batch tag-edit job state (in-memory only) ─────────────────────────────
// One spawned edit_tags.py --batch process per job (see editTagsBatch in
// sidecar.ts) — coarse-grained like export: one tick per file, not per
// byte. No DB write happens from this job yet — see runEditTagsJob.
type EditTagsPhase = 'running' | 'done' | 'error'

interface EditTagsFailure {
  filepath: string
  error: string
}

interface EditTagsProgressPayload {
  jobId: string
  phase: EditTagsPhase
  done: number
  total: number
  currentFile: string
  failed: EditTagsFailure[]
}

interface EditTagsJob {
  type: 'editTags'
  id: string
  total: number
  doneCount: number
  currentFile: string
  status: EditTagsPhase
  failed: EditTagsFailure[]
}

// One registry for every background job type, discriminated by `type`.
type Job = ImportJob | MoveJob | CopyJob | ExportJob | EditTagsJob | SeratoImportJob
const jobs = new Map<string, Job>()

const COUNT_PROGRESS_INTERVAL_MS = 250
const PARSE_PROGRESS_FILES = 50
const PARSE_PROGRESS_INTERVAL_MS = 250
const INSERT_BATCH_SIZE = 200
const THROUGHPUT_WINDOW = 10 // batches
const ESTIMATE_ELIGIBLE_RATIO = 0.1 // don't show an ETA before 10% scanned

function buildProgressPayload(
  job: ImportJob,
  phaseOverride?: ImportPhase,
  currentFolder = ''
): ImportProgressPayload {
  const payload: ImportProgressPayload = {
    jobId: job.id,
    phase: phaseOverride ?? job.status,
    scanned: job.scanned,
    total: job.total,
    found: job.found,
    skipped: job.skipped,
    currentFolder,
    folderPath: job.folderPath,
    relinked: job.relinked,
    unchanged: job.unchanged,
    swept: job.swept,
    rescan: job.rescan
  }

  // Rolling-window throughput, not average-since-start — the first files are
  // often slow due to cache warmup and would skew an early estimate.
  const ratio = job.total > 0 ? job.scanned / job.total : 0
  if (ratio >= ESTIMATE_ELIGIBLE_RATIO && job.batchThroughputs.length > 0) {
    const avgThroughput =
      job.batchThroughputs.reduce((a, b) => a + b, 0) / job.batchThroughputs.length
    const remaining = job.total - job.scanned
    if (avgThroughput > 0) {
      payload.estimateSeconds = Math.round(remaining / avgThroughput)
    }
  }

  return payload
}

// Pass 1 (count) — walk the tree collecting audio file paths only, no metadata
// reads. Same EMFILE-safe one-directory-at-a-time queue as before, but now
// reports progress as it goes instead of staying silent until fully walked.
async function scanFolderPaths(
  folderPath: string,
  job: ImportJob,
  emit: (p: ImportProgressPayload) => void
): Promise<{ files: string[]; dirs: string[] }> {
  const results: string[] = []
  // Every directory the walk visits, relative to folderPath ("" for the
  // root) — collected here for free since the walk already touches every
  // directory once; ensureFolderTree needs the full set, not just the ones
  // that turned out to contain audio.
  const dirs = new Set<string>()
  const queue: string[] = [folderPath]
  let lastEmit = Date.now()

  while (queue.length > 0) {
    if (job.cancelRequested) break
    const dir = queue.shift()!
    dirs.add(relative(folderPath, dir))
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          queue.push(fullPath)
        } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          results.push(fullPath)
        }
      }
    } catch {
      // skip unreadable directories
    }

    const now = Date.now()
    if (now - lastEmit >= COUNT_PROGRESS_INTERVAL_MS) {
      lastEmit = now
      emit({
        jobId: job.id,
        phase: 'counting',
        scanned: 0,
        total: 0,
        found: results.length,
        skipped: 0,
        currentFolder: dir,
        folderPath: job.folderPath,
        relinked: job.relinked,
        unchanged: job.unchanged,
        swept: job.swept,
        rescan: job.rescan
      })
    }
  }

  return { files: results, dirs: [...dirs] }
}

// Recursively count all audio files in a folder's subtree
async function countAudioFiles(folderPath: string): Promise<number> {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // skip hidden files/folders (e.g. macOS ._ AppleDouble files, .DS_Store)
      const fullPath = join(folderPath, entry.name)
      if (entry.isDirectory()) {
        count += await countAudioFiles(fullPath)
      } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        count++
      }
    }
    return count
  } catch {
    return 0
  }
}

// ── Content-addressed artwork storage ───────────────────────────────────────
// Artwork is deduped by content hash and shared across every track that
// embeds the same cover (the common case — every track on an album) instead
// of one file per track. See migrateArtworkToContentAddressed for the
// one-time move of legacy per-track <trackId>.jpg files onto this scheme.
// Build a consistent track data object from analysis result
function buildTrackData(
  filepath: string,
  result: AnalysisResult,
  folderId: number | null = null,
  lastModified: number | null = null
): {
  filepath: string
  filename: string
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  year: string | null
  comment: string | null
  label: string | null
  remixer: string | null
  composer: string | null
  grouping: string | null
  bpm: number | null
  key_camelot: string | null
  key_full: string | null
  camelot: string | null
  duration_sec: number | null
  duration_str: string | null
  analyzed_at: string | null
  board_id: number
  folder_id: number | null
  file_size_bytes: number | null
  client_uuid: string | null
  last_modified: number | null
  isrc: string | null
  musicbrainz_recording_id: string | null
} {
  return {
    filepath,
    filename: basename(filepath),
    title: result.title,
    artist: result.artist,
    album: result.album,
    genre: result.genre,
    year: result.year,
    comment: result.comment,
    label: result.label,
    remixer: result.remixer,
    composer: result.composer,
    grouping: result.grouping,
    bpm: result.bpm,
    key_camelot: result.key_camelot,
    key_full: result.key_full,
    camelot: result.camelot,
    duration_sec: result.duration_sec,
    duration_str: result.duration_str,
    analyzed_at: result.analyzed ? new Date().toISOString() : null,
    board_id: 1,
    folder_id: folderId,
    file_size_bytes: result.file_size_bytes ?? null,
    // Read-only for now — a CRATECLOUD_ID tag from a previous session that
    // wrote one, if present. insertTrack mints a fresh one when this is
    // null; reconcile matches on it first when it isn't (see
    // findReconcileMatch).
    client_uuid: result.client_uuid ?? null,
    // Paired with file_size_bytes as the rescan's "has this changed since we
    // last read it" signal. Null when the caller had no stat to hand (the
    // watcher's single-file paths) — a null simply means the next rescan
    // re-reads this file once and fills it in.
    last_modified: lastModified,
    // Raw tag values (null when the file has none). Passing the keys at all
    // tells insertTrack identity was read for this track; it validates them.
    isrc: result.isrc ?? null,
    musicbrainz_recording_id: result.musicbrainz_recording_id ?? null
  }
}

// Copies fromPath to toPath in 1MB chunks, reporting cumulative bytes
// copied as it goes — the EXDEV fallback's replacement for the old
// all-or-nothing copyFile(), which had no way to report progress on a
// large file mid-copy.
function streamCopyWithProgress(
  fromPath: string,
  toPath: string,
  onProgress: (bytesCopied: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(fromPath, { highWaterMark: 1024 * 1024 })
    const writeStream = createWriteStream(toPath)
    let bytesCopied = 0

    readStream.on('data', (chunk: string | Buffer) => {
      bytesCopied += chunk.length
      onProgress(bytesCopied)
    })
    readStream.on('error', (err) => {
      writeStream.destroy()
      reject(err)
    })
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)
    readStream.pipe(writeStream)
  })
}

// Moves one track's file to job.destAbsolutePath and updates its DB row.
// Every failure mode is caught and recorded in job.failed — this function
// never throws, so one bad file can never abort the rest of the job.
async function moveOneTrackFile(job: MoveJob, trackId: number): Promise<void> {
  const track = getTrackById(trackId)
  if (!track) {
    job.failed.push({ trackId, filepath: '', error: 'Track not found in the library' })
    return
  }

  const fromPath = track.filepath
  job.currentFile = fromPath
  job.bytesCopied = 0
  job.totalBytes = 0

  const toPath = join(job.destAbsolutePath, basename(fromPath))

  try {
    // Never overwrite — a name collision fails this file, not the job.
    try {
      await stat(toPath)
      job.failed.push({ trackId, filepath: fromPath, error: 'Destination already exists' })
      return
    } catch {
      // Good — does not exist
    }

    // Set once a size mismatch or a stale-source unlink happens below, but
    // the DB row still gets updated — the file itself landed correctly.
    let unlinkError: string | null = null

    try {
      await rename(fromPath, toPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err

      // Cross-device move — stream-copy, verify by size, then remove the source.
      job.crossDevice = true
      const sourceSize = (await stat(fromPath)).size
      job.totalBytes = sourceSize

      // TODO: sweep orphaned partial copies on startup. If the app is
      // killed mid-copy, toPath is left behind (writes go straight to it,
      // no temp-file+rename), but the DB row is untouched — updateTrackFilepath
      // only runs after this succeeds — so the source is never lost, just a
      // stray partial file to clean up.
      await streamCopyWithProgress(fromPath, toPath, (bytesCopied) => {
        job.bytesCopied = bytesCopied
      })

      const copiedSize = (await stat(toPath)).size
      if (copiedSize !== sourceSize) {
        await unlink(toPath).catch(() => {})
        throw new Error(
          `Copy verification failed (${copiedSize} of ${sourceSize} bytes) — source left untouched`
        )
      }

      try {
        await unlink(fromPath)
      } catch (err) {
        // The copy is good — do not roll it back. The DB still gets pointed
        // at the new path below; the stale source just needs manual cleanup.
        unlinkError = (err as Error).message
      }
    }

    // The only point the DB changes — a crash before this leaves the row
    // pointing at the still-intact source.
    updateTrackFilepath(fromPath, toPath)

    if (unlinkError) {
      job.failed.push({
        trackId,
        filepath: fromPath,
        error: `Moved, but couldn't remove the original file: ${unlinkError}`
      })
    }
  } catch (err) {
    job.failed.push({ trackId, filepath: fromPath, error: (err as Error).message })
  }
}

function buildMoveProgressPayload(job: MoveJob, phaseOverride?: MovePhase): MoveProgressPayload {
  return {
    jobId: job.id,
    phase: phaseOverride ?? job.status,
    done: job.doneCount,
    total: job.trackIds.length,
    currentFile: job.currentFile,
    bytesCopied: job.bytesCopied,
    totalBytes: job.totalBytes,
    crossDevice: job.crossDevice,
    failed: job.failed
  }
}

const MOVE_PROGRESS_INTERVAL_MS = 250

// Throttled the same way import progress is: every 250ms or every file
// completion (force), never per-chunk — a big cross-device copy would
// otherwise emit on every 1MB stream chunk.
function maybeEmitMoveProgress(
  event: Electron.IpcMainInvokeEvent,
  job: MoveJob,
  force = false
): void {
  const now = Date.now()
  if (force || now - job.lastEmitAt >= MOVE_PROGRESS_INTERVAL_MS) {
    job.lastEmitAt = now
    event.sender.send('move:progress', buildMoveProgressPayload(job))
  }
}

// Sequential, one file at a time — the cancel flag is only checked between
// files (never mid-copy), and moveOneTrackFile never throws, so a bad file
// can't abort the ones after it. No resume for move jobs (unlike import):
// cancelling ends the job for good, matching Part B/C's scope.
async function runMoveJob(event: Electron.IpcMainInvokeEvent, job: MoveJob): Promise<void> {
  job.status = 'running'

  for (const trackId of job.trackIds) {
    if (job.cancelRequested) {
      job.status = 'cancelled'
      maybeEmitMoveProgress(event, job, true)
      jobs.delete(job.id)
      return
    }

    await moveOneTrackFile(job, trackId)
    job.doneCount++
    job.currentFile = ''
    job.bytesCopied = 0
    job.totalBytes = 0
    maybeEmitMoveProgress(event, job, true)
  }

  job.status = 'done'
  maybeEmitMoveProgress(event, job, true)
  jobs.delete(job.id)
}

// Every file under dirPath, recursively — no audio-extension filter (unlike
// scanFolderPaths): dropping a folder from Finder should copy the whole
// tree as-is, the same way Finder itself would, and let the re-scan that
// follows decide what's importable.
async function collectFilesRecursive(dirPath: string): Promise<string[]> {
  const results: string[] = []
  const queue: string[] = [dirPath]
  while (queue.length > 0) {
    const dir = queue.shift()!
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) queue.push(full)
        else results.push(full)
      }
    } catch {
      // skip unreadable directories
    }
  }
  return results
}

// Copies (or moves, when job.deleteSource is set) one file to an explicit
// destination (unlike moveOneTrackFile, the destination isn't derived from
// basename(source) here — a directory-tree copy/move needs the source's
// position relative to the dropped folder preserved). copy mode never
// touches the source — the DJ dropped this from Finder, their original
// stays put no matter what. move mode renames first, falling back to
// stream-copy + verify + unlink on EXDEV, same as moveOneTrackFile. Every
// failure mode is caught and recorded in job.failed; this never throws, so
// one bad file can't abort the rest of the run.
async function copyOneFileIntoFolder(
  job: CopyJob,
  sourcePath: string,
  destPath: string
): Promise<boolean> {
  job.currentFile = sourcePath
  job.bytesCopied = 0
  job.totalBytes = 0

  try {
    // Never overwrite — a name collision fails this file, not the job, and
    // (in move mode) leaves the source untouched.
    try {
      await stat(destPath)
      job.failed.push({ sourcePath, error: 'Destination already exists' })
      return false
    } catch {
      // Good — does not exist
    }

    if (!job.deleteSource) {
      const sourceSize = (await stat(sourcePath)).size
      job.totalBytes = sourceSize

      await streamCopyWithProgress(sourcePath, destPath, (bytesCopied) => {
        job.bytesCopied = bytesCopied
      })

      const copiedSize = (await stat(destPath)).size
      if (copiedSize !== sourceSize) {
        await unlink(destPath).catch(() => {})
        throw new Error(
          `Copy verification failed (${copiedSize} of ${sourceSize} bytes) — source left untouched`
        )
      }

      return true
    }

    // Move mode — rename first (instant, same-volume); EXDEV means the
    // destination is on a different volume, so fall back to stream-copy,
    // verify, then remove the source.
    try {
      await rename(sourcePath, destPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err

      const sourceSize = (await stat(sourcePath)).size
      job.totalBytes = sourceSize

      await streamCopyWithProgress(sourcePath, destPath, (bytesCopied) => {
        job.bytesCopied = bytesCopied
      })

      const copiedSize = (await stat(destPath)).size
      if (copiedSize !== sourceSize) {
        await unlink(destPath).catch(() => {})
        throw new Error(
          `Copy verification failed (${copiedSize} of ${sourceSize} bytes) — source left untouched`
        )
      }

      try {
        await unlink(sourcePath)
      } catch (err) {
        // The copy landed fine — do not roll it back. Record it as a
        // failure anyway so the DJ knows the original needs manual cleanup,
        // even though the file is safely at the destination.
        job.failed.push({
          sourcePath,
          error: `Moved, but couldn't remove the original file: ${(err as Error).message}`
        })
        return true
      }
    }

    return true
  } catch (err) {
    job.failed.push({ sourcePath, error: (err as Error).message })
    return false
  }
}

function buildCopyProgressPayload(job: CopyJob, phaseOverride?: CopyPhase): CopyProgressPayload {
  return {
    jobId: job.id,
    phase: phaseOverride ?? job.status,
    done: job.doneCount,
    total: job.plan.length,
    currentFile: job.currentFile,
    bytesCopied: job.bytesCopied,
    totalBytes: job.totalBytes,
    failed: job.failed,
    deleteSource: job.deleteSource
  }
}

const COPY_PROGRESS_INTERVAL_MS = 250

function maybeEmitCopyProgress(
  event: Electron.IpcMainInvokeEvent,
  job: CopyJob,
  force = false
): void {
  const now = Date.now()
  if (force || now - job.lastEmitAt >= COPY_PROGRESS_INTERVAL_MS) {
    job.lastEmitAt = now
    event.sender.send('copy:progress', buildCopyProgressPayload(job))
  }
}

// ── Crate export job ──────────────────────────────────────────────────────

function buildExportProgressPayload(job: ExportJob): ExportProgressPayload {
  return {
    jobId: job.id,
    phase: job.status,
    done: job.doneCount,
    total: job.crateIds.length,
    currentCrateName: job.currentCrateName,
    volumesWritten: job.volumesWritten,
    missingSkipped: job.missingSkipped,
    exportedCrateNames: job.exportedCrateNames,
    failed: job.failed
  }
}

// Root-first ancestor names for Serato's "Parent%%Child" nested-crate file
// naming — walks parent_crate_id up from crateId, not including crateId's
// own name (the caller appends that itself via buildCrateFileBaseName).
function getAncestorNames(crateId: number, byId: Map<number, Crate>): string[] {
  const names: string[] = []
  const seen = new Set<number>()
  let current = byId.get(crateId)?.parent_crate_id ?? null
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const parent = byId.get(current)
    if (!parent) break
    names.unshift(parent.name)
    current = parent.parent_crate_id
  }
  return names
}

// Each crateId in the job is independent — nesting is purely a Serato
// display/naming convention (Parent%%Child), not track containment, so
// exporting a parent never pulls in a child's tracks and vice versa. Every
// crate writes its own file(s) from its own crate_tracks rows only.
async function runExportJob(event: Electron.IpcMainInvokeEvent, job: ExportJob): Promise<void> {
  const byId = new Map(getAllCrates().map((c) => [c.id, c]))
  const settings: CrateExportSettings = {
    libraryOverridePath: getSetting('serato_library_override'),
    overwriteExisting: getSetting('serato_overwrite_existing') !== 'false'
  }

  for (const crateId of job.crateIds) {
    const crate = byId.get(crateId)
    if (!crate) continue
    job.currentCrateName = crate.name
    event.sender.send('crate-export:progress', buildExportProgressPayload(job))

    const tracks = getCrateTracks(crateId)
    const fileBaseName = buildCrateFileBaseName(getAncestorNames(crateId, byId), crate.name)
    const outcome = await exportCrateToSerato(
      {
        id: crateId,
        fileBaseName,
        tracks: tracks.map((t) => ({ id: t.id, filepath: t.filepath, missing: !!t.missing }))
      },
      settings
    )

    job.doneCount += 1
    job.missingSkipped += outcome.missingSkipped
    if (outcome.error) {
      job.failed.push({ crateId, crateName: crate.name, error: outcome.error })
    } else {
      job.volumesWritten += outcome.paths.length
      if (outcome.paths.length > 0) {
        job.exportedCrateNames.push(crate.name)
        touchCrateExported(crateId)
      }
    }
    event.sender.send('crate-export:progress', buildExportProgressPayload(job))
  }

  job.status =
    job.crateIds.length > 0 && job.failed.length === job.crateIds.length ? 'error' : 'done'
  event.sender.send('crate-export:progress', buildExportProgressPayload(job))
  setTimeout(() => jobs.delete(job.id), 15000)
}

function buildSeratoImportProgressPayload(job: SeratoImportJob): SeratoImportProgressPayload {
  return { jobId: job.id, phase: job.status, stage: job.stage, tally: job.tally, error: job.error }
}

// Chained after a folder-import job that had "Import Serato data" checked —
// never awaited by the caller (fire-and-forget, same as roots:add's own
// auto-import), so the folder-import IPC call itself still resolves
// immediately; progress streams over its own channel like every other job.
function maybeRunSeratoImport(
  event: Electron.IpcMainInvokeEvent,
  location: SeratoLibraryLocation,
  folderPath: string,
  rootId: number,
  freshlyInsertedTrackIds: number[]
): void {
  const id = randomUUID()
  const job: SeratoImportJob = {
    type: 'seratoImport',
    id,
    status: 'running',
    stage: 'database',
    tally: {
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
  jobs.set(id, job)
  event.sender.send('serato-import:progress', buildSeratoImportProgressPayload(job))

  runSeratoImport(location, folderPath, rootId, new Set(freshlyInsertedTrackIds), (stage) => {
    job.stage = stage
    event.sender.send('serato-import:progress', buildSeratoImportProgressPayload(job))
  })
    .then((tally) => {
      job.tally = tally
      job.status = 'done'
      event.sender.send('serato-import:progress', buildSeratoImportProgressPayload(job))
    })
    .catch((err) => {
      job.status = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      event.sender.send('serato-import:progress', buildSeratoImportProgressPayload(job))
    })
    .finally(() => {
      setTimeout(() => jobs.delete(id), 15000)
    })
}

function buildEditTagsProgressPayload(
  job: EditTagsJob,
  phaseOverride?: EditTagsPhase
): EditTagsProgressPayload {
  return {
    jobId: job.id,
    phase: phaseOverride ?? job.status,
    done: job.doneCount,
    total: job.total,
    currentFile: job.currentFile,
    failed: job.failed
  }
}

// Spawns edit_tags.py once in --batch mode (see editTagsBatch in
// sidecar.ts) and streams one progress tick per file. This only spawns the
// sidecar and reports progress — no DB write happens here yet.
// TODO(deepcrated): stamping updated_at / recording write-back status per
// track needs its own confirmed step once the result shape is signed off —
// see the CRATECLOUD_ID write-back plan.
async function runEditTagsJob(
  event: Electron.IpcMainInvokeEvent,
  job: EditTagsJob,
  items: EditTagsBatchItem[],
  writeSerato: boolean
): Promise<void> {
  try {
    await queueTagWrites(
      items.map((item) => item.filepath),
      () =>
        editTagsResolvingIdConflicts(
          items,
          (result: EditTagsResult) => {
            job.doneCount++
            job.currentFile = result.filepath ?? job.currentFile
            if (!result.success) {
              job.failed.push({
                filepath: result.filepath ?? '(unknown)',
                error: result.error ?? 'Unknown error'
              })
            }
            event.sender.send('edit-tags:progress', buildEditTagsProgressPayload(job))
          },
          { writeSerato }
        )
    )
    job.status = 'done'
  } catch (err) {
    job.status = 'error'
    job.failed.push({
      filepath: '(batch)',
      error: err instanceof Error ? err.message : String(err)
    })
  }
  event.sender.send('edit-tags:progress', buildEditTagsProgressPayload(job))
  jobs.delete(job.id)
}

// Update just the analysis fields after Phase 2 completes
function updateTrackAnalysis(trackId: number, result: AnalysisResult): void {
  const existing = getTrackById(trackId)
  updateTrackMeta({
    id: trackId,
    title: result.title,
    artist: result.artist,
    genre: result.genre,
    bpm: result.bpm,
    key_camelot: result.key_camelot,
    energy: null,
    comment: result.comment,
    artwork_path: existing?.artwork_path ?? null,
    needs_sync: 0,
    pending_changes: null
  })
}

async function runFolderImport(
  event: Electron.IpcMainInvokeEvent,
  folderPath: string,
  jobId?: string,
  importSeratoData = false,
  rescan = false
): Promise<{
  imported: number
  failed: number
  total: number
  jobId: string
  cancelled?: boolean
  unchanged?: number
  relinked?: number
  swept?: number
}> {
  // Pause watcher for this root during import to avoid EMFILE
  const roots = getAllRoots()
  const matchingRoot = roots.find((r) => isPathUnder(folderPath, r.path))
  if (matchingRoot) {
    await stopWatcher(matchingRoot.id)
    // Create the root's own folder row immediately, not after Pass 1 — the
    // renderer's root picker resolves a root's card to a folder id via
    // folders:tree and stays unclickable (no crash, just a silent no-op)
    // until that row exists, which previously meant the whole counting
    // phase on a large library.
    ensureFolderTree(matchingRoot.id, [''])
  }

  const id = jobId ?? randomUUID()
  const existing = jobs.get(id)
  const job: ImportJob =
    existing && existing.type === 'import'
      ? existing
      : {
          type: 'import',
          id,
          folderPath,
          filepaths: [],
          relativeDirs: [],
          nextIndex: 0,
          scanned: 0,
          found: 0,
          skipped: 0,
          relinked: 0,
          unchanged: 0,
          swept: 0,
          total: 0,
          rescan,
          cancelRequested: false,
          status: 'counting',
          batchThroughputs: [],
          insertedTrackIds: [],
          importSeratoData
        }
  jobs.set(id, job)

  const emit = (p: ImportProgressPayload): void => event.sender.send('import:progress', p)

  // Pass 1 (count) — skipped when resuming a job that already has its file list
  if (job.filepaths.length === 0) {
    job.status = 'counting'
    const scanned = await scanFolderPaths(folderPath, job, emit)

    if (job.cancelRequested) {
      // Discard the partial count — a future resume should redo pass 1 cleanly
      // rather than resume over an incomplete file list.
      job.filepaths = []
      job.status = 'cancelled'
      emit(buildProgressPayload(job, 'cancelled'))
      if (matchingRoot) startWatcher(matchingRoot.id, matchingRoot.path)
      return {
        imported: job.found,
        failed: job.skipped,
        total: job.total,
        jobId: id,
        cancelled: true
      }
    }

    job.filepaths = scanned.files
    // scanned.dirs are relative to folderPath, but ensureFolderTree needs
    // them relative to the registered ROOT — the same thing only when
    // folderPath is the root itself. Re-scanning a subfolder of an
    // already-registered root (folderPath !== matchingRoot.path, e.g. via
    // FolderView's "Re-scan this folder") would otherwise resolve every
    // file's "" relative dir to the root's own folder id instead of the
    // subfolder's.
    job.relativeDirs = matchingRoot
      ? scanned.dirs.map((d) => relative(matchingRoot.path, join(folderPath, d)))
      : scanned.dirs
    job.total = job.filepaths.length
  }

  // Doubles as the sweep's outermost safety guard: a walk that found no
  // audio at all is far more likely to be an unmounted drive or a revoked
  // folder permission than a library the DJ genuinely emptied, so a rescan
  // that comes back with nothing changes nothing rather than marking every
  // track under the root missing.
  if (job.total === 0) {
    job.status = 'done'
    emit(buildProgressPayload(job, 'done'))
    if (matchingRoot) startWatcher(matchingRoot.id, matchingRoot.path)
    jobs.delete(id)
    return { imported: 0, failed: 0, total: 0, jobId: id }
  }

  // Build the folder tree once per job (idempotent — safe to redo on resume)
  // and resolve each file's directory to a folder id from it. No matchingRoot
  // means this folder isn't a registered library root — folder_id stays null
  // for every track in that case, same as importSingleFile.
  if (!job.folderIdByRelPath && matchingRoot) {
    job.folderIdByRelPath = ensureFolderTree(matchingRoot.id, job.relativeDirs)
  }
  const resolveFolderId = (filepath: string): number | null => {
    if (!job.folderIdByRelPath || !matchingRoot) return null
    const relDir = relative(matchingRoot.path, dirname(filepath))
    return job.folderIdByRelPath.get(relDir) ?? null
  }

  // Fetched once per job, not per batch — batch-shaped reconcile. No
  // matchingRoot means folder_id stays null for everything this job
  // touches anyway (same as importSingleFile), so there's nothing a
  // scoped missing-pool match could mean here; skip reconcile entirely
  // rather than fall back to an unscoped, whole-library search.
  const reconcilePool = matchingRoot ? getMissingTracks(matchingRoot.id) : []

  // Every track the DB already has under the subtree being walked, keyed by
  // filepath. Serves both halves of the rescan:
  //   mark  — a walked file whose row here has the same size and mtime is
  //           unchanged, so Pass 2 skips the tag read entirely and just
  //           stamps it seen.
  //   sweep — whatever is left in `unseen` once the walk is done was in the
  //           DB but not on disk, so it gets marked missing (never deleted).
  // Fetched once per job rather than one lookup per file: a single indexed
  // prefix scan beats N point queries, and Pass 2 is already the hot loop.
  const scanPrefix = withTrailingSep(folderPath)
  const scanIndex = new Map(getTrackScanIndex(scanPrefix).map((row) => [row.filepath, row]))
  // Every path the walk actually laid eyes on. The sweep marks whatever is
  // in the DB under this prefix but NOT in here.
  const seen = new Set<string>()
  // Rows confirmed present and unchanged, stamped in one batch at the end
  // instead of one UPDATE per file.
  const seenUnchangedIds: number[] = []

  // Pass 2 (parse) — fast tag read + insert, batched into ~200-row transactions
  job.status = 'parsing'
  const concurrency = 4
  let sinceEmit = 0
  let lastEmit = Date.now()
  let currentFolderLabel = ''

  // Checked after every concurrency chunk (every ~4 files), not just once per
  // 200-row batch — a batch can take many seconds on a real library, and the
  // spec's "every 50 files or 250ms" cadence would otherwise go unmet for the
  // whole batch.
  const maybeEmitParsingProgress = (force = false): void => {
    const now = Date.now()
    if (
      force ||
      sinceEmit >= PARSE_PROGRESS_FILES ||
      now - lastEmit >= PARSE_PROGRESS_INTERVAL_MS
    ) {
      lastEmit = now
      sinceEmit = 0
      emit(buildProgressPayload(job, 'parsing', currentFolderLabel))
    }
  }

  for (let i = job.nextIndex; i < job.filepaths.length; i += INSERT_BATCH_SIZE) {
    if (job.cancelRequested) {
      job.status = 'cancelled'
      job.nextIndex = i
      emit(
        buildProgressPayload(
          job,
          'cancelled',
          dirname(job.filepaths[Math.max(i - 1, 0)] ?? folderPath)
        )
      )
      if (matchingRoot) startWatcher(matchingRoot.id, matchingRoot.path)
      runPhase2Analysis(event) // analyze whatever made it in before the cancel
      return {
        imported: job.found,
        failed: job.skipped,
        total: job.total,
        jobId: id,
        cancelled: true
      }
    }

    const batchStart = Date.now()
    const batchPaths = job.filepaths.slice(i, i + INSERT_BATCH_SIZE)
    const parsedRows: { data: ReturnType<typeof buildTrackData>; artwork: string | null }[] = []

    for (let j = 0; j < batchPaths.length; j += concurrency) {
      const chunk = batchPaths.slice(j, j + concurrency)
      await Promise.all(
        chunk.map(async (filepath) => {
          try {
            seen.add(filepath)

            // One stat is orders of magnitude cheaper than readTagsFast (a
            // sidecar round trip per file), so it is worth paying on every
            // file to skip the expensive read on the ones that have not
            // changed. A stat failure is not fatal here: fall through to
            // the normal read path and let that report the real problem.
            let info: Stats | null = null
            try {
              info = await stat(filepath)
            } catch {
              info = null
            }

            const known = scanIndex.get(filepath)
            if (isUnchanged(known, info)) {
              // Same bytes, same mtime, same place — nothing to re-read.
              // Still counts as scanned and found so the progress bar and
              // the final tally stay honest about how much was covered.
              seenUnchangedIds.push(known!.id)
              job.scanned++
              job.found++
              job.unchanged++
              return
            }

            const result = await readTagsFast(filepath)
            job.scanned++
            if (!result.success) {
              job.skipped++
              return
            }
            parsedRows.push({
              data: buildTrackData(
                filepath,
                result,
                resolveFolderId(filepath),
                info ? normalizeMtime(info.mtimeMs) : null
              ),
              artwork: result.artwork_base64
            })
          } catch {
            job.scanned++
            job.skipped++
          }
        })
      )

      sinceEmit += chunk.length
      currentFolderLabel = dirname(chunk[chunk.length - 1])
      maybeEmitParsingProgress()
    }

    // Reconcile before inserting — a file that matches a missing track gets
    // relinked (filepath/folder_id updated, everything else about the
    // existing row left alone) instead of becoming a duplicate. Matched
    // candidates are spliced out of reconcilePool as they're consumed so
    // the same missing row can't match twice within one job.
    const toInsert: typeof parsedRows = []
    for (const row of parsedRows) {
      const match = await findReconcileMatch(
        {
          filepath: row.data.filepath,
          filename: row.data.filename,
          client_uuid: row.data.client_uuid,
          file_size_bytes: row.data.file_size_bytes,
          duration_sec: row.data.duration_sec
        },
        reconcilePool
      )
      if (match === null) {
        toInsert.push(row)
        continue
      }
      relinkTrack(match.id, row.data.filepath)
      reconcilePool.splice(reconcilePool.indexOf(match), 1)
      // The row now lives at the new path, which the walk did see, so it is
      // already in `seen` and the sweep will leave it alone. Nothing to undo
      // for the old path either: the sweep works off the scan index's
      // filepaths, and relinkTrack has already moved this row off that one.
      job.found++
      job.relinked++
      // The existing row's artwork_hash survives untouched — a relink is
      // "this file is the same track, just moved," not a re-import.
    }

    // One transaction per batch instead of one fsync-backed write per file.
    // partial_hash is computed for every genuinely-new row (not just tied
    // reconcile candidates) — it's cheap, and it's the only way a FUTURE
    // reconcile pass can ever use it, since it can't be read back off a
    // file once that file's own track has gone missing.
    if (toInsert.length > 0) {
      const withHashes = await Promise.all(
        toInsert.map(async (r) => ({
          ...r,
          data: { ...r.data, partial_hash: await computePartialHash(r.data.filepath) }
        }))
      )
      const inserted = insertTracksBatch(withHashes.map((r) => r.data))
      for (let idx = 0; idx < inserted.length; idx++) {
        const row = inserted[idx]
        job.found++
        if (row.id > 0 && row.wasInserted) job.insertedTrackIds.push(row.id)
        const artwork = withHashes[idx].artwork
        if (artwork && row.id > 0) {
          const hash = await storeArtwork(Buffer.from(artwork, 'base64'))
          if (hash) setTrackArtworkHash(row.id, hash)
        }
      }
      // New tracks get their artist names cleaned and turned into tags, in the
      // background; relinked and re-scanned rows are not new and are skipped.
      processNewArtists(inserted.filter((r) => r.id > 0 && r.wasInserted).map((r) => r.id))
    }

    job.nextIndex = i + batchPaths.length

    // Batch committed — renderer refetches on this, debounced on that side so
    // a burst of fast batches collapses into a single reload.
    event.sender.send('import:batch-committed', { jobId: id })

    const batchMs = Date.now() - batchStart
    if (batchMs > 0) {
      job.batchThroughputs.push((batchPaths.length / batchMs) * 1000)
      if (job.batchThroughputs.length > THROUGHPUT_WINDOW) job.batchThroughputs.shift()
    }

    // Force a progress emit right after the commit so `found` reflects the
    // batch that just landed, instead of waiting for the next chunk's throttle.
    maybeEmitParsingProgress(true)

    // Yield to the event loop after each committed batch so the main process
    // stays responsive to other IPC (folder browsing, playback, etc.) mid-import.
    await new Promise((resolve) => setImmediate(resolve))
  }

  // Batched rather than one UPDATE per file — on a rescan where nothing has
  // changed this is the only write the whole job makes.
  if (seenUnchangedIds.length > 0) markTracksSeenByIds(seenUnchangedIds)

  // ── Sweep ────────────────────────────────────────────────────────────
  // Only on an explicit rescan. A plain import walks one folder and knows
  // nothing about what is or isn't on disk elsewhere, so it has no standing
  // to call anything missing.
  if (job.rescan) {
    job.status = 'sweeping'
    emit(buildProgressPayload(job, 'sweeping'))

    // Guard against the walk having been cut short by the volume going away
    // mid-scan — an unplugged drive looks exactly like "every file was
    // deleted" from the walk's point of view, and while marking missing is
    // recoverable, flagging a whole library is a miserable thing to hand a
    // DJ. A walk that found nothing at all never even gets here: the
    // `job.total === 0` early return above fires first.
    let rootStillThere = true
    try {
      await stat(folderPath)
    } catch {
      rootStillThere = false
    }

    if (!rootStillThere) {
      console.warn(`[rescan] skipping sweep — ${folderPath} is no longer readable`)
    } else {
      // Re-read the index rather than reusing the one Pass 2 started with:
      // relinks and inserts during this job have moved rows onto new paths,
      // and the sweep must judge the library as it stands now.
      job.swept = sweepTracks(scanPrefix, seen).swept

      // job.relativeDirs is already root-relative (remapped in Pass 1),
      // which is the frame sweepFolders compares in.
      if (matchingRoot) {
        sweepFolders(matchingRoot.id, matchingRoot.path, folderPath, new Set(job.relativeDirs))
        setRootLastScannedAt(matchingRoot.id)
      }

      console.log(
        `[rescan] ${folderPath}: ${job.unchanged} unchanged, ${job.relinked} relinked, ` +
          `${job.swept} marked missing`
      )
    }
  }

  job.status = 'done'
  emit(buildProgressPayload(job, 'done'))
  jobs.delete(id)

  // New tracks have identity tags to read; the backfill steps aside during an
  // import, so give it the nudge now that this one is over.
  kickIdentity()

  // Restart watcher after import completes
  if (matchingRoot) startWatcher(matchingRoot.id, matchingRoot.path)

  runPhase2Analysis(event)

  if (matchingRoot && job.importSeratoData && !(await isSeratoRunning())) {
    // Never read `_Serato_` while Serato itself might have it open — same
    // refusal serato.ts's export path already enforces, reused here rather
    // than duplicated. A checkbox checked earlier and Serato launched since
    // is simply skipped, not surfaced as an error: the folder import itself
    // still succeeded.
    const location = detectSeratoLibrary(folderPath, getSetting('serato_library_override'))
    if (location) {
      maybeRunSeratoImport(event, location, folderPath, matchingRoot.id, job.insertedTrackIds)
    }
  }

  return {
    imported: job.found,
    failed: job.skipped,
    total: job.total,
    jobId: id,
    unchanged: job.unchanged,
    relinked: job.relinked,
    swept: job.swept
  }
}

type RegisterRootResult =
  | { status: 'registered'; rootId: number }
  | { status: 'already-covered'; rootId: number }
  | { status: 'conflict'; conflictingRoots: LibraryRoot[] }

// Single chokepoint for turning a folder path into a registered library
// root: every "import a folder" entry point calls this before
// runFolderImport, which stays pure import and never touches library_roots
// itself. Checks both nesting directions — isPathUnder only ever checked
// "is the new path inside an existing root" before this, so importing a
// PARENT of an already-registered root (e.g. root "/Music/Techno" exists,
// DJ then imports "/Music") silently created a second, overlapping root
// with its own watcher and its own parallel folder tree over the same
// physical subdirectories. That's a real bug, not a hypothetical — but
// merging two roots (reassigning folder_id, deleting the redundant row,
// redirecting the watcher) is a distinct, riskier operation than anything
// else this function does, so it's surfaced as a 'conflict' for the caller
// to refuse with a clear message rather than silently deciding either way.
function registerLibraryRoot(path: string): RegisterRootResult {
  const existingRoots = getAllRoots()

  const coveringRoot = existingRoots.find((r) => isPathUnder(path, r.path))
  if (coveringRoot) {
    return { status: 'already-covered', rootId: coveringRoot.id }
  }

  const conflictingRoots = existingRoots.filter((r) => isPathUnder(r.path, path))
  if (conflictingRoots.length > 0) {
    return { status: 'conflict', conflictingRoots }
  }

  const rootResult = addRoot(basename(path), path)
  const rootId = Number(rootResult.lastInsertRowid)
  ensureFolderTree(rootId, [''])
  startWatcher(rootId, path)
  return { status: 'registered', rootId }
}

// Set by the analysis:stop IPC, cleared at the start of every run. Analysis
// is a long, heavy job — librosa reads the whole file per track — and a DJ
// who started it on a 5,000-track import needs a way out that is not "quit
// the app".
//
// Checked BETWEEN batches rather than mid-track: a sidecar process already
// reading a file is left to finish, because killing it buys a couple of
// seconds and costs a half-written analysis. Stopping means "start no more",
// which on a batch of four is at most a few seconds' wait.
let phase2StopRequested = false

export function requestPhase2Stop(): void {
  phase2StopRequested = true
}

// What an analysis says about the FILE, stored on the track and pushed to the
// renderer. Records only a definite outcome — a clean success (which clears
// any earlier problem) or a failure the sidecar attributed to the file. A
// failure with no issue (file not found, sidecar would not start) says
// nothing about the file and must never mark it corrupt.
// Returns the issue when one was recorded.
function recordAnalysisOutcome(
  sender: Electron.WebContents | null,
  trackId: number,
  result: { success: boolean; analysis_issue?: AnalysisIssue | null }
): AnalysisIssue | null {
  const issue = result.analysis_issue ?? null
  if (!result.success && !issue) return null
  setTrackAnalysisError(trackId, issue)
  if (issue && sender && !sender.isDestroyed()) {
    sender.send('library:track-analysis-issue', { trackId, issue })
  }
  return issue
}

async function runPhase2Analysis(event: Electron.IpcMainInvokeEvent): Promise<void> {
  phase2StopRequested = false

  // Only analyze tracks that Phase 1 did not already resolve
  // (tracks that had BPM/key tags skip librosa entirely)
  const unanalyzed = getUnanalyzedTracks() as Track[]

  if (unanalyzed.length === 0) {
    event.sender.send('library:analysis-complete', {
      analyzed: 0,
      total: 0,
      stopped: false,
      issues: 0
    })
    return
  }

  const total = unanalyzed.length
  let done = 0
  // Files analysis found bad this run. They are recorded on the track, so the
  // next run skips them instead of decoding them again.
  let issues = 0
  const concurrency = 4 // librosa is heavy — keep this lower

  for (let i = 0; i < unanalyzed.length; i += concurrency) {
    if (phase2StopRequested) break

    const batch = unanalyzed.slice(i, i + concurrency)

    await Promise.all(
      batch.map(async (track) => {
        try {
          const result = await analyzeFile(track.filepath)
          const issue = recordAnalysisOutcome(event.sender, track.id, result)
          if (issue) issues++

          if (!result.success && issue) {
            // Unreadable: nothing to write, but it was processed.
            done++
          }

          if (result.success) {
            // Update just the analysis fields
            updateTrackMeta({
              id: track.id,
              title: track.title,
              artist: track.artist,
              genre: track.genre,
              bpm: result.bpm,
              key_camelot: result.key_camelot,
              energy: null,
              comment: track.comment,
              artwork_path: track.artwork_path,
              needs_sync: 0,
              pending_changes: null
            })

            // Mark as analyzed
            markTrackAnalyzed(track.id)

            done++

            // Tell renderer to update this track's badges
            event.sender.send('library:track-analyzed', {
              trackId: track.id,
              bpm: result.bpm,
              key_camelot: result.key_camelot,
              key_full: result.key_full,
              duration_sec: result.duration_sec,
              duration_str: result.duration_str,
              done,
              total
            })
          }
        } catch {
          // Skip failed analysis — track still visible without BPM
          done++
        }
      })
    )

    await new Promise((r) => setTimeout(r, 100))
  }

  // `stopped` lets the renderer say "stopped at 340 of 5,000" rather than
  // reporting a completed run that silently analysed a fraction of it. The
  // tracks it did not reach keep analyzed_at null, so the next run picks
  // them up exactly where this one left off.
  event.sender.send('library:analysis-complete', {
    analyzed: done,
    total,
    stopped: phase2StopRequested,
    issues
  })

  phase2StopRequested = false
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 1200,
    height: 1000,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow = win
  win.on('focus', () => {
    void refreshAccountState()
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Deep-link registration for the OAuth callback ────────────────────────
// Must happen before whenReady: on Windows/Linux the second launch that the
// browser triggers has to be able to hand its URL to the first instance,
// and that only works if the lock is already held.
//
// requestSingleInstanceLock also fixes a real problem beyond auth — two
// copies of the app would open two better-sqlite3 handles on the same
// library.db and two chokidar watchers per root.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // Windows/Linux deliver the deepcrated:// URL as an argv entry on the
  // second instance, not as an event — so it has to be dug out of the
  // command line. macOS uses 'open-url' instead (registered below).
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => CALLBACK_PROTOCOLS.some((s) => arg.startsWith(`${s}://`)))
    if (url) void handleAuthCallback(url)

    // Whether or not it was a deep link, the DJ just tried to open the app:
    // surface the window they already have.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS. Registered at module scope, not inside whenReady, because a cold
// start triggered by clicking the callback link can fire this before the app
// is ready — handleAuthCallback tolerates a not-yet-existing window.
app.on('open-url', (event, url) => {
  event.preventDefault()
  void handleAuthCallback(url)
})

// In dev the executable is Electron itself, so the OS has to be told which
// binary and which script to hand deepcrated:// back to; packaged builds
// need neither argument. Without this branch, deep links silently never
// arrive during development, which looks exactly like broken OAuth code.
for (const scheme of CALLBACK_PROTOCOLS) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(scheme)
  }
}

// Redeems the one-time key and tells the renderer, which is waiting on a
// spinner after having opened the browser. A link that is not a valid answer
// to a pending sign-in is ignored entirely: no focus, no toast, no state
// change. A failed redeem pushes the generic failure so the spinner clears.
async function handleAuthCallback(url: string): Promise<void> {
  const result = await completeHandoffCallback(url)
  if (!result.ok && result.ignored) return
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // The key was redeemed in main; only this derived state and a success
    // marker are delivered to the renderer. Tokens never cross this boundary.
    mainWindow.webContents.send(
      'auth:changed',
      result.ok
        ? { ...result.state, justSignedIn: true }
        : { ...getAuthState(), error: result.error }
    )
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artwork',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  startStatsUploader()
  setArtistCleanSender((channel, payload) => mainWindow?.webContents.send(channel, payload))
  startIdentityBackfill({
    send: (status) => mainWindow?.webContents.send('identity:progress', status),
    // Step aside while an import is walking or parsing a folder.
    isImportRunning: () =>
      [...jobs.values()].some(
        (j) => j.type === 'import' && (j.status === 'parsing' || j.status === 'sweeping')
      )
  })
  let artworkInFlight = 0
  const ARTWORK_CONCURRENCY = 8
  // ── Register a custom protocol for serving local artwork ──────────────────────────────────────────────
  protocol.handle('artwork', async (request) => {
    // Wait if too many concurrent requests
    while (artworkInFlight >= ARTWORK_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 50))
    }
    artworkInFlight++
    try {
      const artworkPath = decodeURIComponent(request.url.replace('artwork://', ''))
      const data = await readFile(artworkPath)
      return new Response(data, {
        headers: { 'Content-Type': 'image/jpeg' }
      })
    } catch {
      return new Response(null, { status: 404 })
    } finally {
      artworkInFlight--
    }
  })

  // ── Register a custom protocol for streaming audio playback ────────────
  // Loopback-equivalent trust boundary: the renderer can request any path
  // via this scheme, so every request is checked against a real track's
  // filepath (exact match, never a prefix check) before the filesystem is
  // touched — closed by construction against "../" traversal. Range-request
  // support (206 Partial Content) is required for the <audio> element to
  // be able to seek.
  protocol.handle('audio', async (request) => {
    const filePath = new URL(request.url).searchParams.get('path')

    if (!filePath || !getTrackByFilepath(filePath)) {
      return new Response(null, { status: 403 })
    }

    let fileSize: number
    try {
      fileSize = (await stat(filePath)).size
    } catch {
      return new Response(null, { status: 404 })
    }

    const mime = AUDIO_MIME[extname(filePath).toLowerCase()] ?? 'audio/mpeg'
    const range = request.headers.get('range')

    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-')
      const start = parseInt(s, 10)
      const end = e ? parseInt(e, 10) : fileSize - 1
      const length = end - start + 1

      // A Node Readable piped through Readable.toWeb() as the Response body
      // silently fails to reach Chromium's media pipeline here (the <audio>
      // element reports MEDIA_ERR_SRC_NOT_SUPPORTED even though the handler
      // runs clean) — reading the exact byte range into a Buffer up front,
      // like the artwork handler already does for whole files, sidesteps
      // that Node-stream/Chromium-fetch interop gap entirely.
      const buffer = Buffer.alloc(length)
      const handle = await open(filePath, 'r')
      try {
        await handle.read(buffer, 0, length, start)
      } finally {
        await handle.close()
      }

      return new Response(buffer, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(length),
          'Content-Type': mime
        }
      })
    }

    const data = await readFile(filePath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': mime,
        'Accept-Ranges': 'bytes'
      }
    })
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Dialog Actions

  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select your music folder'
    })

    if (result.canceled) return null
    console.log(result)
    return result.filePaths[0]
  })

  // ── Tracks ──────────────────────────────────────────────
  ipcMain.handle(
    'library:import-folder',
    async (event, folderPath: string, importSeratoData?: boolean, rescan?: boolean) => {
      try {
        // Register as root if not already nested — done BEFORE the import
        // (not after) so runFolderImport has a library_root row to resolve
        // folder_id against via ensureFolderTree. 'already-covered' (a re-scan
        // of an already-registered root or one of its subfolders) falls
        // through to import same as 'registered' — only 'conflict' (this
        // folder is a PARENT of an already-registered root) refuses, since
        // silently merging two roots isn't a decision to make here.
        const registerResult = registerLibraryRoot(folderPath)
        if (registerResult.status === 'conflict') {
          const names = registerResult.conflictingRoots.map((r) => r.name).join(', ')
          return {
            ok: false,
            error: `This folder already contains a registered library folder (${names}) — import that folder directly instead of its parent.`
          }
        }

        const result = await runFolderImport(
          event,
          folderPath,
          undefined,
          importSeratoData,
          rescan ?? false
        )

        return { ok: true, ...result }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // ── Auth ────────────────────────────────────────────────────────────
  // Every handler returns the full AuthState rather than a partial update,
  // so the renderer has exactly one shape to reduce over and cannot drift
  // out of sync with main. Tokens are never in it — see AuthState.
  ipcMain.handle('auth:state', () => getAuthState())

  ipcMain.handle('auth:sign-in', () => signInInBrowser())
  ipcMain.handle('auth:create-account', () => createAccountInBrowser())
  ipcMain.handle('auth:cancel-sign-in', () => ({ ok: true, state: cancelBrowserAuth() }))
  ipcMain.handle('auth:reopen-browser', () => reopenAuthBrowser())
  ipcMain.handle('auth:open-destination', (_e, destination: AuthDestination) => {
    if (!['signIn', 'createAccount', 'passwordReset', 'account', 'portal'].includes(destination)) {
      return { ok: false, error: 'Unknown account website destination.' }
    }
    return openAuthDestination(destination)
  })

  // Scheme-guarded on purpose. The renderer is ours, but "open whatever URL
  // you are handed" is a capability worth narrowing regardless — file:// and
  // custom schemes can launch local handlers, and this only ever needs to
  // open a web page.
  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: 'Only http(s) links can be opened.' }
      }
      await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('auth:sign-out', async () => ({ ok: true, state: await signOut() }))
  ipcMain.handle('auth:refresh', async () => ({ ok: true, state: await refreshAccountState() }))

  // Rescan every registered root, one after another. Sequential on purpose:
  // each root's scan already saturates the disk and the sidecar pool, and
  // runFolderImport stops that root's watcher for the duration — running
  // them concurrently would just trade throughput for EMFILE risk.
  //
  // A root whose volume is not mounted is skipped rather than failed: a DJ
  // with an external drive unplugged should still get a clean rescan of
  // everything that IS attached, and the skipped roots are reported back so
  // the renderer can say which were left out.
  // Stops the Phase 2 analysis pass after the batch currently in flight.
  // Safe to call when nothing is running — the flag is cleared at the start
  // of every run, so a stale stop cannot kill the next one.
  // Dev only. In a packaged app the bundles cannot change under a running
  // process, so this would be answering a question nobody can ask.
  ipcMain.handle('app:build-status', () =>
    is.dev ? checkBuildStatus() : { stale: false, changed: [] }
  )

  ipcMain.handle('analysis:stop', () => {
    requestPhase2Stop()
    return { ok: true }
  })

  ipcMain.handle('library:rescan', async (event) => {
    try {
      const roots = getAllRoots()
      if (roots.length === 0) return { ok: false, error: 'No library folders registered yet.' }

      let imported = 0
      let unchanged = 0
      let relinked = 0
      let swept = 0
      let total = 0
      const skippedRoots: string[] = []

      for (const root of roots) {
        try {
          await stat(root.path)
        } catch {
          skippedRoots.push(root.name)
          continue
        }

        const result = await runFolderImport(event, root.path, undefined, false, true)
        imported += result.imported
        total += result.total
        unchanged += result.unchanged ?? 0
        relinked += result.relinked ?? 0
        swept += result.swept ?? 0
      }

      return {
        ok: true,
        roots: roots.length - skippedRoots.length,
        skippedRoots,
        imported,
        unchanged,
        relinked,
        swept,
        total
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Read-only pre-check the renderer calls before showing the "Import
  // Serato data from this library" checkbox — never creates `_Serato_`,
  // just reports whether one is already there for this folder's volume.
  ipcMain.handle('serato:detect-for-folder', (_e, folderPath: string) => {
    const location = detectSeratoLibrary(folderPath, getSetting('serato_library_override'))
    return location ? { found: true, seratoDir: location.seratoDir } : { found: false }
  })

  ipcMain.handle('import:cancel', (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || job.type !== 'import')
      return { ok: false, error: 'Unknown or already-finished job' }
    job.cancelRequested = true
    return { ok: true }
  })

  ipcMain.handle('import:resume', async (event, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || job.type !== 'import') {
      return {
        ok: false,
        error: 'Job not found — in-memory resume does not survive an app restart'
      }
    }
    job.cancelRequested = false
    try {
      const result = await runFolderImport(event, job.folderPath, jobId)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  async function importSingleFile(
    event: Electron.IpcMainInvokeEvent,
    filepath: string
  ): Promise<{ ok: boolean; trackId?: number; error?: string }> {
    try {
      // Phase 1
      const fastResult = await readTagsFast(filepath)
      const singleStat = await stat(filepath).catch(() => null)

      // Resolve the file against a registered root if it lives under one.
      // Without this a dropped file came in with folder_id null: it appeared
      // in All Tracks and NOWHERE in Folders, and no folders:changed fired,
      // so the Folders view stayed stale until the app was reloaded.
      //
      // Returns null when the file is outside every library folder, which is
      // still a valid import — it just has no folder to belong to. Dropping
      // one file does not register its parent directory as a watched folder;
      // that would turn a single track dragged out of ~/Downloads into a
      // watched library of everything in there.
      const folderId = ensureFolderForDirectory(dirname(filepath))

      const trackData = buildTrackData(
        filepath,
        fastResult,
        folderId,
        singleStat ? normalizeMtime(singleStat.mtimeMs) : null
      )

      // Same reconcile chance runFolderImport's Pass 2 and the live
      // watcher's onFileAdded get. No root to scope the missing pool by
      // here — this is the manual dialog-import path (also what the
      // EmptyView/Board Finder-drop targets call per file) — so this
      // checks every missing track in the library, not just one root's.
      const match = await findReconcileMatch(
        {
          filepath,
          filename: trackData.filename,
          client_uuid: trackData.client_uuid,
          file_size_bytes: trackData.file_size_bytes,
          duration_sec: trackData.duration_sec
        },
        getMissingTracks()
      )

      let trackId: number
      if (match) {
        // relinkTrack repoints filepath; updateTrackFilepath inside it
        // recomputes folder_id from the new path, so the folder follows the
        // file here the same way it does for a move.
        relinkTrack(match.id, filepath)
        trackId = match.id
        console.log(`[import] relinked via reconcile: ${match.filepath} → ${filepath}`)
      } else {
        const partialHash = await computePartialHash(filepath)
        const insertResult = insertTrack({ ...trackData, partial_hash: partialHash }) as {
          lastInsertRowid: number | bigint
          wasInserted: boolean
        }
        trackId = Number(insertResult.lastInsertRowid)

        if (fastResult.artwork_base64 && trackId > 0) {
          const hash = await storeArtwork(Buffer.from(fastResult.artwork_base64, 'base64'))
          if (hash) setTrackArtworkHash(trackId, hash)
        }
        if (insertResult.wasInserted && trackId > 0) processNewArtists([trackId])
      }

      // Tell renderer the track exists so it can refresh the list
      event.sender.send('library:import-progress', {
        done: 1,
        total: 1,
        failed: 0,
        filepath: basename(filepath)
      })

      // And that a folder's track count moved. ensureFolderTree above only
      // emits when it CREATES a folder row, so importing into a folder that
      // already exists would otherwise leave every count stale until reload.
      if (folderId !== null) notifyFoldersChanged()

      // Phase 2 - analyze this one file immediately
      // Single file is fast enough to do inline
      const fullResult = await analyzeFile(filepath)
      recordAnalysisOutcome(event.sender, trackId, fullResult)

      if (fullResult.success) {
        updateTrackAnalysis(trackId, fullResult)

        event.sender.send('library:track-analyzed', {
          trackId,
          bpm: fullResult.bpm,
          key_camelot: fullResult.key_camelot,
          key_full: fullResult.key_full,
          duration_sec: fullResult.duration_sec,
          duration_str: fullResult.duration_str,
          done: 1,
          total: 1
        })
      }

      return { ok: true, trackId }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  ipcMain.handle('library:import-file', async (event, filepath: string) => {
    return importSingleFile(event, filepath)
  })

  // Drag-and-drop from Finder into a specific folder — copies every dropped
  // path into destAbsolutePath (never a rename: the DJ's source must
  // survive), then imports via the exact same handlers the dialogs use:
  // importSingleFile per copied file, or a re-scan of the destination
  // folder if any dropped item was a directory (so ensureFolderTree picks
  // up the new subtree). The 'done' progress event isn't emitted until
  // that import step finishes too, so the renderer's completion handler
  // can safely refetch tracks right then.
  async function runCopyIntoFolderJob(
    event: Electron.IpcMainInvokeEvent,
    job: CopyJob,
    sourcePaths: string[],
    currentFolderPath: string
  ): Promise<void> {
    job.status = 'running'

    // Build the plan — a dropped directory expands to every file in its
    // tree, preserving its structure under destAbsolutePath/<dirName>/...
    for (const sourcePath of sourcePaths) {
      let sourceStat
      try {
        sourceStat = await stat(sourcePath)
      } catch {
        job.failed.push({ sourcePath, error: 'Source no longer exists' })
        continue
      }
      if (sourceStat.isDirectory()) {
        job.hadDirectory = true
        const dirName = basename(sourcePath)
        const files = await collectFilesRecursive(sourcePath)
        for (const file of files) {
          job.plan.push({
            source: file,
            dest: join(job.destAbsolutePath, dirName, relative(sourcePath, file))
          })
        }
      } else {
        job.plan.push({
          source: sourcePath,
          dest: join(job.destAbsolutePath, basename(sourcePath))
        })
      }
    }

    maybeEmitCopyProgress(event, job, true) // total is known now

    for (const { source, dest } of job.plan) {
      if (job.cancelRequested) {
        job.status = 'cancelled'
        maybeEmitCopyProgress(event, job, true)
        jobs.delete(job.id)
        return
      }

      await mkdir(dirname(dest), { recursive: true })
      const ok = await copyOneFileIntoFolder(job, source, dest)
      if (ok) job.copiedFilePaths.push(dest)
      job.doneCount++
      job.currentFile = ''
      job.bytesCopied = 0
      job.totalBytes = 0
      maybeEmitCopyProgress(event, job, true)
    }

    // Copying is done — now import, via the same handlers the dialogs use.
    // Held until after this so the renderer's 'done' handler can safely
    // refetch tracks knowing the import actually finished too.
    if (job.hadDirectory) {
      await runFolderImport(event, currentFolderPath)
    } else {
      for (const path of job.copiedFilePaths) {
        await importSingleFile(event, path)
      }
    }

    job.status = 'done'
    maybeEmitCopyProgress(event, job, true)
    jobs.delete(job.id)
  }

  ipcMain.handle(
    'fs:copy-into-folder',
    (
      event,
      payload: {
        sourcePaths: string[]
        destAbsolutePath: string
        currentFolderPath: string
        deleteSource?: boolean
      }
    ) => {
      const job: CopyJob = {
        type: 'copy',
        id: randomUUID(),
        destAbsolutePath: payload.destAbsolutePath,
        plan: [],
        hadDirectory: false,
        cancelRequested: false,
        status: 'running',
        doneCount: 0,
        currentFile: '',
        bytesCopied: 0,
        totalBytes: 0,
        failed: [],
        copiedFilePaths: [],
        lastEmitAt: 0,
        deleteSource: payload.deleteSource ?? false
      }
      jobs.set(job.id, job)
      runCopyIntoFolderJob(event, job, payload.sourcePaths, payload.currentFolderPath) // fire-and-forget
      return { jobId: job.id }
    }
  )

  ipcMain.handle('fs:cancel-copy', (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || job.type !== 'copy') {
      return { ok: false, error: 'Unknown or already-finished job' }
    }
    job.cancelRequested = true
    return { ok: true }
  })

  // ── Finder/Explorer integration ─────────────────────────────────────────────
  // shell.showItemInFolder returns void and stays silent when the path does
  // not exist — Finder simply never opens. A missing file is the common case
  // here (the row is still in the library, the file moved), so it is checked
  // first and reported rather than looking like a dead button.
  ipcMain.handle('fs:show-in-folder', async (_event, filepath: string) => {
    try {
      if (!filepath) return { ok: false, error: 'This track has no file path.' }
      await stat(filepath)
      shell.showItemInFolder(filepath)
      return { ok: true }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { ok: false, error: 'The file is no longer at that location.' }
      }
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Multi file import ────────────────────────────────────

  ipcMain.handle('library:import-files', async (event, filepaths: string[]) => {
    const results: Awaited<ReturnType<typeof importSingleFile>>[] = []
    for (const filepath of filepaths) {
      results.push(await importSingleFile(event, filepath))
    }
    return { ok: true, count: filepaths.length, results }
  })

  ipcMain.handle('dialog:open-files', async () => {
    if (!mainWindow) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add tracks',
      filters: [
        {
          name: 'Audio',
          extensions: ['mp3', 'flac', 'wav', 'aiff', 'aif', 'm4a', 'ogg']
        }
      ]
    })
    return canceled ? [] : filePaths
  })

  ipcMain.handle('db:all-tracks', () => getAllTracks())

  // Crate Health. Read-only counts and fix-queue ids; the renderer resolves
  // ids against its own track store. The id is validated here because it
  // crosses IPC.
  ipcMain.handle('health:summary', () => getHealthSummary())
  ipcMain.handle('health:queue', (_e, checkId: unknown) => {
    if (!isHealthCheckId(checkId)) throw new Error('Unknown health check')
    return getHealthQueue(checkId)
  })

  ipcMain.handle('db:track-by-id', (_e, id: number) => getTrackById(id))

  ipcMain.handle('db:tracks-by-ids', (_e, ids: number[]) => getTracksByIds(ids))

  // ── Artwork ────────────────────────────────────────────
  ipcMain.handle('artwork:path-for', (_e, hash: string | null, size: 'full' | 'thumb') =>
    artworkPathFor(hash, size)
  )

  // Lets the user set a cover from an image file, for one track or for a
  // whole selection. Stores it content-addressed like embedded art, so
  // picking the same image for fifty tracks costs ONE file on disk and
  // fifty rows pointing at it — which is what makes the bulk case cheap
  // rather than fifty copies of the same JPEG.
  //
  // Sets artwork_hash in the DB only; the audio files' embedded pictures are
  // not touched. No `error` on a failed result means the dialog was
  // cancelled.
  ipcMain.handle(
    'artwork:pick',
    async (
      _e,
      target: number | number[]
    ): Promise<{ ok: boolean; hash?: string; applied?: number; error?: string }> => {
      if (!mainWindow) return { ok: false }

      const trackIds = Array.isArray(target) ? target : [target]
      if (trackIds.length === 0) return { ok: false, error: 'No tracks selected.' }

      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title:
          trackIds.length === 1
            ? 'Choose album artwork'
            : `Choose album artwork for ${trackIds.length} tracks`,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
      })
      if (canceled || filePaths.length === 0) return { ok: false }

      try {
        const bytes = await readFile(filePaths[0])
        if (nativeImage.createFromBuffer(bytes).isEmpty()) {
          return { ok: false, error: 'That file is not a valid JPEG or PNG image.' }
        }
        // Stored once, whatever the selection size.
        const hash = await storeArtwork(bytes)
        if (!hash) return { ok: false, error: 'Could not save the artwork.' }

        for (const id of trackIds) setTrackArtworkHash(id, hash)

        return { ok: true, hash, applied: trackIds.length }
      } catch (err) {
        console.error('artwork:pick failed:', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // TODO: surface in Settings as a manual "Clean up" action
  ipcMain.handle('artwork:sweep-orphaned', () => sweepOrphanedArtwork())

  ipcMain.handle('db:insert-track', (_e, track: Record<string, unknown>) => {
    try {
      const result = insertTrack(track) as { lastInsertRowid: number | bigint; wasInserted: boolean }
      const id = Number(result.lastInsertRowid)
      if (result.wasInserted && id > 0) processNewArtists([id])
      return { ok: true, id }
    } catch (err) {
      console.error('db:insert-track failed:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('db:update-track-meta', (_e, data: Record<string, unknown>) => {
    try {
      updateTrackMeta(data)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('db:update-board-id', (_e, id: number, boardId: number) => {
    try {
      updateBoardId(id, boardId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('db:tracks-by-board-id', (_e, boardId: number) => getTracksByBoardId(boardId))

  ipcMain.handle('db:mark-missing', (_e, filepath: string) => {
    try {
      markTrackMissing(filepath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // deleteFile moves the audio file to the OS Trash (recoverable) before
  // dropping the DB row. An ENOENT (file already gone from disk) is not
  // treated as failure — the desired end state already holds — but any
  // other trash error (permissions, file in use) aborts before touching the
  // DB, so a track never silently disappears from DeepCrated while its file
  // is left behind untouched.
  ipcMain.handle('db:delete-track', async (_e, id: number, deleteFile: boolean) => {
    try {
      const track = getTrackById(id)
      if (!track) return { ok: false, error: 'Track not found' }
      if (deleteFile) {
        try {
          await shell.trashItem(track.filepath)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT') {
            return { ok: false, error: `Could not delete file: ${(err as Error).message}` }
          }
        }
      }
      deleteTrack(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // trackId is optional and only used to address the progress events: with
  // one, the renderer can show the analysis running on that track's card (see
  // TrackCard's progress bar); without one, this behaves exactly as before and
  // emits nothing. The final 'done' stage comes from analyze.py itself, and
  // the renderer clears the bar when the invoke resolves, so a failed or
  // crashed analysis cannot leave a bar stuck on a card.
  ipcMain.handle('sidecar:analyze', async (event, filepath: string, trackId?: number) => {
    const onProgress =
      trackId === undefined
        ? undefined
        : (stage: AnalysisStage): void => {
            if (event.sender.isDestroyed()) return
            event.sender.send('analysis:file-progress', { trackId, filepath, ...stage })
          }

    try {
      const result = await analyzeFile(filepath, onProgress)
      // Only a track the caller named can be recorded against. The returned
      // data carries analysis_issue either way, so the renderer can show it.
      if (trackId !== undefined) recordAnalysisOutcome(event.sender, trackId, result)
      return { ok: true, data: result }
    } catch (err) {
      console.error('sidecar:analyze failed:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  // Job-based, like move/copy/export — resolves immediately with a jobId;
  // progress comes over edit-tags:progress. Does not touch the DB; see the
  // TODO on runEditTagsJob.
  ipcMain.handle(
    'sidecar:edit-tags-batch',
    (event, items: EditTagsBatchItem[], options?: { writeSerato?: boolean }) => {
      const job: EditTagsJob = {
        type: 'editTags',
        id: randomUUID(),
        total: items.length,
        doneCount: 0,
        currentFile: '',
        status: 'running',
        failed: []
      }
      jobs.set(job.id, job)
      runEditTagsJob(event, job, items, options?.writeSerato ?? true) // fire-and-forget — progress goes out over edit-tags:progress
      return { jobId: job.id }
    }
  )

  // ── Move files to a folder (job-based — see MoveJob/runMoveJob above) ──

  function createMoveJob(trackIds: number[], destAbsolutePath: string): MoveJob {
    return {
      type: 'move',
      id: randomUUID(),
      trackIds,
      destAbsolutePath,
      cancelRequested: false,
      status: 'running',
      doneCount: 0,
      currentFile: '',
      bytesCopied: 0,
      totalBytes: 0,
      crossDevice: false,
      failed: [],
      lastEmitAt: 0
    }
  }

  function startMoveJob(
    event: Electron.IpcMainInvokeEvent,
    trackIds: number[],
    destAbsolutePath: string
  ): string {
    const job = createMoveJob(trackIds, destAbsolutePath)
    jobs.set(job.id, job)
    runMoveJob(event, job) // fire-and-forget — progress goes out over move:progress
    return job.id
  }

  ipcMain.handle(
    'fs:move-files',
    (event, payload: { trackIds: number[]; destAbsolutePath: string }) => {
      return { jobId: startMoveJob(event, payload.trackIds, payload.destAbsolutePath) }
    }
  )

  // Thin wrapper around fs:move-files for a single file — same input
  // signature as before, but now returns a jobId instead of a final result
  // (moves are async jobs now; MoveFileButton listens for move:progress).
  ipcMain.handle('fs:move-file', (event, fromPath: string, toFolder: string) => {
    const track = getTrackByFilepath(fromPath)
    if (!track) return { ok: false, error: 'Track not found for this file' }
    return { ok: true, jobId: startMoveJob(event, [track.id], toFolder) }
  })

  ipcMain.handle('fs:cancel-move', (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job || job.type !== 'move') {
      return { ok: false, error: 'Unknown or already-finished job' }
    }
    job.cancelRequested = true
    return { ok: true }
  })

  // Pre-move check for the renderer's confirm dialog — one stat on the
  // destination, one per source file. Re-stats rather than reading
  // file_size_bytes off the track row: this needs live st_dev too (for
  // crossDevice), which isn't something the DB tracks at all.
  ipcMain.handle('fs:is-cross-device', async (_e, filepaths: string[], destPath: string) => {
    try {
      const destStat = await stat(destPath)
      let totalBytes = 0
      let crossDevice = false
      for (const filepath of filepaths) {
        const s = await stat(filepath)
        totalBytes += s.size
        if (s.dev !== destStat.dev) crossDevice = true
      }
      return { ok: true, crossDevice, totalBytes }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Rename a file on disk ────────────────────────────────

  ipcMain.handle('fs:rename-file', async (_e, filepath: string, newName: string) => {
    try {
      // Validate newName — no path separators, no empty string
      if (!newName.trim()) {
        return { ok: false, error: 'Name cannot be empty' }
      }
      if (newName.includes('/') || newName.includes('\\')) {
        return { ok: false, error: 'Name cannot contain slashes' }
      }

      const dir = dirname(filepath)
      const ext = extname(filepath)
      const newPath = join(dir, newName + ext)

      // Check for collision
      try {
        await stat(newPath)
        return { ok: false, error: 'A file with that name already exists' }
      } catch {
        // Good — file does not exist
      }

      await rename(filepath, newPath)

      // Update DB
      updateTrackFilepath(filepath, newPath)

      // Update title in DB to match new filename
      const track = getTrackByFilepath(newPath) as Track | undefined
      if (track) {
        updateTrackMeta({
          id: track.id,
          title: newName,
          artist: track.artist,
          genre: track.genre,
          bpm: track.bpm,
          key_camelot: track.key_camelot,
          energy: track.energy,
          comment: track.comment,
          artwork_path: track.artwork_path,
          needs_sync: track.needs_sync,
          pending_changes: track.pending_changes
        })
      }

      return { ok: true, newPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Update File Metadata ──────────────────────────────────
  // TagInput (per tag-field writes) and the Inspector's saveField both fire
  // independent, un-awaited writeTags calls for the same track. Each spawns
  // its own edit_tags.py process that copies the file, edits the copy, then
  // atomically replaces the original — so two calls racing on the same file
  // can interleave: whichever process's replace lands last wins outright,
  // silently discarding the other's edit (its copy was taken before the
  // first process committed, so nothing it wrote could have included that
  // change). Serializing here per filepath ensures each write starts only
  // after the previous write to that same file has fully landed on disk.
  ipcMain.handle(
    'sidecar:write-tags',
    async (_e, filepath: string, meta: Record<string, unknown>) => {
      try {
        const results = await writeTagsForFile(filepath, meta)
        return { ok: true, results }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // ── Create a new folder ──────────────────────────────────

  // ── Deleting a folder ──────────────────────────────────────────────────
  // Two modes, and the difference is the whole point of the dialog above it:
  //
  //   'library'  folder rows only. Files are not touched. Tracks survive,
  //              unfiled, with every tag/crate/stage intact — that is
  //              tracks.folder_id's ON DELETE SET NULL doing the work.
  //   'trash'    the directory goes to the OS Trash (recoverable from
  //              Finder), and the track rows go with it, since rows whose
  //              files have been trashed are only a library full of dead
  //              entries.
  //
  // shell.trashItem, never rm -rf: this is the same call db:delete-track
  // already uses, and a mis-clicked folder is a DJ's music.
  ipcMain.handle('fs:move-folder-tracks-to-parent', (event, folderId: number) => {
    try {
      const folder = getFolderTree().find((f) => f.id === folderId)
      if (!folder?.path) return { ok: false, error: 'Folder not found or has no disk path' }
      const tracks = getTracksByFolder(folderId, true)
      if (tracks.length === 0) return { ok: false, error: 'This folder has no tracks to move' }
      const trackIds = tracks.map((track) => track.id)
      const jobId = startMoveJob(event, trackIds, dirname(folder.path))
      return { ok: true, jobId, trackIds }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'fs:delete-folder',
    async (_e, folderId: number, mode: 'library' | 'trash') => {
      let stoppedRoot: ReturnType<typeof getAllRoots>[number] | undefined
      let pathTrashed = false
      try {
        const folder = getFolderTree().find((f) => f.id === folderId)
        if (!folder) return { ok: false, error: 'Folder not found' }
        const isRoot = folder.parent_folder_id == null
        const root = isRoot ? getAllRoots().find((r) => r.id === folder.root_folder_id) : undefined
        if (isRoot && !root) return { ok: false, error: 'Watched folder registration not found' }
        if (mode === 'trash' && !folder.path) return { ok: false, error: 'Folder has no path on disk' }

        if (isRoot && root) {
          await stopWatcher(root.id)
          stoppedRoot = root
        }

        if (mode === 'trash') {
          try {
            await shell.trashItem(folder.path!)
            pathTrashed = true
          } catch (err) {
            // Already gone is a success for our purposes — the rows still
            // need clearing, which is what the caller actually wanted.
            const code = (err as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
              pathTrashed = true
            } else {
              console.error('[folders] trashItem failed for', folder.path, err)
              if (stoppedRoot) startWatcher(stoppedRoot.id, stoppedRoot.path)
              stoppedRoot = undefined
              return { ok: false, error: `Could not move to Trash: ${(err as Error).message}` }
            }
          }
        }

        const removed = deleteFolderCascade(folderId, { deleteTracks: mode === 'trash' })
        if (isRoot && root) removeRoot(root.id)
        return { ok: true, ...removed }
      } catch (err) {
        // Restart only if the filesystem operation did not already move the
        // watched directory to Trash.
        if (stoppedRoot && !pathTrashed) startWatcher(stoppedRoot.id, stoppedRoot.path)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  // ── Rename a folder ────────────────────────────────────────────────────
  // The disk-and-database half lives in folderRename.ts so it can be tested
  // against real files. What stays here is the part a test has no use for:
  // stopping and restarting chokidar around the move.
  ipcMain.handle('fs:rename-folder', async (_e, folderId: number, newName: string) => {
    const planned = planFolderRename(folderId, newName)
    if (!planned.ok) return { ok: false, error: planned.error }
    if (!planned.plan) return { ok: true, renamed: false }

    const plan = planned.plan

    // A watched folder's watcher is attached to the old directory. Left
    // running through the rename it would fire unlinkDir for the whole tree
    // as it disappears, and onDirRemoved marks every track under it missing.
    if (plan.isRoot && plan.rootId != null) await stopWatcher(plan.rootId)

    const result = await applyFolderRename(plan)

    if (plan.isRoot && plan.rootId != null) {
      // Back on the old path if it failed — a failed rename must not leave
      // the library unwatched.
      startWatcher(plan.rootId, result.ok ? plan.newPath : plan.oldPath)
    }

    return result.ok ? { ...result, renamed: true } : result
  })

  // ── Rename files from the template ─────────────────────────────────────
  // Dry run by default: `apply: false` returns exactly what WOULD happen, so
  // the modal can show it before anything is touched. Renaming is the one
  // action in this app a DJ cannot undo from inside it.
  ipcMain.handle(
    'fs:rename-from-template',
    async (
      _e,
      payload: { trackIds: number[]; template: string; apply: boolean }
    ): Promise<{
      ok: boolean
      error?: string
      results?: {
        trackId: number
        from: string
        to?: string
        status: 'renamed' | 'unchanged' | 'skipped' | 'failed'
        reason?: string
      }[]
    }> => {
      try {
        const results: {
          trackId: number
          from: string
          to?: string
          status: 'renamed' | 'unchanged' | 'skipped' | 'failed'
          reason?: string
        }[] = []

        // Names claimed earlier in THIS run, so two tracks resolving to the
        // same name inside one batch do not collide with each other — the
        // directory listing alone cannot see a rename that has not happened
        // yet in a dry run.
        const claimed = new Map<string, Set<string>>()

        for (const trackId of payload.trackIds) {
          const track = getTrackById(trackId)
          if (!track?.filepath) {
            results.push({ trackId, from: '', status: 'failed', reason: 'Track not found' })
            continue
          }

          const from = track.filepath
          const dir = dirname(from)
          const ext = extname(from)

          const built = buildFilename(payload.template, track as TemplateTrack)
          if (!built.ok) {
            results.push({ trackId, from, status: 'skipped', reason: built.reason })
            continue
          }

          const wanted = `${built.name}${ext}`
          if (wanted === basename(from)) {
            results.push({ trackId, from, to: from, status: 'unchanged' })
            continue
          }

          let existing: Set<string>
          try {
            existing = new Set(await readdir(dir))
          } catch {
            existing = new Set()
          }
          // The file's own current name is not a collision with itself.
          existing.delete(basename(from))
          for (const name of claimed.get(dir) ?? []) existing.add(name)

          const finalName = resolveCollisionName(wanted, (c) => existing.has(c))
          if (!finalName) {
            results.push({
              trackId,
              from,
              status: 'failed',
              reason: `Too many files named like "${wanted}"`
            })
            continue
          }

          const to = join(dir, finalName)
          if (!claimed.has(dir)) claimed.set(dir, new Set())
          claimed.get(dir)!.add(finalName)

          if (!payload.apply) {
            results.push({ trackId, from, to, status: 'renamed' })
            continue
          }

          expectMove(from, to)
          try {
            await rename(from, to)
          } catch (err) {
            cancelExpectation(from, to)
            results.push({ trackId, from, status: 'failed', reason: (err as Error).message })
            continue
          }

          // Only the path changes. Deliberately NOT updateTrackMeta with
          // title: the unused fs:rename-file did that, and it overwrites a
          // track's title with its filename — backwards for templating, where
          // the title is what produced the name.
          updateTrackFilepath(from, to)
          results.push({ trackId, from, to, status: 'renamed' })
        }

        return { ok: true, results }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('fs:create-folder', async (_e, parentPath: string, folderName: string) => {
    try {
      if (!folderName.trim()) {
        return { ok: false, error: 'Folder name cannot be empty' }
      }

      const newFolderPath = join(parentPath, folderName)

      // Check for collision
      try {
        await stat(newFolderPath)
        return { ok: false, error: 'A folder with that name already exists' }
      } catch {
        // Good — does not exist
      }

      await mkdir(newFolderPath, { recursive: false })

      // Mirror the new directory into `folders` if it's under a registered
      // root — same self-healing ensureFolderTree call updateTrackFilepath
      // uses for a moved track. Without this, the folder is invisible to
      // FolderView until a full re-import walks it. ensureFolderTree emits
      // folderEvents' 'changed' itself when it inserts a row, forwarded to
      // the renderer as 'folders:changed' — a plain mkdir has no effect on
      // `tracks`, so (unlike a move) nothing else would trigger a refetch.
      const folderId = ensureFolderForDirectory(newFolderPath)

      return {
        ok: true,
        path: newFolderPath,
        folderId,
        reason:
          folderId === null
            ? "Not under a registered library root — this folder won't appear in the library tree"
            : undefined
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Classify dropped paths (drag-and-drop from Finder) ────
  // The renderer never guesses a drop's kind from the filename — it always
  // asks main, which knows the real supported-extensions list.
  ipcMain.handle('fs:classify-paths', async (_e, paths: string[]) => {
    const results: { path: string; kind: 'dir' | 'audio' | 'other' }[] = []
    for (const p of paths) {
      try {
        const s = await stat(p)
        if (s.isDirectory()) {
          results.push({ path: p, kind: 'dir' })
        } else if (AUDIO_EXTENSIONS.has(extname(p).toLowerCase())) {
          results.push({ path: p, kind: 'audio' })
        } else {
          results.push({ path: p, kind: 'other' })
        }
      } catch {
        results.push({ path: p, kind: 'other' })
      }
    }
    return results
  })

  // ── Read folder contents ─────────────────────────────────

  ipcMain.handle('fs:read-folder', async (_e, folderPath: string) => {
    try {
      const entries = await readdir(folderPath, { withFileTypes: true })

      const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg'])

      const rawItems = await Promise.all(
        entries
          .filter((e) => {
            if (e.name.startsWith('.')) return false // skip hidden files/folders (e.g. macOS ._ AppleDouble files, .DS_Store)
            // Include directories and audio files only
            if (e.isDirectory()) return true
            return AUDIO_EXT.has(extname(e.name).toLowerCase())
          })
          .map(async (e) => {
            const fullPath = join(folderPath, e.name)
            const s = await stat(fullPath)

            if (e.isDirectory()) {
              // Skip folders with no audio anywhere in their subtree
              const audioCount = await countAudioFiles(fullPath)
              if (audioCount === 0) return null

              return {
                name: e.name,
                path: fullPath,
                isDirectory: true,
                size: s.size,
                modified: s.mtimeMs,
                audioCount
              }
            }

            // Already filtered to audio extensions above
            return {
              name: e.name,
              path: fullPath,
              isDirectory: false,
              size: s.size,
              modified: s.mtimeMs,
              audioCount: 1
            }
          })
      )

      const items = rawItems.filter((item): item is NonNullable<typeof item> => item !== null)

      // Folders first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })

      return { ok: true, items }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Tags ────────────────────────────────────────────────

  ipcMain.handle('tags:all', () => getAllTags())

  ipcMain.handle('tags:most-used', (_e, limit?: number) => getMostUsedTags(limit))

  ipcMain.handle('tags:for-track', (_e, trackId: number) => getTrackTags(trackId))

  ipcMain.handle('tags:for-tracks', (_e, trackIds: number[]) => getTrackTagsForTracks(trackIds))

  ipcMain.handle('tags:tracks-by-tag', (_e, tagId: number) => getTagTracks(tagId))

  // Replaces a track's tags for one field AND recomputes its derived column,
  // in a single transaction. Returns the derived value so the renderer can
  // write it to the file without reading back — and so the store and the row
  // can never disagree about what the column says.
  ipcMain.handle('tags:set-for-field', (_e, trackId: number, field: string, values: string[]) => {
    try {
      const derived = setTagsForField(trackId, field, values)
      return { ok: true, derived }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Renames a tag everywhere and re-derives every track carrying it. Merges
  // into an existing tag of the same field if the new value collides.
  // Removes a tag from the library entirely and re-derives every track that
  // carried it. Distinct from tags:remove, which only unlinks ONE track.
  ipcMain.handle('tags:delete', (_e, tagId: number) => {
    try {
      return { ok: true, ...deleteTagAndCascade(tagId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tags:rename', (_e, tagId: number, newValue: string) => {
    try {
      return { ok: true, ...renameTagAndCascade(tagId, newValue) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tags:find-or-create', (_e, field: string, value: string, color: string) => {
    try {
      const id = findOrCreateTag(field, value, color)
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tags:apply', (_e, trackId: number, tagId: number) => {
    try {
      applyTag(trackId, tagId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tags:remove', (_e, trackId: number, tagId: number) => {
    try {
      removeTag(trackId, tagId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tags:check-candidates', (_e, candidates: string[], field: string) =>
    checkCandidates(candidates, field)
  )

  ipcMain.handle(
    'tags:confirm-import',
    (_e, pendingId: number, trackId: number, approvedTags: string[], field: string) => {
      try {
        confirmPendingImport(pendingId, trackId, approvedTags, field)
        return { ok: true }
      } catch (err) {
        console.error('tags:comfirm-import failed', err)
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('tags:pending', () => getPendingImports())

  // ── Crates ──────────────────────────────────────────────

  ipcMain.handle('crates:all', () => getAllCrates())

  ipcMain.handle('crates:all-track-ids', () => getAllCrateTrackIds())

  ipcMain.handle(
    'crates:insert',
    (_e, name: string, parentCrateId: number | null, color: string) => {
      try {
        const id = insertCrate(name, parentCrateId, color)
        return { ok: true, id }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('crates:rename', (_e, id: number, name: string) => {
    try {
      renameCrate(id, name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:move-parent', (_e, id: number, parentCrateId: number | null) => {
    try {
      return moveCrateParent(id, parentCrateId)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:delete', (_e, id: number) => {
    try {
      deleteCrate(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:add-tracks', (_e, crateId: number, trackIds: number[]) => {
    try {
      addTracksToCrate(crateId, trackIds)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:remove-tracks', (_e, crateId: number, trackIds: number[]) => {
    try {
      removeTracksFromCrate(crateId, trackIds)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:tracks', (_e, crateId: number) => getCrateTracks(crateId))

  ipcMain.handle('crates:reorder', (_e, crateId: number, orderedTrackIds: number[]) => {
    try {
      reorderCrateTracks(crateId, orderedTrackIds)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('crates:is-serato-running', () => isSeratoRunning())

  ipcMain.handle('crates:export', (event, crateIds: number[]) => {
    const job: ExportJob = {
      type: 'export',
      id: randomUUID(),
      crateIds,
      status: 'running',
      doneCount: 0,
      currentCrateName: '',
      volumesWritten: 0,
      missingSkipped: 0,
      exportedCrateNames: [],
      failed: []
    }
    jobs.set(job.id, job)
    runExportJob(event, job) // fire-and-forget — progress goes out over crate-export:progress
    return { jobId: job.id }
  })

  // ── Library roots ────────────────────────────────────────

  ipcMain.handle('db:mark-analyzed', (_e, id: number) => {
    try {
      markTrackAnalyzed(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('roots:all', () => getAllRoots())

  ipcMain.handle('roots:add', async (event, folderPath: string, importSeratoData?: boolean) => {
    try {
      await stat(folderPath) // confirm it exists

      // Unlike library:import-folder, this handler's whole purpose is
      // registering a NEW root — nesting here is user error, not a re-scan,
      // so both 'already-covered' and 'conflict' refuse instead of falling
      // through to import.
      const registerResult = registerLibraryRoot(folderPath)
      if (registerResult.status === 'already-covered') {
        return { ok: false, error: 'This folder is already inside a registered library root' }
      }
      if (registerResult.status === 'conflict') {
        const names = registerResult.conflictingRoots.map((r) => r.name).join(', ')
        return {
          ok: false,
          error: `This folder already contains a registered library folder (${names}).`
        }
      }

      // Auto-import in background — same as clicking Import folder
      // Do not await — returns immediately so Settings modal stays responsive
      runFolderImport(event, folderPath, undefined, importSeratoData)

      return { ok: true, id: registerResult.rootId }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('roots:remove', (_e, id: number) => {
    try {
      removeRoot(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Folders ──────────────────────────────────────────────

  // One subscription covers every ensureFolderTree caller (import, watcher,
  // fs:create-folder, and a track move) — see folderEvents' comment in db.ts.
  folderEvents.on('changed', () => {
    mainWindow?.webContents.send('folders:changed', {})
  })

  ipcMain.handle('folders:tree', (_e, rootId?: number) => getFolderTree(rootId))

  ipcMain.handle('tracks:by-folder', (_e, folderId: number, recursive: boolean) =>
    getTracksByFolder(folderId, recursive)
  )

  ipcMain.handle('tracks:folder-counts', () => getFolderTrackCounts())

  // ── Boards ──────────────────────────────────────────────

  ipcMain.handle('boards:all', () => getAllBoards())

  ipcMain.handle('boards:tracks-by-column', (_e, column: string) => getTracksByColumn(column))

  // ── Settings ─────────────────────────────────────────────

  // Keys under the stats_ prefix (consent state, the anonymous install id)
  // are owned by the stats system and are not reachable from the renderer.
  ipcMain.handle('settings:get', (_e, key: string) =>
    isReservedSettingKey(key) ? null : getSetting(key)
  )

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    if (isReservedSettingKey(key)) return { ok: false, error: 'This setting is not writable' }
    try {
      setSetting(key, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Deleting a key that was never there is a no-op, not an error — a caller
  // tidying up after itself should not have to check first.
  ipcMain.handle('settings:delete', (_e, key: string) => {
    if (isReservedSettingKey(key)) return { ok: false, error: 'This setting is not writable' }
    try {
      deleteSetting(key)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Artist-name cleanup ──────────────────────────────────
  // Import-time cleanup runs from the import paths themselves
  // (processNewArtists). These handlers are the inbox and the re-clean.
  ipcMain.handle('artist:suggestions', () => ({
    groups: artistCleaner.suggestionGroups(),
    mode: artistCleaner.mode()
  }))

  const guard = async <T>(fn: () => Promise<T> | T): Promise<{ ok: true; result: T } | { ok: false; error: string }> => {
    try {
      return { ok: true, result: await fn() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  ipcMain.handle('artist:accept', (_e, raw: unknown) =>
    typeof raw === 'string' ? guard(() => artistCleaner.acceptGroup(raw)) : { ok: false, error: 'Invalid name' }
  )
  ipcMain.handle('artist:edit', (_e, raw: unknown, name: unknown) =>
    typeof raw === 'string' && typeof name === 'string'
      ? guard(() => artistCleaner.acceptGroup(raw, name))
      : { ok: false, error: 'Invalid name' }
  )
  ipcMain.handle('artist:keep', (_e, raw: unknown) =>
    typeof raw === 'string' ? guard(() => artistCleaner.keepGroup(raw)) : { ok: false, error: 'Invalid name' }
  )
  ipcMain.handle('artist:restore-original', (_e, trackId: unknown) =>
    Number.isInteger(trackId) ? artistCleaner.restoreOriginal(trackId as number) : { ok: false, error: 'Invalid track' }
  )
  ipcMain.handle('artist:reclean-preview', () => guard(() => artistCleaner.previewReclean()))
  ipcMain.handle('artist:reclean-approve-high', () => guard(() => artistCleaner.approveHigh()))
  ipcMain.handle('artist:reclean-queue-review', () => guard(() => artistCleaner.queueReview()))
  ipcMain.handle('artist:undo', () => guard(() => artistCleaner.undoLastBatch()))
  ipcMain.handle('artist:undo-info', () => artistCleaner.undoInfo())

  // ── Track identity (background backfill) ─────────────────
  ipcMain.handle('identity:get-status', () => getIdentityStatus())
  ipcMain.handle('identity:kick', () => {
    kickIdentity()
    return { ok: true }
  })

  // ── Privacy / anonymous stats ────────────────────────────
  // The renderer can read the consent state and flip it, and mark items
  // private. It never sees the install id or the queue, and there is no
  // channel for canCollect — collection is decided in main only.

  ipcMain.handle('privacy:get-consent', () => statsGetConsent())

  ipcMain.handle('privacy:set-consent', (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid value' }
    try {
      return { ok: true, state: statsSetConsent(enabled) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('privacy:set-track-private', (_e, trackIds: unknown, value: unknown) => {
    if (
      !Array.isArray(trackIds) ||
      !trackIds.every((id) => Number.isInteger(id)) ||
      typeof value !== 'boolean'
    ) {
      return { ok: false, error: 'Invalid arguments' }
    }
    try {
      statsSetTracksPrivate(trackIds as number[], value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('privacy:set-crate-private', (_e, crateId: unknown, value: unknown) => {
    if (!Number.isInteger(crateId) || typeof value !== 'boolean') {
      return { ok: false, error: 'Invalid arguments' }
    }
    try {
      statsSetCratePrivate(crateId as number, value)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Set up watcher callbacks ──────────────────────────────

  setWatcherCallbacks({
    // New file detected — auto-import it
    onFileAdded: async (filepath, rootId) => {
      try {
        // Check if already in DB
        const existing = getTrackByFilepath(filepath)
        if (existing) return

        // Fast tag read
        const result = await readTagsFast(filepath)
        if (!result.success) return

        // Resolve the containing directory to a folder id — idempotent and
        // cheap (one directory, not a whole-tree walk) since ensureFolderTree
        // reuses whatever's already registered under this root.
        let folderId: number | null = null
        const root = getAllRoots().find((r) => r.id === rootId)
        if (root) {
          const relDir = relative(root.path, dirname(filepath))
          folderId = ensureFolderTree(rootId, [relDir]).get(relDir) ?? null
        }

        // Stat here too, not just on the import walk, so a file the watcher
        // brought in participates in the rescan fast path immediately
        // instead of costing one redundant tag read on the next rescan.
        const info = await stat(filepath).catch(() => null)
        const trackData = buildTrackData(
          filepath,
          result,
          folderId,
          info ? normalizeMtime(info.mtimeMs) : null
        )

        // A single live add gets the same reconcile chance a batch import
        // would — findMoveCandidate (libraryWatcher.ts) already caught the
        // cheap "renamed within 2s, same filename" case before onFileAdded
        // was even called; this is the broader net for everything that
        // misses: filename changed, or the matching add arrived later than
        // that 2s window (a directory tree's per-file events can spread
        // out further than a single file's would).
        const match = await findReconcileMatch(
          {
            filepath,
            filename: trackData.filename,
            client_uuid: trackData.client_uuid,
            file_size_bytes: trackData.file_size_bytes,
            duration_sec: trackData.duration_sec
          },
          getMissingTracks(rootId)
        )

        if (match) {
          relinkTrack(match.id, filepath)

          insertPendingChange({
            root_id: rootId,
            change_type: 'moved',
            old_path: match.filepath,
            new_path: filepath,
            track_id: match.id
          })

          mainWindow?.webContents.send('watcher:track-moved', {
            trackId: match.id,
            oldPath: match.filepath,
            newPath: filepath
          })

          console.log(`[watcher] relinked via reconcile: ${match.filepath} → ${filepath}`)
          return
        }

        const partialHash = await computePartialHash(filepath)
        const insertResult = insertTrack({ ...trackData, partial_hash: partialHash }) as {
          lastInsertRowid: number | bigint
          wasInserted: boolean
        }
        const trackId = Number(insertResult.lastInsertRowid)

        if (result.artwork_base64 && trackId > 0) {
          const hash = await storeArtwork(Buffer.from(result.artwork_base64, 'base64'))
          if (hash) setTrackArtworkHash(trackId, hash)
        }
        if (insertResult.wasInserted && trackId > 0) processNewArtists([trackId])

        // Queue as pending change for DJ to review
        insertPendingChange({
          root_id: rootId,
          change_type: 'added',
          old_path: null,
          new_path: filepath,
          track_id: trackId
        })

        // Tell renderer a new track arrived
        mainWindow?.webContents.send('watcher:track-added', {
          trackId,
          filepath
        })

        console.log(`[watcher] auto-imported: ${filepath}`)
      } catch (err) {
        console.error('[watcher] onFileAdded error:', err)
      }
    },

    // File moved — update filepath in DB
    onFileMoved: async (oldPath, newPath, rootId) => {
      try {
        const track = getTrackByFilepath(oldPath)

        // Queue the change for DJ to review
        insertPendingChange({
          root_id: rootId,
          change_type: 'moved',
          old_path: oldPath,
          new_path: newPath,
          track_id: track?.id ?? null
        })

        if (track) {
          // Update filepath immediately — the file is just in a new place
          updateTrackFilepath(oldPath, newPath)

          mainWindow?.webContents.send('watcher:track-moved', {
            trackId: track.id,
            oldPath,
            newPath
          })
        }

        console.log(`[watcher] move accepted: ${oldPath} → ${newPath}`)
      } catch (err) {
        console.error('[watcher] onFileMoved error:', err)
      }
    },

    // File deleted — mark the row missing and queue for review. Never
    // deletes: the row is the durable identity (client_uuid, partial_hash)
    // and the anchor for tags, crates and board_id, none of which the file
    // going away invalidates. Only the explicit right-click action
    // (db:delete-track) ever removes a track.
    //
    // markTrackMissing is what puts this track into getMissingTracks' pool,
    // so a file that comes back under a NEW name gets relinked by
    // findReconcileMatch instead of inserted as a duplicate row that
    // strands the original's tags and crates. The two cheaper cases are
    // already covered elsewhere and never reach here: same filename within
    // 2s is caught by findMoveCandidate (libraryWatcher.ts), and the same
    // path reappearing is caught by insertTrack's ON CONFLICT(filepath)
    // upsert — both of which clear `missing` themselves, as do relinkTrack
    // and updateTrackFilepath. Nothing has to un-mark this by hand.
    onFileDeleted: async (filepath, rootId) => {
      try {
        const track = getTrackByFilepath(filepath)

        if (track) markTrackMissing(filepath)

        insertPendingChange({
          root_id: rootId,
          change_type: 'deleted',
          old_path: filepath,
          new_path: null,
          track_id: track?.id ?? null
        })

        mainWindow?.webContents.send('watcher:track-deleted', {
          filepath,
          trackId: track?.id ?? null
        })

        console.log(`[watcher] file deleted: ${filepath}`)
      } catch (err) {
        console.error('[watcher] onFileDeleted error:', err)
      }
    },

    // Directory appeared — mirror it into `folders` (and any missing
    // ancestors, via ensureFolderTree) the same way fs:create-folder and
    // import already do. If this is the watcher catching up with a folder
    // DeepCrated itself just created, ensureFolderTree's relative_path
    // UNIQUE constraint makes the second call a no-op reuse, not a
    // duplicate row.
    onDirAdded: async (dirpath, rootId) => {
      try {
        const root = getAllRoots().find((r) => r.id === rootId)
        if (!root) return
        const relDir = relative(root.path, dirpath)
        ensureFolderTree(rootId, [relDir])
        console.log(`[watcher] folder added: ${dirpath}`)
      } catch (err) {
        console.error('[watcher] onDirAdded error:', err)
      }
    },

    // Directory disappeared — mark it (and everything under it) missing
    // rather than deleting the row. A rename arrives as this event followed
    // by a separate onDirAdded for the new path (chokidar has no semantic
    // rename — see the comment on scheduleDirEvent in libraryWatcher.ts) —
    // so this always just means "the folder at this exact path is gone,"
    // never "this folder became that one."
    // TODO: reconcile renamed dirs via fingerprint once identity task lands.
    onDirRemoved: async (dirpath, rootId) => {
      try {
        const root = getAllRoots().find((r) => r.id === rootId)
        if (!root) return
        const relDir = relative(root.path, dirpath)
        const folderId = getFolderIdByRelativePath(rootId, relDir)
        if (folderId !== null) markFolderMissing(folderId)
        console.log(`[watcher] folder removed: ${dirpath}`)
      } catch (err) {
        console.error('[watcher] onDirRemoved error:', err)
      }
    },

    // Root went offline — notify renderer
    onRootOffline: (rootId, rootPath) => {
      console.log(`[watcher] root offline: ${rootPath}`)
      mainWindow?.webContents.send('watcher:root-offline', { rootId, rootPath })
    },

    // Root came back online
    onRootOnline: (rootId, rootPath) => {
      console.log(`[watcher] root online: ${rootPath}`)
      mainWindow?.webContents.send('watcher:root-online', { rootId, rootPath })
    }
  })

  // ── Start watchers for all registered roots ───────────────

  const roots = getAllRoots()

  for (const root of roots) {
    if (root.status === 'online') {
      startWatcher(root.id, root.path)
    }
  }

  ipcMain.handle('watcher:pending-changes', () => getPendingChanges())

  ipcMain.handle('watcher:accept-change', (_e, id: number) => {
    try {
      acceptPendingChange(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('watcher:ignore-change', (_e, id: number) => {
    try {
      ignorePendingChange(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Start/stop watcher when DJ adds/removes a root
  ipcMain.handle('watcher:start', (_e, rootId: number, rootPath: string) => {
    startWatcher(rootId, rootPath)
    return { ok: true }
  })

  ipcMain.handle('watcher:stop', async (_e, rootId: number) => {
    await stopWatcher(rootId)
    return { ok: true }
  })

  createWindow()

  // One-time, best-effort — do not await; must never delay window creation.
  migrateArtworkToContentAddressed().catch((err) => {
    console.error('[artwork migration] unexpected failure:', err)
  })

  // One-time, synchronous (pure SQL, no per-file I/O) — assigns folder_id to
  // tracks imported before the folders table had a writer.
  try {
    backfillTrackFolderIds()
  } catch (err) {
    console.error('[folder backfill] unexpected failure:', err)
  }

  // The scheduled token refresh can complete at any moment, including when
  // no window exists, so auth.ts pushes through this listener rather than
  // holding a window reference of its own.
  setAuthStateListener((state) => mainWindow?.webContents.send('auth:changed', state))

  // Restore a stored session, then tell the renderer. Deliberately not
  // awaited before createWindow: this is one network round trip, and
  // blocking the window on it would put a cold start behind Supabase's
  // latency (or its timeout, when offline) for an app that is fully usable
  // logged out. The renderer opens on its "checking" state and gets the
  // answer over 'auth:changed' a moment later.
  void restoreSession()
    .then((state) => mainWindow?.webContents.send('auth:changed', state))
    .catch((err) => console.error('[auth] restore failed:', err))

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  stopSessionRefresh()
  await stopAllWatchers()
})

// Electron does not wait on an async before-quit listener, so the final stats
// upload holds the quit itself: cancel it once, flush (capped at a few
// seconds), then quit again. Skipped entirely when there is nothing to send.
let statsFlushed = false
app.on('before-quit', (event) => {
  if (statsFlushed || !shouldFlushOnQuit()) return
  statsFlushed = true
  event.preventDefault()
  void flushStatsOnQuit().finally(() => app.quit())
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
