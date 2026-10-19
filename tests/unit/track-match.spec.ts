import { test, expect } from '@playwright/test'
import {
  applyGigPreset,
  bpmRanges,
  bpmScore,
  compatibleKeys,
  DEFAULT_PROFILE,
  effectiveWeights,
  energyScore,
  energyTarget,
  keyScore,
  normalizeProfile,
  normalizeTagWeights,
  parseCamelot,
  preFilterKeys,
  rankCandidates,
  rebalanceTagWeights,
  sharesArtist,
  tagScore,
  tempoMatch,
  type Camelot,
  type MatchTrack,
  type MixProfile
} from '../../src/shared/trackMatch'

// The pure Track Match scorer (src/shared/trackMatch.ts): no database, no
// Electron — the same module mobile will reuse.

const profile = (over: Partial<MixProfile> = {}): MixProfile => ({ ...DEFAULT_PROFILE, ...over })
const k = (s: string): Camelot => parseCamelot(s)!

// ── keys ──────────────────────────────────────────────────────────────────

test('Camelot keys parse; anything else (including "?") is no key', () => {
  expect(parseCamelot('8A')).toEqual({ number: 8, letter: 'A' })
  expect(parseCamelot(' 12b ')).toEqual({ number: 12, letter: 'B' })
  for (const bad of ['?', '', null, '13A', '0B', 'Am', '8C']) expect(parseCamelot(bad)).toBeNull()
})

test('strict: same key, ±1 on the wheel (wrapping 12→1) and the relative key only', () => {
  const keys = compatibleKeys(k('12A'), 'strict').map((r) => r.key)
  expect(keys.sort()).toEqual(['11A', '12A', '12B', '1A'].sort())
  expect(keyScore(k('8A'), k('9A'), 'strict')).toEqual({ score: 0.9, reason: '8A → 9A' })
  expect(keyScore(k('8A'), k('8B'), 'strict').score).toBe(0.85)
  expect(keyScore(k('8A'), k('10A'), 'strict').score).toBe(0)
})

test('flexible adds ±2 and the energy-boost jump (+7); scores rank below the strict moves', () => {
  const keys = compatibleKeys(k('8A'), 'flexible').map((r) => r.key)
  expect(keys).toEqual(expect.arrayContaining(['10A', '6A', '3A']))
  expect(keyScore(k('8A'), k('10A'), 'flexible').score).toBeLessThan(
    keyScore(k('8A'), k('9A'), 'flexible').score
  )
  expect(keyScore(k('8A'), k('4B'), 'flexible').score).toBe(0)
})

test('loose accepts every key but still prefers compatible ones; no SQL key filter', () => {
  expect(compatibleKeys(k('8A'), 'loose')).toHaveLength(24)
  expect(keyScore(k('8A'), k('3B'), 'loose').score).toBe(0.2)
  expect(preFilterKeys('8A', profile({ keyMode: 'loose' }))).toBeNull()
  expect(preFilterKeys('8A', profile({ keyMode: 'strict' }))).toHaveLength(4)
})

// ── BPM ───────────────────────────────────────────────────────────────────

test('the SQL ranges cover the window, plus half and double time when allowed', () => {
  expect(bpmRanges(124, profile({ bpmWindow: 6, halfDouble: false }))).toEqual([[118, 130]])
  expect(bpmRanges(124, profile({ bpmWindow: 6, halfDouble: true }))).toEqual([
    [118, 130],
    [59, 65],
    [236, 260]
  ])
  expect(bpmRanges(100, profile({ bpmWindow: 'wide', halfDouble: false }))).toEqual([[84, 116]])
})

test('half/double time: a 64 BPM track matches 126 as half time, only when allowed', () => {
  expect(tempoMatch(126, 64, true)).toEqual({ effective: 128, factor: 2, delta: 2 })
  expect(tempoMatch(126, 64, false).factor).toBe(1)
  const on = bpmScore(126, 64, profile({ bpmWindow: 6, halfDouble: true }))
  expect(on.score).toBeCloseTo(1 - 2 / 6)
  expect(on.reason).toBe('+2 BPM (half time)')
  expect(bpmScore(126, 64, profile({ bpmWindow: 6, halfDouble: false })).score).toBe(0)
})

test('BPM score is 1 at the same tempo and 0 at the edge of the window', () => {
  const p = profile({ bpmWindow: 6, halfDouble: false })
  expect(bpmScore(124, 124, p).score).toBe(1)
  expect(bpmScore(124, 127, p).score).toBeCloseTo(0.5)
  expect(bpmScore(124, 130, p).score).toBe(0)
  expect(bpmScore(124, 131, p).score).toBe(0)
  expect(bpmScore(124, 122, p).reason).toBe('−2 BPM')
})

// ── direction ─────────────────────────────────────────────────────────────

test('Lift / Drop move the energy target one step (clamped 1..10); Similar keeps it', () => {
  expect(energyTarget(6, 'lift')).toBe(7)
  expect(energyTarget(6, 'drop')).toBe(5)
  expect(energyTarget(6, 'similar')).toBe(6)
  expect(energyTarget(10, 'lift')).toBe(10)
  expect(energyTarget(1, 'drop')).toBe(1)
  // E7 is the best Lift from E6, E5 the best Drop.
  expect(energyScore(6, 7, 'lift', 'gradual').score).toBe(1)
  expect(energyScore(6, 5, 'lift', 'gradual').score).toBeLessThan(
    energyScore(6, 7, 'lift', 'gradual').score
  )
  expect(energyScore(6, 5, 'drop', 'gradual').score).toBe(1)
  // "Big swings" falls off more gently.
  expect(energyScore(6, 9, 'similar', 'swings').score).toBeGreaterThan(
    energyScore(6, 9, 'similar', 'gradual').score
  )
})

test('with no energy, Lift keeps only faster tracks and Drop only slower ones, inside the window', () => {
  const p = profile({ bpmWindow: 6, halfDouble: false })
  expect(bpmScore(124, 127, p, 1).score).toBe(1) // half a window up is the sweet spot
  expect(bpmScore(124, 125, p, 1).score).toBeCloseTo(2 / 3)
  expect(bpmScore(124, 121, p, 1).score).toBe(0) // wrong side
  expect(bpmScore(124, 124, p, 1).score).toBe(0) // same tempo is not a lift
  expect(bpmScore(124, 121, p, -1).score).toBe(1)
  expect(bpmScore(124, 131, p, 1).score).toBe(0) // still never outside the window

  const source: MatchTrack = { id: 1, bpm: 124, key: '8A' }
  const cands: MatchTrack[] = [
    { id: 2, bpm: 121, key: '8A' },
    { id: 3, bpm: 127, key: '8A' }
  ]
  const withSame = [...cands, { id: 4, bpm: 124, key: '8A' }]
  const lift = rankCandidates(source, withSame, p, { direction: 'lift', coldStart: true })
  const drop = rankCandidates(source, withSame, p, { direction: 'drop', coldStart: true })
  const similar = rankCandidates(source, withSame, p, { direction: 'similar', coldStart: true })
  if (lift.status !== 'ok' || drop.status !== 'ok' || similar.status !== 'ok') {
    throw new Error('expected ok')
  }
  expect(lift.results.map((r) => r.id)).toEqual([3])
  expect(drop.results.map((r) => r.id)).toEqual([2])
  expect(similar.results[0].id).toBe(4) // Similar still prefers the same tempo
})

test('with energy on both tracks, Lift ranks the one-step-up track first', () => {
  const p = profile({ bpmWindow: 6, halfDouble: false })
  const tags = { genre: ['House'] }
  const source: MatchTrack = { id: 1, bpm: 124, key: '8A', energy: 6, tags }
  const cands: MatchTrack[] = [
    { id: 2, bpm: 124, key: '8A', energy: 5, tags },
    { id: 3, bpm: 124, key: '8A', energy: 7, tags }
  ]
  const lift = rankCandidates(source, cands, p, { direction: 'lift' })
  if (lift.status !== 'ok') throw new Error('expected ok')
  expect(lift.results.map((r) => r.id)).toEqual([3, 2])
  expect(lift.results[0].reasons).toContain('E6 → E7')
})

// ── variety ───────────────────────────────────────────────────────────────

test('artists match on any shared name, across " | " and legacy " / " lists', () => {
  expect(sharesArtist('ATCQ | VLVT JONES', 'atcq')).toBe(true)
  expect(sharesArtist('Sade / MF DOOM', 'MF DOOM')).toBe(true)
  expect(sharesArtist('Tyler, The Creator', 'The Creator')).toBe(false)
  expect(sharesArtist(null, 'X')).toBe(false)
})

test('favor variety penalises same-artist candidates; "same artist often" does not', () => {
  const source: MatchTrack = { id: 1, bpm: 124, key: '8A', artist: 'Sade' }
  const cands: MatchTrack[] = [
    { id: 2, bpm: 124, key: '8A', artist: 'Sade' },
    { id: 3, bpm: 124, key: '8A', artist: 'Other' }
  ]
  const varied = rankCandidates(source, cands, profile({ variety: 'favor_variety' }), {
    coldStart: true
  })
  const same = rankCandidates(source, cands, profile({ variety: 'same_ok' }), { coldStart: true })
  if (varied.status !== 'ok' || same.status !== 'ok') throw new Error('expected ok')
  expect(varied.results[0].id).toBe(3)
  expect(varied.results[1].reasons).toContain('same artist')
  expect(varied.results[1].score).toBeCloseTo(varied.results[0].score * 0.8)
  expect(same.results[0].score).toBe(same.results[1].score)
})

// ── tags, weights, cold start ─────────────────────────────────────────────

test('tag score is weighted overlap by tag type, and names what is shared', () => {
  const w = normalizeTagWeights({ genre: 50, grouping: 50 })
  const t = tagScore(
    { genre: ['Afrobeats', 'House'], grouping: ['Peak'] },
    { genre: ['afrobeats'], grouping: ['Peak'] },
    w
  )
  expect(t.score).toBeCloseTo(0.5 * 0.5 + 0.5 * 1)
  expect(t.shared).toEqual(['Afrobeats', 'Peak'])
  // A type the source has nothing for does not count either way.
  expect(tagScore({ genre: ['House'] }, { genre: ['House'], label: ['X'] }, w).score).toBe(1)
})

test('weights drop energy and tags when they cannot be scored, and still sum to 1', () => {
  const all = effectiveWeights(profile(), { energy: true, tags: true })
  const keyBpm = effectiveWeights(profile(), { energy: false, tags: false })
  const sum = (w: typeof all): number => w.key + w.bpm + w.energy + w.tags
  expect(sum(all)).toBeCloseTo(1)
  expect(sum(keyBpm)).toBeCloseTo(1)
  expect(keyBpm.energy).toBe(0)
  expect(keyBpm.tags).toBe(0)
  // "I control energy myself": energy is not scored.
  expect(
    effectiveWeights(profile({ energyMovement: 'manual' }), { energy: true, tags: true }).energy
  ).toBe(0)
})

test('cold start falls back to key + BPM; an untagged source is a cold start too', () => {
  const source: MatchTrack = { id: 1, bpm: 124, key: '8A', tags: { genre: ['House'] } }
  const cands: MatchTrack[] = [
    { id: 2, bpm: 125, key: '8A', tags: { genre: ['House'] } },
    { id: 3, bpm: 124, key: '8A', tags: { genre: ['Techno'] } }
  ]
  const warm = rankCandidates(source, cands, profile({ halfDouble: false }), {})
  const cold = rankCandidates(source, cands, profile({ halfDouble: false }), { coldStart: true })
  if (warm.status !== 'ok' || cold.status !== 'ok') throw new Error('expected ok')
  expect(warm.results[0].id).toBe(2) // the shared genre outweighs 1 BPM
  expect(cold.results[0].id).toBe(3) // key + BPM only: the exact tempo wins
  expect(cold.usedTags).toBe(false)
  const untagged = rankCandidates({ ...source, tags: {} }, cands, profile(), {})
  if (untagged.status !== 'ok') throw new Error('expected ok')
  expect(untagged.usedTags).toBe(false)
})

test('the source track is excluded, results are capped, and a source without key/BPM asks for them', () => {
  const source: MatchTrack = { id: 1, bpm: 124, key: '8A' }
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, bpm: 124, key: '8A' }))
  const r = rankCandidates(source, many, profile(), { coldStart: true, limit: 20 })
  if (r.status !== 'ok') throw new Error('expected ok')
  expect(r.results).toHaveLength(20)
  expect(r.results.some((x) => x.id === 1)).toBe(false)
  expect(rankCandidates({ id: 1, bpm: 124, key: '?' }, many, profile()).status).toBe(
    'needs-key-bpm'
  )
  expect(rankCandidates({ id: 1, bpm: null, key: '8A' }, many, profile()).status).toBe(
    'needs-key-bpm'
  )
})

// ── the profile ───────────────────────────────────────────────────────────

test('no survey (or skipped): the defaults, complete and valid', () => {
  expect(normalizeProfile(null)).toEqual(DEFAULT_PROFILE)
  expect(normalizeProfile({})).toEqual(DEFAULT_PROFILE)
  expect(Object.values(DEFAULT_PROFILE.tagWeights).reduce((a, b) => a + b, 0)).toBe(100)
})

test('stored answers are validated: unknown values fall back, tag points rescale to 100', () => {
  const p = normalizeProfile({
    keyMode: 'strict',
    bpmWindow: 7,
    halfDouble: 'yes',
    tagWeights: { genre: 1, grouping: 1, label: 1 }
  })
  expect(p.keyMode).toBe('strict')
  expect(p.bpmWindow).toBe(DEFAULT_PROFILE.bpmWindow)
  expect(p.halfDouble).toBe(DEFAULT_PROFILE.halfDouble)
  expect(p.tagWeights).toEqual({
    genre: 34,
    grouping: 33,
    label: 33,
    remixer: 0,
    comment: 0,
    composer: 0,
    vibe: 0,
    venue: 0,
    custom: 0
  })
  expect(normalizeTagWeights({})).toEqual(DEFAULT_PROFILE.tagWeights)
})

test('a profile saved with the old "Other tags" bucket keeps its points, on comment', () => {
  const p = normalizeProfile({
    tagWeights: { genre: 40, grouping: 25, label: 15, remixer: 10, other: 10 }
  })
  expect(p.tagWeights).toEqual({
    genre: 40,
    grouping: 25,
    label: 15,
    remixer: 10,
    comment: 10,
    composer: 0,
    vibe: 0,
    venue: 0,
    custom: 0
  })
})

test('a gig preset fills the other answers but keeps the tag points', () => {
  const custom = {
    ...DEFAULT_PROFILE,
    tagWeights: {
      genre: 100,
      grouping: 0,
      label: 0,
      remixer: 0,
      comment: 0,
      composer: 0,
      vibe: 0,
      venue: 0,
      custom: 0
    }
  }
  const club = applyGigPreset(custom, 'club')
  expect(club).toMatchObject({ gig: 'club', keyMode: 'strict', bpmWindow: 3, halfDouble: false })
  expect(club.tagWeights.genre).toBe(100)
})

test('moving one tag slider rebalances the others and always totals 100', () => {
  const start = DEFAULT_PROFILE.tagWeights // genre 35, grouping 20, ...
  const next = rebalanceTagWeights(start, 'genre', 70)
  expect(next.genre).toBe(70)
  expect(Object.values(next).reduce((a, b) => a + b, 0)).toBe(100)
  // The others keep their proportions: grouping still the largest of them.
  expect(next.grouping).toBeGreaterThan(next.label)
  const all = rebalanceTagWeights(start, 'custom', 100)
  expect(all).toEqual({
    genre: 0,
    grouping: 0,
    label: 0,
    remixer: 0,
    comment: 0,
    composer: 0,
    vibe: 0,
    venue: 0,
    custom: 100
  })
  // From all-in-one, the rest is spread evenly: 40 over the other 8.
  const back = rebalanceTagWeights(all, 'custom', 60)
  expect(back).toEqual({
    genre: 5,
    grouping: 5,
    label: 5,
    remixer: 5,
    comment: 5,
    composer: 5,
    vibe: 5,
    venue: 5,
    custom: 60
  })
})
