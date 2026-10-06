// ── Expected filesystem changes ───────────────────────────────────────────
// When CrateCloud itself moves a file, chokidar reports it exactly as if the
// DJ had done it in Finder: an `unlink` on the old path and an `add` on the
// new one. The watcher then does real work for it — queues a `pending_changes`
// row for the DJ to review, and on the slow path marks the track missing and
// relinks it through findReconcileMatch.
//
// All of that is correct for a change the app did not make. For one it DID
// make, it is noise at best: the DJ is asked to review a move they just asked
// for, and the row they are reviewing was already updated. Worse on the
// collision path — a file renamed to "Track (2).mp3" no longer matches
// findMoveCandidate's same-filename rule, so it falls through to
// unlink → markTrackMissing → add → reconcile, which is slower and racier
// than the move it is describing.
//
// So the engine announces its intent here first, and the watcher asks before
// acting. Deliberately free of fs, db and electron imports so the whole thing
// is reachable from a unit test.

// Long enough to cover chokidar's awaitWriteFinish (1s stability) plus a slow
// cross-volume copy's final rename, short enough that a move which never
// completes cannot suppress a genuine deletion minutes later.
export const DEFAULT_TTL_MS = 15_000

type ChangeKind = 'removal' | 'addition'

interface Expectation {
  expiresAt: number
}

// Keyed by kind + path: the same path can legitimately be both the source of
// one move and the destination of another.
const expectations = new Map<string, Expectation>()

function key(kind: ChangeKind, path: string): string {
  return `${kind}\u0000${path}`
}

function put(kind: ChangeKind, path: string, ttlMs: number, now: number): void {
  expectations.set(key(kind, path), { expiresAt: now + ttlMs })
}

// Announce both halves of a move before touching the filesystem. Call this
// BEFORE the rename/copy, not after: chokidar can deliver the unlink while
// the copy is still running.
export function expectMove(
  oldPath: string,
  newPath: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  put('removal', oldPath, ttlMs, now)
  put('addition', newPath, ttlMs, now)
}

export function expectRemoval(
  path: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  put('removal', path, ttlMs, now)
}

export function expectAddition(
  path: string,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now()
): void {
  put('addition', path, ttlMs, now)
}

// Consume-once. A second unlink of the same path is a real event and must be
// treated as one — otherwise a move followed by the DJ genuinely deleting the
// file there would be silently swallowed.
function consume(kind: ChangeKind, path: string, now: number): boolean {
  const k = key(kind, path)
  const found = expectations.get(k)
  if (!found) return false

  expectations.delete(k)
  // Expired is the same as absent: the change it described never arrived, so
  // whatever is happening now is somebody else's doing.
  return found.expiresAt > now
}

export function consumeExpectedRemoval(path: string, now: number = Date.now()): boolean {
  return consume('removal', path, now)
}

export function consumeExpectedAddition(path: string, now: number = Date.now()): boolean {
  return consume('addition', path, now)
}

// Drops an announcement that is no longer going to happen — a move that
// failed before it touched the disk. Without this, a failed move would leave
// the watcher deaf to a real change at that path until the TTL ran out.
export function cancelExpectation(oldPath: string, newPath: string): void {
  expectations.delete(key('removal', oldPath))
  expectations.delete(key('addition', newPath))
}

export function clearExpectations(): void {
  expectations.clear()
}

// Test seam.
export function pendingExpectationCount(now: number = Date.now()): number {
  let live = 0
  for (const value of expectations.values()) if (value.expiresAt > now) live++
  return live
}
