// ── Renaming a folder: disk and database together ─────────────────────────
// Extracted from the fs:rename-folder handler so the thing a DJ actually
// cares about can be tested against real files: after a rename, all THREE
// of these have to agree —
//
//   1. the directory on the hard drive
//   2. the folder's name in CrateCloud
//   3. every track's filepath underneath it
//
// A handler is not reachable from a test, so while this lived inside one the
// only coverage was of the database half. The watcher lifecycle stays in the
// handler: stopping chokidar is index.ts's business, and a test has no
// watcher running.
//
// Disk first, database second — the same order as moveEngine, for the same
// reason. A DB update for a rename that did not happen leaves rows pointing
// at a directory that is not there.

import { rename, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { getAllRoots, getFolderTree, repointFolderSubtree, repointRootPath } from './db'
import { cancelExpectation, expectMove } from './expectedChanges'

export interface FolderRenamePlan {
  folderId: number
  isRoot: boolean
  rootId: number | null
  oldPath: string
  newPath: string
  newName: string
}

export type PlanResult =
  | { ok: true; plan: FolderRenamePlan }
  | { ok: false; error: string }
  | { ok: true; plan: null } // nothing to do — the name is unchanged

// Validation and path arithmetic, with no side effects, so the refusals can
// be asserted without a filesystem.
export function planFolderRename(folderId: number, rawName: string): PlanResult {
  const newName = rawName.trim()
  if (!newName) return { ok: false, error: 'Name cannot be empty' }
  if (newName.includes('/') || newName.includes('\\')) {
    return { ok: false, error: 'Name cannot contain slashes' }
  }

  const folder = getFolderTree().find((f) => f.id === folderId)
  if (!folder?.path) return { ok: false, error: 'Folder not found' }
  if (folder.name === newName) return { ok: true, plan: null }

  const isRoot = folder.parent_folder_id == null

  if (isRoot) {
    const rootId = folder.root_folder_id
    if (rootId == null) return { ok: false, error: 'This folder has no library root' }
    const root = getAllRoots().find((r) => r.id === rootId)
    if (!root) return { ok: false, error: 'Library root not found' }
    return {
      ok: true,
      plan: {
        folderId,
        isRoot: true,
        rootId,
        oldPath: root.path,
        newPath: join(dirname(root.path), newName),
        newName
      }
    }
  }

  return {
    ok: true,
    plan: {
      folderId,
      isRoot: false,
      rootId: folder.root_folder_id ?? null,
      oldPath: folder.path,
      newPath: join(dirname(folder.path), newName),
      newName
    }
  }
}

export interface RenameOutcome {
  ok: boolean
  error?: string
  newPath?: string
  foldersUpdated?: number
  tracksUpdated?: number
}

// Does the move. Never throws; every failure comes back in the result so the
// caller can restart the watcher and report.
export async function applyFolderRename(plan: FolderRenamePlan): Promise<RenameOutcome> {
  // A case-only rename ("house" -> "House") is legitimate and, on a
  // case-insensitive volume, the destination "already exists" — it is the
  // same directory. Only a genuinely different name is a collision.
  if (plan.newPath.toLowerCase() !== plan.oldPath.toLowerCase()) {
    try {
      await stat(plan.newPath)
      return { ok: false, error: 'A folder with that name already exists here' }
    } catch {
      // good — nothing there
    }
  }

  // Announced before the move: chokidar's unlinkDir would otherwise be read
  // as a deletion, and onDirRemoved marks the folder AND every track under
  // it missing.
  expectMove(plan.oldPath, plan.newPath)

  try {
    await rename(plan.oldPath, plan.newPath)
  } catch (err) {
    cancelExpectation(plan.oldPath, plan.newPath)
    return { ok: false, error: (err as Error).message }
  }

  const counts =
    plan.isRoot && plan.rootId != null
      ? repointRootPath(plan.rootId, plan.oldPath, plan.newPath, plan.newName)
      : repointFolderSubtree(plan.folderId, plan.oldPath, plan.newPath, plan.newName)

  return { ok: true, newPath: plan.newPath, ...counts }
}

// The whole operation for a caller with no watcher to manage — which is what
// a test is. The handler uses planFolderRename/applyFolderRename directly so
// it can stop and restart chokidar around the middle step.
export async function renameFolder(folderId: number, newName: string): Promise<RenameOutcome> {
  const planned = planFolderRename(folderId, newName)
  if (!planned.ok) return { ok: false, error: planned.error }
  if (!planned.plan) return { ok: true }
  return applyFolderRename(planned.plan)
}
