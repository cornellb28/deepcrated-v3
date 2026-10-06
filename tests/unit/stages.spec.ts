import { test, expect } from '@playwright/test'
import { cycleHint, nextStageId, stageById, STAGE_NOUN } from '../../src/renderer/src/lib/stages'

// The arithmetic behind clicking a stage pill. Worth covering because the
// only way to reach the first stage again is the wrap, and an off-by-one
// there strands every track on "Gig ready" with no way back.

function stages(): Board[] {
  return [
    { id: 1, name: 'Untagged', color: '#888780', position: 0, created_at: 0 },
    { id: 2, name: 'Tagged', color: '#378ADD', position: 1, created_at: 0 },
    { id: 3, name: 'Crate ready', color: '#1D9E75', position: 2, created_at: 0 },
    { id: 4, name: 'Gig ready', color: '#7F77DD', position: 3, created_at: 0 }
  ]
}

test('advances one stage at a time, in workflow order', () => {
  const s = stages()
  expect(nextStageId(s, 1)).toBe(2)
  expect(nextStageId(s, 2)).toBe(3)
  expect(nextStageId(s, 3)).toBe(4)
})

test('wraps from the last stage back to the first', () => {
  expect(nextStageId(stages(), 4)).toBe(1)
})

test('four clicks return a track to where it started', () => {
  const s = stages()
  let id: number | null = 1
  for (let i = 0; i < s.length; i++) id = nextStageId(s, id)
  expect(id).toBe(1)
})

test('an unknown stage id starts the cycle rather than refusing to move', () => {
  // A track pointing at a deleted stage must still be fixable by clicking it.
  expect(nextStageId(stages(), 99)).toBe(1)
  expect(nextStageId(stages(), null)).toBe(1)
})

test('no stages at all yields null instead of throwing', () => {
  // Would mean the first-launch seed never ran. The pill renders nothing.
  expect(nextStageId([], 1)).toBeNull()
  expect(nextStageId([], null)).toBeNull()
})

test('stageById finds a stage and tolerates a null id', () => {
  expect(stageById(stages(), 3)?.name).toBe('Crate ready')
  expect(stageById(stages(), null)).toBeUndefined()
  expect(stageById(stages(), 99)).toBeUndefined()
})

test('the hint names where the click will land', () => {
  // This string is the pill's tooltip and its accessible name — it is the
  // only thing telling a DJ what the first click will do.
  expect(cycleHint(stages(), 2)).toBe(`${STAGE_NOUN}: Tagged — click for Crate ready`)
  expect(cycleHint(stages(), 4)).toBe(`${STAGE_NOUN}: Gig ready — click for Untagged`)
})

test('the hint degrades rather than blanking when the stage is unknown', () => {
  expect(cycleHint(stages(), 99)).toBe(`Set ${STAGE_NOUN.toLowerCase()} to Untagged`)
  expect(cycleHint([], 1)).toBe(STAGE_NOUN)
})
