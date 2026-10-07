// ── Artist-name cleanup: re-cleaning an existing library ──────────────────
// The same engine, applied to what is already there, as a DRY RUN: nothing is
// written. The result groups every proposed change by canonical name and
// confidence tier so it can be reviewed before anything is applied.
//
// Pure, and async only so a large library yields to the event loop between
// slices instead of blocking the main process.

import { isChange, type ArtistIndex, type Confidence, type CleanReason } from './clean'

export interface RecleanTrack {
  id: number
  // The artist names this track currently has: its artist tags if it has any,
  // else its artist column split on " / ". Already split.
  parts: string[]
}

export interface RecleanItem {
  raw: string
  reason: CleanReason
  trackIds: number[]
}

export interface RecleanGroup {
  canonical: string
  tier: Confidence
  items: RecleanItem[]
  trackCount: number
}

export interface RecleanPreview {
  groups: RecleanGroup[]
  // Distinct names looked at, and tracks that would change, for the summary.
  distinctNames: number
  tracksAffected: number
  byTier: Record<Confidence, number>
}

const TIER_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

export async function buildRecleanPreview(
  tracks: readonly RecleanTrack[],
  index: ArtistIndex,
  opts: {
    sliceSize?: number
    yieldToLoop?: () => Promise<void>
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<RecleanPreview> {
  const slice = opts.sliceSize ?? 200
  const yieldNow = opts.yieldToLoop ?? (() => new Promise<void>((r) => setImmediate(r)))

  // raw name -> the tracks that carry it
  const byRaw = new Map<string, number[]>()
  for (let i = 0; i < tracks.length; i++) {
    for (const part of tracks[i].parts) {
      const list = byRaw.get(part) ?? []
      list.push(tracks[i].id)
      byRaw.set(part, list)
    }
    if (i % slice === slice - 1) {
      opts.onProgress?.(i + 1, tracks.length)
      await yieldNow()
    }
  }

  const groups = new Map<string, RecleanGroup>()
  let distinct = 0
  const affected = new Set<number>()
  const names = [...byRaw.keys()]
  for (let i = 0; i < names.length; i++) {
    const raw = names[i]
    distinct++
    const result = index.clean(raw)
    if (isChange(result)) {
      const ids = byRaw.get(raw) as number[]
      const key = `${result.confidence}\u0000${result.canonical}`
      const group = groups.get(key) ?? {
        canonical: result.canonical,
        tier: result.confidence,
        items: [],
        trackCount: 0
      }
      group.items.push({ raw, reason: result.reason, trackIds: ids })
      group.trackCount += ids.length
      groups.set(key, group)
      for (const id of ids) affected.add(id)
    }
    if (i % (slice * 2) === slice * 2 - 1) await yieldNow()
  }

  const list = [...groups.values()].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      b.trackCount - a.trackCount ||
      (a.canonical < b.canonical ? -1 : 1)
  )
  for (const g of list)
    g.items.sort((a, b) => b.trackIds.length - a.trackIds.length || (a.raw < b.raw ? -1 : 1))
  opts.onProgress?.(tracks.length, tracks.length)

  return {
    groups: list,
    distinctNames: distinct,
    tracksAffected: affected.size,
    byTier: {
      high: list.filter((g) => g.tier === 'high').reduce((n, g) => n + g.trackCount, 0),
      medium: list.filter((g) => g.tier === 'medium').reduce((n, g) => n + g.trackCount, 0),
      low: list.filter((g) => g.tier === 'low').reduce((n, g) => n + g.trackCount, 0)
    }
  }
}
