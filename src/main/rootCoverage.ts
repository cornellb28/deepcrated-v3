// ── Is this folder already in the library? ────────────────────────────────
// Pure: answers, before an import starts, how a picked folder relates to the
// watched library folders (library_roots). The import itself still decides
// with registerLibraryRoot; this only lets the renderer warn first instead of
// silently re-importing a folder that is already watched.

import { isAbsolute, relative, resolve } from 'path'

export interface RootRef {
  id: number
  name: string
  path: string
}

export type FolderCoverage =
  // Not watched, and holds no watched folder: a normal import.
  | { status: 'new' }
  // Already watched: the root itself (isRoot) or a folder inside it.
  | { status: 'watched'; root: RootRef; isRoot: boolean }
  // A parent of one or more watched folders; the import refuses these.
  | { status: 'contains'; roots: RootRef[] }

// Same rule as db.ts's isPathUnder, kept here so this stays free of the
// database and Electron. A trailing slash or "." segment does not matter.
function isUnder(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  if (c === p) return true
  const rel = relative(p, c)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function classifyFolder(folderPath: string, roots: readonly RootRef[]): FolderCoverage {
  const covering = roots.find((r) => isUnder(folderPath, r.path))
  if (covering) {
    return {
      status: 'watched',
      root: { id: covering.id, name: covering.name, path: covering.path },
      isRoot: resolve(folderPath) === resolve(covering.path)
    }
  }
  const inside = roots.filter((r) => isUnder(r.path, folderPath))
  if (inside.length > 0) {
    return {
      status: 'contains',
      roots: inside.map((r) => ({ id: r.id, name: r.name, path: r.path }))
    }
  }
  return { status: 'new' }
}
