// ── Crate tree shaping ────────────────────────────────────────────────────
// Pure functions behind the crate picker's list. Kept out of the component
// so they can be tested without rendering React, and so the sidebar and the
// picker cannot drift into two different ideas of what the tree looks like.

export interface CrateNode extends Crate {
  children: CrateNode[]
}

export interface CrateRow {
  node: CrateNode
  depth: number
  expanded: boolean
}

// Children sorted by name at every level. A crate whose parent_crate_id
// points at a crate that no longer exists is surfaced at the top level
// rather than dropped — losing it silently would make it unreachable.
export function buildCrateTree(crates: Crate[]): CrateNode[] {
  const byId = new Map<number, CrateNode>(crates.map((c) => [c.id, { ...c, children: [] }]))
  const roots: CrateNode[] = []
  for (const node of byId.values()) {
    const parent = node.parent_crate_id !== null ? byId.get(node.parent_crate_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortByName = (nodes: CrateNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    nodes.forEach((n) => sortByName(n.children))
  }
  sortByName(roots)
  return roots
}

// Keeps a crate when its own name matches, or when any descendant's does —
// otherwise searching for a nested crate would hide the parents you need in
// order to see it. A crate that matches keeps ALL of its children, matching
// or not: "House" is a reasonable way to ask for everything under House,
// and dropping its subcrates would make them unpickable from that search.
// Returns a new tree; the input is untouched.
export function filterCrateTree(nodes: CrateNode[], query: string): CrateNode[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return nodes
  const walk = (list: CrateNode[]): CrateNode[] =>
    list.reduce<CrateNode[]>((kept, node) => {
      const selfMatches = node.name.toLowerCase().includes(needle)
      const children = selfMatches ? node.children : walk(node.children)
      if (selfMatches || children.length > 0) kept.push({ ...node, children })
      return kept
    }, [])
  return walk(nodes)
}

// Depth-first, honouring which crates are expanded — the render order and
// the keyboard order are the same list.
export function flattenCrateTree(
  nodes: CrateNode[],
  expanded: Set<number>,
  depth = 0
): CrateRow[] {
  return nodes.flatMap((node) => {
    const isExpanded = expanded.has(node.id)
    const row: CrateRow = { node, depth, expanded: isExpanded }
    if (!isExpanded || node.children.length === 0) return [row]
    return [row, ...flattenCrateTree(node.children, expanded, depth + 1)]
  })
}

export function allCrateIds(nodes: CrateNode[]): number[] {
  return nodes.flatMap((node) => [node.id, ...allCrateIds(node.children)])
}

// Every ancestor of a crate that already holds any of these tracks, so the
// picker opens showing where they live instead of a wall of collapsed rows.
export function ancestorsOfMembership(
  crates: Crate[],
  crateTrackIds: Map<number, Set<number>>,
  trackIds: number[]
): Set<number> {
  const parentOf = new Map(crates.map((c) => [c.id, c.parent_crate_id]))
  const expanded = new Set<number>()
  for (const crate of crates) {
    const members = crateTrackIds.get(crate.id)
    if (!members || !trackIds.some((id) => members.has(id))) continue
    let cursor = parentOf.get(crate.id) ?? null
    while (cursor !== null && !expanded.has(cursor)) {
      expanded.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
  }
  return expanded
}

export type Membership = 'none' | 'some' | 'all'

// 'some' only happens on a bulk selection: the crate already holds part of
// it. The picker treats that as "not yet added", so toggling adds the rest
// rather than removing what is there.
export function crateMembership(
  members: Set<number> | undefined,
  trackIds: number[]
): Membership {
  if (!members || members.size === 0 || trackIds.length === 0) return 'none'
  const hits = trackIds.reduce((n, id) => n + (members.has(id) ? 1 : 0), 0)
  if (hits === 0) return 'none'
  return hits === trackIds.length ? 'all' : 'some'
}
