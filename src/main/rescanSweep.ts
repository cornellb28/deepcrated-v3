// ── Rescan: the database half ─────────────────────────────────────────────
// Applies the rules in rescan.ts to the library. Separate from that module
// because importing db.ts opens the SQLite file as a side effect, which the
// pure rules must stay clear of so they can be unit-tested.
//
// The invariant both halves uphold: **a rescan never deletes.** The only
// verb here for a file that has gone is `missing = 1`, exactly as the
// watcher's unlink path is, so the row keeps its identity (client_uuid,
// partial_hash), its tags and its crate slots — and stays in the pool
// findReconcileMatch draws from when the file resurfaces somewhere else.
// Only the explicit right-click action ever removes a track.

import { relative } from 'path'
import {
  getTrackScanIndex,
  markTracksMissingByIds,
  getFolderScanIndex,
  markFoldersMissingByIds
} from './db'
import { withTrailingSep, folderInScope } from './rescan'

export interface TrackSweepResult {
  swept: number
  // Ids the sweep marked, for a caller that wants to report or undo them.
  sweptIds: number[]
}

// The track half of the sweep. `seen` is every filepath the walk actually
// laid eyes on under `scanPrefix` — including files it could not read tags
// for (the file is there, which is the only question this asks) and the new
// paths of any tracks relinked during the scan.
export function sweepTracks(scanPrefix: string, seen: Set<string>): TrackSweepResult {
  const sweptIds = getTrackScanIndex(withTrailingSep(scanPrefix))
    .filter((row) => !row.missing && !seen.has(row.filepath))
    .map((row) => row.id)

  return { swept: markTracksMissingByIds(sweptIds), sweptIds }
}

// The folder half. `visitedRelDirs` are root-relative, the same frame
// getFolderScanIndex reports in.
//
// Deliberately does not use markFolderMissing, which also sweeps every track
// filed under the folder: during a rescan the tracks have already been judged
// individually against what the walk found, and letting the folder sweep
// overrule that would mark live tracks missing (a case-only directory
// rename, for one, leaves the files perfectly readable).
export function sweepFolders(
  rootId: number,
  rootPath: string,
  scannedPath: string,
  visitedRelDirs: Set<string>
): number {
  const subtree = relative(rootPath, scannedPath)

  const goneIds = getFolderScanIndex(rootId)
    .filter(
      (f): f is { id: number; relative_path: string; missing: number } => f.relative_path !== null
    )
    .filter((f) => !f.missing)
    .filter((f) => folderInScope(f.relative_path, subtree))
    .filter((f) => !visitedRelDirs.has(f.relative_path))
    .map((f) => f.id)

  return markFoldersMissingByIds(goneIds)
}
