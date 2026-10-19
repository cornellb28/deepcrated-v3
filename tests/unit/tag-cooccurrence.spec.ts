import { test, expect } from '@playwright/test'
import { computeCooccurrence, type CooccurrenceParams } from '../../src/shared/tagCooccurrence'

// Tag co-occurrence (src/shared/tagCooccurrence.ts): lift and NPMI with the
// minimum counts and the clamp that keep rare pairings from dominating.

const params: CooccurrenceParams = { minPairCount: 3, minTagCount: 5, liftCap: 8 }

// n tracks, each given the listed tags.
function tracks(...groups: [number, string[]][]): string[][] {
  return groups.flatMap(([n, tags]) => Array.from({ length: n }, () => [...tags]))
}

test('lift and NPMI match the definitions', () => {
  // 100 tracks: a on 20, b on 10, both on 8.
  const lib = tracks([8, ['a', 'b']], [12, ['a']], [2, ['b']], [78, []])
  const { trackCount, pairs } = computeCooccurrence(lib, params)
  expect(trackCount).toBe(100)
  expect(pairs).toHaveLength(1)
  const p = pairs[0]
  expect(p).toMatchObject({ a: 'a', b: 'b', pairCount: 8, countA: 20, countB: 10 })
  expect(p.lift).toBeCloseTo(0.08 / (0.2 * 0.1)) // 4
  expect(p.npmi).toBeCloseTo(Math.log(4) / -Math.log(0.08))
})

test('a pair on fewer than minPairCount tracks is dropped', () => {
  const lib = tracks([2, ['a', 'b']], [10, ['a']], [10, ['b']], [78, []])
  expect(computeCooccurrence(lib, params).pairs).toEqual([])
})

test('a tag on fewer than minTagCount tracks never pairs, however strong the pairing', () => {
  // "rare" is only ever with "a" — a perfect but tiny pairing.
  const lib = tracks([4, ['a', 'rare']], [30, ['a']], [66, []])
  expect(computeCooccurrence(lib, params).pairs).toEqual([])
})

test('lift is clamped, and NPMI stays within -1..1', () => {
  // Two tags only ever together, on 5 of 1000 tracks: raw lift 200.
  const lib = tracks([5, ['x', 'y']], [995, []])
  const [p] = computeCooccurrence(lib, params).pairs
  expect(p.lift).toBe(8)
  expect(p.npmi).toBeLessThanOrEqual(1)
  expect(p.npmi).toBeCloseTo(1) // perfect association
})

test('tags that avoid each other get negative NPMI; a tag on every track carries no information', () => {
  // a and b each on half the library, together less than chance.
  const lib = tracks([5, ['a', 'b']], [45, ['a']], [45, ['b']], [5, []])
  const [p] = computeCooccurrence(lib, params).pairs
  expect(p.npmi).toBeLessThan(0)
  const everywhere = tracks([50, ['all', 'c']], [50, ['all']])
  const [q] = computeCooccurrence(everywhere, params).pairs
  expect(q.lift).toBeCloseTo(1)
  expect(q.npmi).toBeCloseTo(0)
})

test('duplicate tags on one track count once; results sort by NPMI', () => {
  const lib = tracks([6, ['a', 'a', 'b']], [6, ['c', 'd']], [6, ['c']], [6, ['d']], [76, []])
  const { pairs } = computeCooccurrence(lib, params)
  expect(pairs.find((p) => p.a === 'a')?.pairCount).toBe(6)
  expect(pairs.map((p) => `${p.a}+${p.b}`)).toEqual(['a+b', 'c+d'])
  expect(computeCooccurrence([], params)).toEqual({ trackCount: 0, pairs: [] })
})
