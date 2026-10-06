import chokidar from 'chokidar'
import { basename, extname } from 'path'
import type { FSWatcher } from 'chokidar'
import { consumeExpectedAddition, consumeExpectedRemoval } from './expectedChanges'

// ─── Types ───────────────────────────────────────────────

export type ChangeType = 'added' | 'moved' | 'renamed' | 'deleted'

export interface PendingChange {
  rootId: number
  changeType: ChangeType
  oldPath: string | null
  newPath: string | null
  trackId: number | null
}

// ─── State ───────────────────────────────────────────────

// One watcher per library root
const watchers = new Map<number, FSWatcher>()

// Track recently unlinked files for move detection
// If a file is unlinked and then added within 2 seconds
// at a different path — it was moved, not deleted

const recentlyUnlinked = new Map<string, {
  path: string
  rootId: number
  timestamp: number
}>()

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg'])

function isAudio(filepath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filepath).toLowerCase())
}

// Coalesces addDir/unlinkDir per path — a Finder "New Folder" followed by an
// immediate rename fires multiple raw events within well under a second
// (chokidar has no semantic rename: a rename is unlinkDir on the old path
// then addDir on the new one, same as it is for files — see onFileMoved's
// recentlyUnlinked comment above). Keyed by absolute path, not coalesced
// across paths, so this does not by itself merge a rename's two paths into
// one operation — see the TODO on the rename branch in index.ts for that.
const DIR_EVENT_DEBOUNCE_MS = 500
const pendingDirEvents = new Map<
  string,
  { type: 'add' | 'unlink'; rootId: number; timer: ReturnType<typeof setTimeout> }
>()

function scheduleDirEvent(
  dirpath: string,
  type: 'add' | 'unlink',
  rootId: number,
  apply: (dirpath: string, type: 'add' | 'unlink', rootId: number) => void
): void {
  const existing = pendingDirEvents.get(dirpath)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pendingDirEvents.delete(dirpath)
    apply(dirpath, type, rootId)
  }, DIR_EVENT_DEBOUNCE_MS)
  pendingDirEvents.set(dirpath, { type, rootId, timer })
}

// ─── Callbacks ───────────────────────────────────────────
// Set by index.ts so the watcher can call back into the
// main process without circular imports

type OnFileAdded = (filepath: string, rootId: number) => Promise<void>
type OnFileMoved = (oldPath: string, newPath: string, rootId: number) => Promise<void>
type OnFileDeleted = (filepath: string, rootId: number) => Promise<void>
type OnDirAdded = (dirpath: string, rootId: number) => Promise<void>
type OnDirRemoved = (dirpath: string, rootId: number) => Promise<void>
type OnRootOffline = (rootId: number, rootPath: string) => void
type OnRootOnline = (rootId: number, rootPath: string) => void

let onFileAdded: OnFileAdded = async () => {}
let onFileMoved: OnFileMoved = async () => {}
let onFileDeleted: OnFileDeleted = async () => {}
let onDirAdded: OnDirAdded = async () => {}
let onDirRemoved: OnDirRemoved = async () => {}
let onRootOffline: OnRootOffline = () => {}
let onRootOnline: OnRootOnline  = () => {}

export function setWatcherCallbacks(callbacks: {
  onFileAdded: OnFileAdded
  onFileMoved: OnFileMoved
  onFileDeleted: OnFileDeleted
  onDirAdded: OnDirAdded
  onDirRemoved: OnDirRemoved
  onRootOffline: OnRootOffline
  onRootOnline: OnRootOnline
}): void {
  onFileAdded = callbacks.onFileAdded
  onFileMoved = callbacks.onFileMoved
  onFileDeleted = callbacks.onFileDeleted
  onDirAdded = callbacks.onDirAdded
  onDirRemoved = callbacks.onDirRemoved
  onRootOffline = callbacks.onRootOffline
  onRootOnline = callbacks.onRootOnline
}

// ─── Start watching a root ────────────────────────────────

export function startWatcher(rootId: number, rootPath: string): void {
  // Do not start a duplicate watcher — falling through here used to create
  // a second chokidar instance and overwrite the Map entry, leaking the
  // first one (never closed, kept its own fs handles open).
  if (watchers.has(rootId)) {
    console.log(`[watcher] already watching root ${rootId}: ${rootPath}`)
    return
  }

  console.log(`[watcher] starting watcher for root ${rootId}: ${rootPath}`)

  const watcher = chokidar.watch(rootPath, {
    // Do not fire events for files that already existed
    // when the watcher starts — only new changes
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    // Ignore hidden files and macOS AppleDouble files
    ignored: /(^|[/\\])\../,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200
    }
  })

  // ── File added ──────────────────────────────────────────
  watcher.on('add', async (filepath) => {
    if (!isAudio(filepath)) return

    // The landing half of a move CrateCloud made itself (see
    // expectedChanges.ts). The engine has already repointed the row and the
    // DJ asked for it, so there is nothing to import and nothing to review —
    // queueing a pending_changes row here would ask them to confirm their own
    // action. Consume-once, so a later genuine add at this path still counts.
    if (consumeExpectedAddition(filepath)) {
      console.log(`[watcher] add is our own move landing, ignoring: ${filepath}`)
      return
    }

    console.log(`[watcher] file added: ${filepath}`)

    // Check if this is the destination of a recent move
    const moveCandidate = findMoveCandidate(filepath)
    if (moveCandidate) {
      console.log(`[watcher] move detected: ${moveCandidate.path} → ${filepath}`)
      recentlyUnlinked.delete(moveCandidate.path)
      await onFileMoved(moveCandidate.path, filepath, rootId)
      return
    }

    // Genuine new file
    await onFileAdded(filepath, rootId)
  })

  // ── File deleted ────────────────────────────────────────

  watcher.on('unlink', async (filepath) => {
    if (!isAudio(filepath)) return

    // The departing half of a move CrateCloud made itself. Returning here
    // keeps it out of recentlyUnlinked, which matters most on the collision
    // path: a file renamed to "Track (2).mp3" no longer matches
    // findMoveCandidate's same-filename rule, so without this it would fall
    // through to onFileDeleted and mark a live track missing.
    if (consumeExpectedRemoval(filepath)) {
      console.log(`[watcher] unlink is our own move leaving, ignoring: ${filepath}`)
      return
    }

    console.log(`[watcher] file removed: ${filepath}`)

    // Store in recently unlinked — might be a move
    recentlyUnlinked.set(filepath, {
      path: filepath,
      rootId,
      timestamp: Date.now()
    })

    // Wait 2 seconds — if no matching add arrives, treat as deleted
    setTimeout(async () => {
      if (recentlyUnlinked.has(filepath)) {
        recentlyUnlinked.delete(filepath)
        console.log(`[watcher] file deleted: ${filepath}`)
        await onFileDeleted(filepath, rootId)
      }
    }, 2000)
  })

  // ── Directory added ─────────────────────────────────────

  watcher.on('addDir', (dirpath) => {
    if (dirpath === rootPath) return // the watched root itself, not a new folder

    // The landing half of a rename CrateCloud performed. The folder row was
    // already repointed at this path, so ensureFolderTree would be a no-op —
    // but consuming the expectation keeps the pair balanced with the unlink
    // below, which is the half that actually matters.
    if (consumeExpectedAddition(dirpath)) {
      console.log(`[watcher] dir add is our own rename landing, ignoring: ${dirpath}`)
      return
    }

    console.log(`[watcher] dir added: ${dirpath}`)
    scheduleDirEvent(dirpath, 'add', rootId, (path, _type, id) => {
      onDirAdded(path, id).catch((err) => console.error('[watcher] onDirAdded error:', err))
    })
  })

  // ── Directory removed ────────────────────────────────────

  watcher.on('unlinkDir', (dirpath) => {
    if (dirpath === rootPath) return

    // The departing half of a rename CrateCloud performed. Without this,
    // onDirRemoved would look the OLD path up and — if the lookup happened
    // to still resolve — call markFolderMissing, which marks the folder AND
    // every track under it missing. A rename would look like a deletion.
    if (consumeExpectedRemoval(dirpath)) {
      console.log(`[watcher] dir unlink is our own rename leaving, ignoring: ${dirpath}`)
      return
    }

    console.log(`[watcher] dir removed: ${dirpath}`)
    scheduleDirEvent(dirpath, 'unlink', rootId, (path, _type, id) => {
      onDirRemoved(path, id).catch((err) => console.error('[watcher] onDirRemoved error:', err))
    })
  })

  // ── Root folder goes offline ────────────────────────────

  watcher.on('error', (error) => {
    console.error(`[watcher] error on root ${rootId}:`, error)
  })

  // Detect when the root itself disappears (drive unplugged)
  watcher.on('raw', (event, path) => {
    if (event === 'rename' && path === rootPath) {
      console.log(`[watcher] root may have gone offline: ${rootPath}`)
      onRootOffline(rootId, rootPath)
    }
  })

  // At the bottom of startWatcher(), add:
  void onRootOnline // referenced to satisfy TypeScript

  watchers.set(rootId, watcher)
}

// ─── Stop watching a root ─────────────────────────────────

export async function stopWatcher(rootId: number): Promise<void> {
  const watcher = watchers.get(rootId)
  if (!watcher) return

  console.log(`[watcher] stopping watcher for root ${rootId}`)
  await watcher.close()
  watchers.delete(rootId)

  // Drop any debounced dir events still pending for this root — the folder
  // rows aren't going anywhere, but firing into a closed watcher's root
  // after the fact (e.g. mid-import pause/resume) serves nothing.
  for (const [path, entry] of pendingDirEvents.entries()) {
    if (entry.rootId === rootId) {
      clearTimeout(entry.timer)
      pendingDirEvents.delete(path)
    }
  }
}

export async function stopAllWatchers(): Promise<void> {
  const ids = Array.from(watchers.keys())
  await Promise.all(ids.map((id) => stopWatcher(id)))
}

// ─── Move detection helper ────────────────────────────────
// Finds a recently unlinked file that matches the added file
// by filename — heuristic for detecting moves

function findMoveCandidate(newPath: string): {
  path: string
  rootId: number
} | null {
  const newName = basename(newPath)
  const now     = Date.now()

  for (const [path, entry] of recentlyUnlinked.entries()) {
    // Must have same filename
    if (basename(path) !== newName) continue

    // Must be within 2 seconds
    if (now - entry.timestamp > 2000) {
      recentlyUnlinked.delete(path)
      continue
    }

    return { path, rootId: entry.rootId }
  }

  return null
}
