// ── Move tracks into a folder ─────────────────────────────────────────────
// The one implementation of "put these tracks in that directory", shared by
// the Import flow and by any future "add existing tracks" UI. It owns the
// filesystem move, the collision rename, the database update and the
// announcement that keeps the watcher and the rescan from mistaking the
// result for a delete-and-add.
//
// ── Why rescan safety needs no new marking ───────────────────────────────
// sweepTracks (rescanSweep.ts) marks a row missing when its DB `filepath` is
// not among the paths the walk saw. updateTrackFilepath repoints the row at
// the new path in the same operation as the move, so the next walk finds the
// file exactly where the row says it is and the row is never swept. The
// import half agrees for the same reason: it looks a walked file up by
// filepath, finds the row, and treats it as unchanged rather than new.
//
// So the rescan needs nothing from us beyond doing the DB update — which is
// verified by a test that actually runs a sweep after a move, rather than
// asserted here.
//
// ── Why the WATCHER does need telling ────────────────────────────────────
// The rescan compares against the database. The watcher does not: it reacts
// to raw chokidar events, and an app-initiated move looks exactly like a DJ
// doing it in Finder. Left alone it queues a `pending_changes` row asking the
// DJ to review a move they just requested, and on the collision path (where
// the filename changes) it misses findMoveCandidate entirely and goes the
// long way round — unlink → markTrackMissing → add → reconcile. So the engine
// announces both halves through expectedChanges.ts before touching the disk.
//
// ── Ordering, and what a crash costs ─────────────────────────────────────
// File first, database second, always. A crash between them leaves the file
// moved and the row pointing at the old path: the next rescan marks that row
// missing (never deletes it — see rescanSweep.ts) and findReconcileMatch
// relinks it from the identity columns. The reverse order would leave the row
// pointing at a path with no file and no way back.

import { copyFile, rename, stat, unlink, readdir } from 'fs/promises'
import { createReadStream } from 'fs'
import { createHash } from 'crypto'
import { pipeline } from 'stream/promises'
import { basename, join } from 'path'
import { getTrackById, updateTrackFilepath } from './db'
import { cancelExpectation, expectMove } from './expectedChanges'
import { isSameLocation, partialNameFor, resolveCollisionName } from './movePaths'

export type MoveStatus = 'moved' | 'skipped' | 'failed'

export interface MoveOutcome {
  trackId: number
  status: MoveStatus
  from: string
  // Where it actually landed. Absent on a failure.
  to?: string
  // Set only when a collision forced a different filename, so the caller can
  // tell the DJ their file is now called something else — silently renaming
  // someone's track and saying nothing is its own kind of data loss.
  renamedTo?: string
  // True when the move crossed a volume boundary and had to be copy+verify
  // rather than a rename.
  crossVolume?: boolean
  error?: string
  // The move succeeded but something non-fatal needs saying — the classic
  // being a copy that landed while the original could not be removed.
  warning?: string
}

export interface MoveResult {
  outcomes: MoveOutcome[]
  moved: number
  skipped: number
  failed: number
  renamed: number
}

export interface MoveOptions {
  // 'size' compares byte counts, which catches truncation — the failure mode
  // an interrupted copy actually produces. 'checksum' additionally re-reads
  // the destination and compares SHA-256, which catches silent corruption on
  // a flaky volume at the cost of one extra full read per file.
  verify?: 'size' | 'checksum'
  // Reported after each track so a caller can drive a progress bar. Never
  // throws into the engine — a failing callback must not abort a move.
  onProgress?: (done: number, total: number, outcome: MoveOutcome) => void
  // Checked between tracks. A batch stops cleanly; tracks already moved stay
  // moved, and the rest come back as 'skipped'.
  shouldStop?: () => boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

// Every entry in the destination directory, as a Set for the collision
// resolver. Read once per track rather than stat-ing each candidate: a
// directory with a long "(2)…(9)" series would otherwise cost a syscall per
// attempt, and we need the listing anyway.
async function entriesIn(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir))
  } catch {
    return new Set()
  }
}

// ── One track ────────────────────────────────────────────────────────────
// Never throws. Every failure mode is captured in the returned outcome so
// one bad file cannot abort a batch of twelve.
export async function moveTrackToFolder(
  trackId: number,
  destDir: string,
  options: MoveOptions = {}
): Promise<MoveOutcome> {
  const verify = options.verify ?? 'size'

  const track = getTrackById(trackId)
  if (!track) {
    return { trackId, status: 'failed', from: '', error: 'Track not found in the library' }
  }

  const from = track.filepath
  const base: Pick<MoveOutcome, 'trackId' | 'from'> = { trackId, from }

  if (!from) {
    return { ...base, status: 'failed', error: 'Track has no file path' }
  }

  if (!(await pathExists(from))) {
    // Marked missing, or deleted behind our back. Either way there is nothing
    // to move, and inventing a failure for it would be misleading.
    return { ...base, status: 'failed', error: 'Source file is not on disk' }
  }

  const destStat = await stat(destDir).catch(() => null)
  if (!destStat?.isDirectory()) {
    return { ...base, status: 'failed', error: 'Destination folder does not exist' }
  }

  if (isSameLocation(from, destDir)) {
    return { ...base, status: 'skipped', to: from, error: 'Already in this folder' }
  }

  const wanted = basename(from)
  const taken = await entriesIn(destDir)
  const finalName = resolveCollisionName(wanted, (candidate) => taken.has(candidate))
  if (!finalName) {
    return { ...base, status: 'failed', error: `Too many files named like "${wanted}" here` }
  }

  const to = join(destDir, finalName)
  const renamedTo = finalName === wanted ? undefined : finalName

  // Before the first byte moves — chokidar can deliver the unlink while a
  // cross-volume copy is still running.
  expectMove(from, to)

  let crossVolume = false
  let warning: string | undefined

  try {
    try {
      await rename(from, to)
    } catch (err) {
      // EXDEV is the authoritative answer to "same volume?" — more reliable
      // than comparing st_dev up front, and it costs nothing when the rename
      // works, which is the common case.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      crossVolume = true
      warning = await copyAcrossVolumes(from, to, destDir, finalName, verify)
    }
  } catch (err) {
    // Nothing landed, or the copy cleaned up after itself. The source is
    // untouched, so the announcement must be withdrawn or the watcher would
    // stay deaf to a real change at these paths until the TTL expired.
    cancelExpectation(from, to)
    return { ...base, status: 'failed', crossVolume, error: (err as Error).message }
  }

  // File first, database second — see the header. A 0-row update means the
  // row's filepath changed under us between read and write; the file has
  // moved regardless, so this is a warning on a successful move rather than
  // a failure that would misreport where the file now is.
  const updated = updateTrackFilepath(from, to)
  if (updated.changes === 0) {
    warning = warning
      ? `${warning}. The library row was not updated — run a rescan`
      : 'File moved, but the library row was not updated — run a rescan'
  }

  return { ...base, status: 'moved', to, renamedTo, crossVolume, warning }
}

// Copy to a hidden partial name, verify it, then rename into place and drop
// the source. Never delete-then-copy, and the destination path never exists
// half-written: if anything fails, the partial is removed and the original is
// exactly where it was.
async function copyAcrossVolumes(
  from: string,
  to: string,
  destDir: string,
  finalName: string,
  verify: 'size' | 'checksum'
): Promise<string | undefined> {
  const partial = join(destDir, partialNameFor(finalName))

  try {
    await copyFile(from, partial)

    const sourceSize = (await stat(from)).size
    const copiedSize = (await stat(partial)).size
    if (copiedSize !== sourceSize) {
      throw new Error(`Copy verification failed: ${copiedSize} of ${sourceSize} bytes`)
    }

    if (verify === 'checksum') {
      const [a, b] = await Promise.all([sha256(from), sha256(partial)])
      if (a !== b) throw new Error('Copy verification failed: checksum mismatch')
    }

    await rename(partial, to)
  } catch (err) {
    // The whole point of the partial name: cleanup is unambiguous, and the
    // real destination was never created.
    await unlink(partial).catch(() => {})
    throw err
  }

  try {
    await unlink(from)
  } catch (err) {
    // The copy is verified and in place — do NOT roll it back over this. The
    // DB gets pointed at the new file either way; the stale original just
    // needs clearing by hand.
    return `Copied, but the original could not be removed: ${(err as Error).message}`
  }

  return undefined
}

// ── A batch ──────────────────────────────────────────────────────────────
// Per-track results, never all-or-nothing: one failure in twelve leaves the
// other eleven moved.
export async function moveTracksToFolder(
  trackIds: number[],
  destDir: string,
  options: MoveOptions = {}
): Promise<MoveResult> {
  const outcomes: MoveOutcome[] = []

  // Sequential on purpose. These are large files on one volume pair; running
  // them concurrently trades throughput for seek contention, and it makes the
  // collision resolution racy — two parallel moves of "Track.mp3" would both
  // read the directory before either had written to it.
  for (const trackId of trackIds) {
    if (options.shouldStop?.()) {
      outcomes.push({
        trackId,
        status: 'skipped',
        from: getTrackById(trackId)?.filepath ?? '',
        error: 'Stopped before this track'
      })
      continue
    }

    const outcome = await moveTrackToFolder(trackId, destDir, options)
    outcomes.push(outcome)

    try {
      options.onProgress?.(outcomes.length, trackIds.length, outcome)
    } catch {
      // A caller's progress handler must never take the batch down with it.
    }
  }

  return {
    outcomes,
    moved: outcomes.filter((o) => o.status === 'moved').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    renamed: outcomes.filter((o) => o.renamedTo).length
  }
}
