import { test, expect } from '@playwright/test'
import {
  DEFAULT_COMBO_SETTINGS,
  comboBpmRanges,
  comboBpmScore,
  comboEnergyScore,
  comboKeyFilter,
  comboKeyScore,
  normalizeComboSettings,
  rankCombos,
  scoreCombo,
  type ComboSettings,
  type ComboTrack
} from '../../src/shared/combos'
import { parseCamelot } from '../../src/shared/trackMatch'

// Find combos scoring (src/shared/combos.ts).

const S: ComboSettings = DEFAULT_COMBO_SETTINGS
const k = (s: string): NonNullable<ReturnType<typeof parseCamelot>> => parseCamelot(s)!
const track = (
  id: number,
  bpm: number | null,
  key: string | null,
  energy: number | null
): ComboTrack => ({
  id,
  bpm,
  key,
  energy
})

test('key: same, ±1 and relative are strongest; +2 boost when allowed', () => {
  expect(comboKeyScore(k('8A'), k('8A'), S)?.label).toBe('same key')
  expect(comboKeyScore(k('8A'), k('9A'), S)?.score).toBe(0.9)
  expect(comboKeyScore(k('8A'), k('7A'), S)?.score).toBe(0.9)
  expect(comboKeyScore(k('12A'), k('1A'), S)?.label).toBe('+1') // wraps round the wheel
  expect(comboKeyScore(k('8A'), k('8B'), S)?.label).toBe('relative')
  expect(comboKeyScore(k('8A'), k('10A'), S)?.label).toBe('+2 energy boost')
  expect(comboKeyScore(k('8A'), k('10A'), { keyStrictness: 'strict', keyBoost: false })).toBeNull()
  expect(comboKeyScore(k('8A'), k('3B'), S)).toBeNull()
  expect(comboKeyScore(k('8A'), k('3B'), { keyStrictness: 'any', keyBoost: true })?.label).toBe(
    'clashing key'
  )
  // The database pre-filter gets exactly the keys the scorer accepts.
  expect(comboKeyFilter('8A', { ...S, keyStrictness: 'strict', keyBoost: false })?.sort()).toEqual(
    ['7A', '8A', '8B', '9A'].sort()
  )
  expect(comboKeyFilter(null, S)).toBeNull()
  expect(comboKeyFilter('8A', { ...S, keyStrictness: 'any' })).toBeNull()
})

test('BPM: percent tolerance, half and double time', () => {
  expect(comboBpmScore(128, 128, S)?.score).toBe(1)
  expect(comboBpmScore(128, 130.7, S)?.label).toBe('+2.1%')
  expect(comboBpmScore(128, 140, S)).toBeNull() // +9.4%, outside ±6
  expect(comboBpmScore(140, 70, S)?.label).toBe('±0.0% (half time)')
  expect(comboBpmScore(70, 141, S)?.label).toContain('(double time)')
  expect(comboBpmScore(140, 70, { ...S, halfDouble: false })).toBeNull()
  const r = comboBpmRanges(100, S)
  expect(r[0][0]).toBeCloseTo(94)
  expect(r[0][1]).toBeCloseTo(106)
  expect(r).toHaveLength(3)
})

test('energy goals', () => {
  expect(comboEnergyScore(6, 6, 'keep')).toBe(1)
  expect(comboEnergyScore(6, 7, 'keep')).toBe(0.85)
  expect(comboEnergyScore(6, 9, 'keep')).toBe(0)
  expect(comboEnergyScore(6, 7, 'build')).toBe(1)
  expect(comboEnergyScore(6, 8, 'build')).toBe(1)
  expect(comboEnergyScore(6, 5, 'build')).toBe(0)
  expect(comboEnergyScore(6, 4, 'down')).toBe(1)
  expect(comboEnergyScore(6, 7, 'down')).toBe(0)
})

test('a full match explains itself', () => {
  const r = scoreCombo(track(1, 128, '8A', 6), track(2, 130.7, '9A', 7), S)!
  expect(r.reasons).toEqual(['Key 8A → 9A (+1)', 'BPM +2.1%', 'Energy 6 → 7'])
  expect(r.partial).toBe(false)
  expect(r.score).toBeCloseTo(0.8, 2)
})

test('missing factors: scored on the rest, marked partial, never thrown away silently', () => {
  const noKey = scoreCombo(track(1, 128, '8A', 6), track(2, 128, null, 6), S)!
  expect(noKey.missing).toEqual(['key'])
  expect(noKey.partial).toBe(true)
  expect(noKey.reasons.at(-1)).toBe('Partial: no key')
  // Source unrated: energy is unknown for everyone, so it costs nothing.
  const noEnergy = scoreCombo(track(1, 128, '8A', null), track(2, 128, '8A', 6), S)!
  expect(noEnergy.missing).toEqual(['energy'])
  expect(noEnergy.score).toBe(1) // perfect on what it has
  // Source rated, candidate not: it cannot be shown to meet the goal.
  const unrated = scoreCombo(track(1, 128, '8A', 6), track(2, 128, '8A', null), {
    ...S,
    goal: 'build'
  })!
  const builds = scoreCombo(track(1, 128, '8A', 6), track(3, 128, '9A', 7), {
    ...S,
    goal: 'build'
  })!
  expect(builds.score).toBeGreaterThan(unrated.score)
  // Neither key nor BPM: nothing to mix on.
  expect(scoreCombo(track(1, 128, '8A', 6), track(2, null, null, 6), S)).toBeNull()
  // Source with no BPM still finds key matches.
  expect(scoreCombo(track(1, null, '8A', null), track(2, 140, '9A', null), S)?.missing).toEqual([
    'bpm',
    'energy'
  ])
})

test('bonuses, penalty and ranking order', () => {
  const src: ComboTrack = {
    ...track(1, 128, '8A', 6),
    genres: ['house'],
    tags: ['pty'],
    crateIds: [3]
  }
  const plain = track(2, 128, '9A', 6)
  const sameGenre: ComboTrack = { ...track(3, 128, '9A', 6), genres: ['house'] }
  const played: ComboTrack = { ...track(4, 128, '9A', 6), recentlyPlayed: true }
  const crate: ComboTrack = { ...track(5, 128, '9A', 6), crateIds: [3] }
  const partial = track(6, 128, null, 6)
  const clash = track(7, 128, '2B', 6)
  const ranked = rankCombos(src, [plain, sameGenre, played, crate, partial, clash, src], S)
  expect(ranked.map((r) => r.id)).toEqual([3, 5, 2, 4, 6])
  // The partial match (no key) ranks below the complete ones.
  expect(ranked.at(-1)?.partial).toBe(true)
  expect(ranked[0].reasons).toContain('Same genre')
  expect(ranked.find((r) => r.id === 4)?.reasons).toContain('Played recently')
  // Missing energy costs nothing; missing key does.
  const tie = rankCombos(src, [track(8, 128, null, 6), track(9, 128, '8A', null)], S)
  expect(tie.map((r) => r.id)).toEqual([9, 8])
  expect(rankCombos(src, [plain], S, 0)).toEqual([])
})

test('settings are validated when loaded', () => {
  expect(normalizeComboSettings(null)).toEqual(DEFAULT_COMBO_SETTINGS)
  expect(
    normalizeComboSettings({ goal: 'build', bpmTolerancePct: 99, keyStrictness: 'x' })
  ).toEqual({
    ...DEFAULT_COMBO_SETTINGS,
    goal: 'build'
  })
})
