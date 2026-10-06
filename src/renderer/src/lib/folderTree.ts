// ── Destination folder tree ───────────────────────────────────────────────
// Pure shaping behind the "Move to…" picker. Folders are read from disk one
// directory at a time, so a node's children are null until they have been
// loaded — distinct from an empty array, which means "loaded, and there are
// none". Kept out of the component so it can be tested without a filesystem.

export interface FolderNode {
  name: string
  path: string
  /** null = not loaded yet. */
  children: FolderNode[] | null
  isRoot: boolean
}

export interface FolderRowView {
  node: FolderNode
  depth: number
  expanded: boolean
}

export function makeNode(name: string, path: string, isRoot = false): FolderNode {
  return { name, path, children: null, isRoot }
}

// Immutable replace of one node's children, found by path. Returns the same
// array when the path is not present, so React can skip the re-render.
export function setNodeChildren(
  nodes: FolderNode[],
  path: string,
  children: FolderNode[]
): FolderNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.path === path) {
      changed = true
      return { ...node, children }
    }
    if (node.children && node.children.length > 0) {
      const updated = setNodeChildren(node.children, path, children)
      if (updated !== node.children) {
        changed = true
        return { ...node, children: updated }
      }
    }
    return node
  })
  return changed ? next : nodes
}

export function findNode(nodes: FolderNode[], path: string): FolderNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const hit = findNode(node.children, path)
      if (hit) return hit
    }
  }
  return null
}

// Keeps a folder when its own name matches, or when any loaded descendant's
// does. A folder that matches keeps all of its loaded children, so "Edits"
// is a way of asking for everything under Edits. Only searches what has
// been loaded — the caller tells the user as much.
export function filterFolderTree(nodes: FolderNode[], query: string): FolderNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes
  const walk = (list: FolderNode[]): FolderNode[] =>
    list.reduce<FolderNode[]>((kept, node) => {
      const selfMatches = node.name.toLowerCase().includes(needle)
      const children = selfMatches ? node.children : walk(node.children ?? [])
      if (selfMatches || (children && children.length > 0)) kept.push({ ...node, children })
      return kept
    }, [])
  return walk(nodes)
}

export function flattenFolderTree(
  nodes: FolderNode[],
  expanded: Set<string>,
  depth = 0
): FolderRowView[] {
  return nodes.flatMap((node) => {
    const isExpanded = expanded.has(node.path)
    const row: FolderRowView = { node, depth, expanded: isExpanded }
    if (!isExpanded || !node.children || node.children.length === 0) return [row]
    return [row, ...flattenFolderTree(node.children, expanded, depth + 1)]
  })
}

export function allFolderPaths(nodes: FolderNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...allFolderPaths(node.children ?? [])])
}

// The directory a file sits in. Used to mark the folder a track already
// lives in, so the picker can refuse a move that would do nothing.
export function parentDirectory(filepath: string): string {
  const cut = filepath.lastIndexOf('/')
  return cut <= 0 ? '/' : filepath.slice(0, cut)
}

// A full absolute path is unreadable once it is ellipsised, and the part
// that gets cut is the part that matters. Shown relative to whichever
// library root contains it instead: "MUSICLITE / Edits / Boom Bap". Falls
// back to the raw path when it sits under no known root.
export function displayPath(path: string, roots: { name: string; path: string }[]): string {
  const root = roots
    .filter((r) => path === r.path || path.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!root) return path
  const rest = path.slice(root.path.length).replace(/^\/+/, '')
  return rest ? `${root.name} / ${rest.split('/').join(' / ')}` : root.name
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
