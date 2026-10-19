// ── Tag co-occurrence across the library ──────────────────────────────────
// Pure: how often two tags are on the same track compared with chance.
//
//   lift = P(a,b) / (P(a) P(b))            observed over expected; clamped
//   npmi = ln(lift) / -ln(P(a,b))          normalized PMI, bounded -1..1
//
// P(x) is over every track passed in, tagged or not. Pairs on fewer than
// minPairCount tracks, or with a tag on fewer than minTagCount tracks, are
// dropped, so a rare pairing in a large library cannot dominate; NPMI is
// bounded, so neither can a large lift.
//
// Tags are "field:value_key" strings (see tagKeys.ts), already normalized and
// noise-filtered by the caller, so the same text in two fields stays apart.

import { TAG_MATCH_CONFIG } from './tagMatchConfig'

export interface CooccurrenceParams {
  minPairCount: number
  minTagCount: number
  liftCap: number
}

export const DEFAULT_COOCCURRENCE_PARAMS: CooccurrenceParams = {
  minPairCount: TAG_MATCH_CONFIG.cooccurrence.minPairCount,
  minTagCount: TAG_MATCH_CONFIG.cooccurrence.minTagCount,
  liftCap: TAG_MATCH_CONFIG.cooccurrence.liftCap
}

export interface TagPair {
  a: string // a < b
  b: string
  pairCount: number
  countA: number
  countB: number
  lift: number // clamped to liftCap
  npmi: number
}

export interface CooccurrenceResult {
  trackCount: number
  pairs: TagPair[] // npmi descending
}

export function computeCooccurrence(
  trackTags: readonly (readonly string[])[],
  params: CooccurrenceParams = DEFAULT_COOCCURRENCE_PARAMS
): CooccurrenceResult {
  const n = trackTags.length
  if (n === 0) return { trackCount: 0, pairs: [] }

  // Tags → small integers, so pairs count with numeric keys (a large
  // library spends most of its time here otherwise).
  const ids = new Map<string, number>()
  const names: string[] = []
  const perTrack: number[][] = []
  const counts: number[] = []
  for (const tags of trackTags) {
    const seen = new Set<number>()
    for (const t of tags) {
      let id = ids.get(t)
      if (id === undefined) {
        id = names.length
        ids.set(t, id)
        names.push(t)
        counts.push(0)
      }
      if (!seen.has(id)) {
        seen.add(id)
        counts[id]++
      }
    }
    perTrack.push([...seen])
  }

  // Only tags common enough to pair. Ids are ordered by name so each pair
  // has one key with a < b.
  const order = names.map((_, i) => i).sort((x, y) => (names[x] < names[y] ? -1 : 1))
  const rank = new Array<number>(names.length)
  order.forEach((id, r) => (rank[id] = r))
  const m = names.length
  const pairCount = new Map<number, number>()
  for (const unique of perTrack) {
    const eligible = unique
      .filter((id) => counts[id] >= params.minTagCount)
      .map((id) => rank[id])
      .sort((x, y) => x - y)
    for (let i = 0; i < eligible.length; i++) {
      const base = eligible[i] * m
      for (let j = i + 1; j < eligible.length; j++) {
        const key = base + eligible[j]
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }

  const pairs: TagPair[] = []
  for (const [key, count] of pairCount) {
    if (count < params.minPairCount) continue
    const a = names[order[Math.floor(key / m)]]
    const b = names[order[key % m]]
    const countA = counts[ids.get(a)!]
    const countB = counts[ids.get(b)!]
    const pAB = count / n
    const rawLift = (count * n) / (countA * countB)
    // A pair on every track (pAB = 1) has no information: npmi 0.
    const npmi = pAB >= 1 ? 0 : Math.log(rawLift) / -Math.log(pAB)
    pairs.push({
      a,
      b,
      pairCount: count,
      countA,
      countB,
      lift: Math.min(rawLift, params.liftCap),
      npmi: Math.max(-1, Math.min(1, npmi))
    })
  }
  pairs.sort((x, y) => y.npmi - x.npmi || y.pairCount - x.pairCount || (x.a < y.a ? -1 : 1))
  return { trackCount: n, pairs }
}
