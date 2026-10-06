// ── Stacking tag filters ──────────────────────────────────────────────────
// The Tags page starts from one tag and narrows: each tag added has to be on
// the track as well, never instead of. AND, not OR — "peak time" plus "house"
// means both, which is the only reading that makes adding a tag a *filter*.
//
// Pure and React-free so the set arithmetic is unit-testable, the same split
// as lib/selection.ts and lib/stages.ts.

export interface TagCount {
  tag: Tag
  count: number
}

// Tracks carrying EVERY one of `tagIds`.
export function tracksMatchingTags(
  tracks: readonly Track[],
  trackTags: ReadonlyMap<number, Tag[]>,
  tagIds: readonly number[]
): Track[] {
  if (tagIds.length === 0) return [...tracks]

  return tracks.filter((track) => {
    const applied = trackTags.get(track.id)
    if (!applied || applied.length === 0) return false
    return tagIds.every((id) => applied.some((t) => t.id === id))
  })
}

// The tags worth offering next: the ones that actually appear on the tracks
// currently showing, minus the ones already applied.
//
// Deliberately NOT the library's most-used tags. Suggesting a globally
// popular tag that happens to share no track with the current filter gives a
// DJ a row of buttons that lead to "no tracks" — every suggestion here is
// guaranteed to leave at least one track behind, because it was counted off
// the current result.
//
// Ties break alphabetically so the row does not reshuffle between renders.
export function coOccurringTags(
  tracks: readonly Track[],
  trackTags: ReadonlyMap<number, Tag[]>,
  excludeIds: readonly number[],
  limit = 40
): TagCount[] {
  const exclude = new Set(excludeIds)
  const counts = new Map<number, TagCount>()

  for (const track of tracks) {
    for (const tag of trackTags.get(track.id) ?? []) {
      if (exclude.has(tag.id)) continue
      const existing = counts.get(tag.id)
      if (existing) existing.count++
      else counts.set(tag.id, { tag, count: 1 })
    }
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.tag.value.localeCompare(b.tag.value))
    .slice(0, limit)
}

// Adding an already-present tag is a no-op rather than a duplicate: the same
// tag can be reached from a badge, from the cloud and from the suggestion
// row, and none of those paths should be able to stack it twice.
export function addTag(selected: readonly Tag[], tag: Tag): Tag[] {
  if (selected.some((t) => t.id === tag.id)) return [...selected]
  return [...selected, tag]
}

export function removeTag(selected: readonly Tag[], tagId: number): Tag[] {
  return selected.filter((t) => t.id !== tagId)
}
