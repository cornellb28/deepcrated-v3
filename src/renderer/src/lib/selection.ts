// ── Track selection ───────────────────────────────────────────────────────
// The arithmetic behind a click on a selection checkbox, kept separate from
// the components so the range rules can be tested without a DOM.
//
// "Visual order" is whatever array the caller passes as `orderedIds`. A view
// passes the same filtered-and-sorted result it renders, so list mode
// (top to bottom) and grid mode (row-major, left to right) produce the same
// ranges from the same two clicks — the grid is the same array laid out in
// rows, not a different ordering.

export interface SelectModifiers {
  shift: boolean
}

export function selectAll(ids: readonly number[]): Set<number> {
  return new Set(ids)
}

export function toggleSelection(prev: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// Adds the inclusive span between two ids onto the existing selection.
// Additive rather than replacing: shift-clicking a second range extends the
// selection instead of discarding the first, which is what every file
// manager does and what a DJ building a crate expects.
//
// Falls back to a plain toggle when there is no usable anchor — no previous
// click, or an anchor that has since been filtered out of the visible list.
export function rangeSelection(
  prev: ReadonlySet<number>,
  orderedIds: readonly number[],
  anchorId: number | null,
  targetId: number
): Set<number> {
  if (anchorId === null) return toggleSelection(prev, targetId)

  const anchorIndex = orderedIds.indexOf(anchorId)
  const targetIndex = orderedIds.indexOf(targetId)
  if (anchorIndex === -1 || targetIndex === -1) return toggleSelection(prev, targetId)

  const from = Math.min(anchorIndex, targetIndex)
  const to = Math.max(anchorIndex, targetIndex)

  const next = new Set(prev)
  for (let i = from; i <= to; i++) next.add(orderedIds[i])
  return next
}

// The whole decision behind one click, and the only entry point a view
// needs. Returns the new anchor alongside the new selection: a shift-click
// deliberately leaves the anchor where it was, so a third shift-click
// re-spans from the same origin rather than from the last thing clicked.
export function applySelection(
  prev: ReadonlySet<number>,
  orderedIds: readonly number[],
  id: number,
  modifiers: SelectModifiers | undefined,
  anchorId: number | null
): { selected: Set<number>; anchorId: number | null } {
  if (modifiers?.shift) {
    return {
      selected: rangeSelection(prev, orderedIds, anchorId, id),
      // An anchorless shift-click degraded to a toggle above, so it is that
      // click which becomes the anchor for the next one.
      anchorId: anchorId ?? id
    }
  }
  return { selected: toggleSelection(prev, id), anchorId: id }
}
