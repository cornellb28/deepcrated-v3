// ── Move: the path arithmetic ─────────────────────────────────────────────
// Collision naming and the partial-copy filename, kept pure so they can be
// tested without a filesystem — same split as rescan.ts vs rescanSweep.ts.
//
// Naming a file is where a move quietly goes wrong: "Track.mp3" colliding
// with "Track.mp3" must not overwrite, must not fail, and must not produce
// "Track.mp3 (2)" with the suffix after the extension, which breaks every
// tool that routes on extension — including our own isAudio().

import { extname, basename } from 'path'

// Written next to the destination while a cross-volume copy is in flight, so
// the final path never exists in a half-written state. A crash leaves an
// obviously-partial file rather than something that looks like a real track
// and would be imported as one on the next scan.
//
// Leading dot so chokidar's `ignored: /(^|[/\\])\../` skips it — a partial
// file must never reach the watcher as an `add`.
export const PARTIAL_PREFIX = '.cratecloud-partial-'

export function partialNameFor(filename: string): string {
  return `${PARTIAL_PREFIX}${filename}`
}

// "Track.mp3" -> { stem: "Track", ext: ".mp3" }
// ".hidden"   -> { stem: ".hidden", ext: "" }   (extname's own rule, kept)
export function splitName(filename: string): { stem: string; ext: string } {
  const ext = extname(filename)
  return { stem: ext ? filename.slice(0, -ext.length) : filename, ext }
}

// "Track.mp3", 2 -> "Track (2).mp3". The suffix goes before the extension,
// which is both what Finder does and what keeps the file recognisably audio.
export function suffixedName(filename: string, n: number): string {
  if (n <= 1) return filename
  const { stem, ext } = splitName(filename)
  return `${stem} (${n})${ext}`
}

// The first name in the series that `exists` says is free. `exists` takes a
// bare filename, not a path, so the caller owns the directory and this stays
// testable with a plain Set.
//
// Returns null rather than looping forever if the whole series is taken —
// a directory holding "Track (1..limit).mp3" is a sign of something wrong
// upstream, and failing that one file is better than hanging the batch.
export function resolveCollisionName(
  filename: string,
  exists: (candidate: string) => boolean,
  limit = 200
): string | null {
  if (!exists(filename)) return filename
  for (let n = 2; n <= limit; n++) {
    const candidate = suffixedName(filename, n)
    if (!exists(candidate)) return candidate
  }
  return null
}

// A move is a no-op when the file is already sitting in the destination.
// Worth catching explicitly: the rename would succeed, the DB update would
// be a no-op, and the result would claim a move that never happened.
export function isSameLocation(fromPath: string, destDir: string): boolean {
  return dirOf(fromPath) === stripTrailingSep(destDir)
}

function stripTrailingSep(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

function dirOf(filepath: string): string {
  const name = basename(filepath)
  return stripTrailingSep(filepath.slice(0, filepath.length - name.length))
}
