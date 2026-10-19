import { test, expect } from '@playwright/test'
import {
  ENERGY_MAX,
  ENERGY_MIN,
  FULL_ENERGY_RANGE,
  clampEnergyRange,
  energyInRange,
  isEnergyFilterActive,
  toEnergy
} from '../../src/shared/energy'
import { analysisUpdate } from '../../src/main/analysisUpdate'

// Energy as data (src/shared/energy.ts) and the rule that analysis never
// writes it (src/main/analysisUpdate.ts).

test('one range, whole numbers; unset is null, never 0', () => {
  expect([ENERGY_MIN, ENERGY_MAX]).toEqual([1, 10])
  expect(toEnergy(7)).toBe(7)
  expect(toEnergy('8')).toBe(8)
  expect(toEnergy(6.4)).toBe(6)
  for (const v of [null, undefined, '', 0, -1, 11, NaN, 'high']) expect(toEnergy(v)).toBeNull()
})

test('range filter: inclusive bounds; unset excluded unless asked for', () => {
  const r = { min: 4, max: 7, includeUnset: false }
  expect(energyInRange(4, r)).toBe(true)
  expect(energyInRange(7, r)).toBe(true)
  expect(energyInRange(3, r)).toBe(false)
  expect(energyInRange(8, r)).toBe(false)
  expect(energyInRange(null, r)).toBe(false)
  expect(energyInRange(0, r)).toBe(false) // 0 is not a rating
  expect(energyInRange(null, { ...r, includeUnset: true })).toBe(true)
  expect(energyInRange(null, null)).toBe(true) // no filter
  // Reversed or out-of-range bounds are tidied.
  expect(clampEnergyRange({ min: 9, max: 3, includeUnset: false })).toEqual({
    min: 3,
    max: 9,
    includeUnset: false
  })
})

test('whether a filter narrows anything', () => {
  expect(isEnergyFilterActive(null)).toBe(false)
  expect(isEnergyFilterActive({ ...FULL_ENERGY_RANGE, includeUnset: true })).toBe(false)
  // Full range but unset excluded: it hides unrated tracks, so it is active.
  expect(isEnergyFilterActive(FULL_ENERGY_RANGE)).toBe(true)
  expect(isEnergyFilterActive({ min: 5, max: 10, includeUnset: true })).toBe(true)
})

test('analysis never writes energy', () => {
  const payload = analysisUpdate(
    1,
    { title: 'T', artist: 'A', genre: 'House', comment: null, artwork_path: null },
    { bpm: 124, key_camelot: '8A' }
  )
  expect('energy' in payload).toBe(false)
  expect(payload).toMatchObject({ id: 1, bpm: 124, key_camelot: '8A' })
  // Missing values stay missing (undefined = leave the column alone).
  const sparse = analysisUpdate(
    2,
    {
      title: undefined,
      artist: undefined,
      genre: undefined,
      comment: undefined,
      artwork_path: null
    },
    { bpm: 100, key_camelot: undefined }
  )
  expect(sparse.title).toBeUndefined()
  expect(sparse.key_camelot).toBeUndefined()
})
