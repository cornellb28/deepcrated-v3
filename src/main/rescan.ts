// ── Rescan: reconciling the DB against what is actually on disk ───────────
// The watcher only hears about changes made while the app was running.
// Anything that happened with CrateCloud closed — a drive reorganised in
// Finder, files deleted, a folder renamed — is invisible until something
// walks the tree and compares. That is what a rescan is, and it's the
// deliberate redundancy alongside the watcher rather than a legacy fallback.
//
// This module holds the RULES a rescan applies — which walked files can
// skip the expensive tag read, and which folder rows a given scan is
// entitled to judge. All pure, all reachable from a test: index.ts boots
// the whole Electron app on import, this doesn't. The database writes those
// rules drive are in rescanSweep.ts.
//
// The one invariant everything here upholds: **a rescan never deletes.** Its
// only verb for a file that has gone is `missing = 1`, exactly as the
// watcher's unlink path is, so the row keeps its identity (client_uuid,
// partial_hash), its tags and its crate slots — and stays in the pool
// findReconcileMatch draws from when the file resurfaces somewhere else.
// Only the explicit right-click action ever removes a track.

import { sep } from 'path'
// Type-only, so importing this module never pulls db.ts in at runtime —
// db.ts opens the SQLite file the moment it loads, which would put a real
// database behind what are meant to be pure unit tests. The sweep half,
// which genuinely does need the database, lives in rescanSweep.ts.
import type { ScanIndexRow } from './db'

// What a rescan needs to know about a file it just walked past.
export interface WalkedFileStat {
  size: number
  mtimeMs: number
}

// A walked file is unchanged when it is in the same place, the same size,
// and carries the same mtime the DB recorded last time. Then and only then
// can the expensive part — readTagsFast, a sidecar round trip per file — be
// skipped in favour of stamping the row seen.
//
// Both halves must be non-null to count: a row whose last_modified is null
// (inserted before this column was written, or by one of the watcher's
// single-file paths, which have no stat to hand) is treated as changed so
// the next rescan reads it once and fills the value in.
export function isUnchanged(known: ScanIndexRow | undefined, stat: WalkedFileStat | null): boolean {
  if (!known || !stat) return false
  if (known.file_size_bytes === null || known.last_modified === null) return false
  return known.file_size_bytes === stat.size && known.last_modified === normalizeMtime(stat.mtimeMs)
}

// mtimeMs carries sub-millisecond fractions on some filesystems and the
// column is an INTEGER, so both sides of the comparison have to be floored
// through the same function or a file would look changed on every scan.
export function normalizeMtime(mtimeMs: number): number {
  return Math.floor(mtimeMs)
}

// Paths compare by prefix in several places here, and "/music" must not
// match "/music-archive/...", so the separator is always part of the prefix.
export function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

// Which folder rows a given rescan is entitled to judge. Re-scanning one
// folder must not mark every other folder in the root missing, so a scan of
// a subfolder only sweeps that subtree; a scan of the root itself (subtree
// "") sweeps everything under it.
export function folderInScope(relativePath: string, subtree: string): boolean {
  if (subtree === '') return true
  return relativePath === subtree || relativePath.startsWith(subtree + sep)
}
