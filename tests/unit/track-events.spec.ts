import { test, expect } from '@playwright/test'
import { notifyTrackSaved, onTrackSavedDebounced } from '../../src/renderer/src/lib/trackEvents'

// Inspector > Related re-ranks ~400 ms after a successful save of the track
// it is showing (RelatedTracks.tsx). The timing and filtering live here.

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('a save of this track re-ranks once, after the delay', async () => {
  let runs = 0
  const off = onTrackSavedDebounced(7, 60, () => runs++)
  notifyTrackSaved(7)
  await wait(20)
  expect(runs).toBe(0) // not before the delay
  await wait(80)
  expect(runs).toBe(1)
  off()
})

test('saves in quick succession coalesce into one re-rank', async () => {
  let runs = 0
  const off = onTrackSavedDebounced(7, 60, () => runs++)
  notifyTrackSaved(7)
  await wait(30)
  notifyTrackSaved(7) // e.g. BPM, then a tag, within the window
  await wait(30)
  notifyTrackSaved(7)
  await wait(100)
  expect(runs).toBe(1)
  off()
})

test("another track's save is ignored, and stopping cancels a pending re-rank", async () => {
  let runs = 0
  const off = onTrackSavedDebounced(7, 60, () => runs++)
  notifyTrackSaved(8)
  await wait(100)
  expect(runs).toBe(0)
  notifyTrackSaved(7)
  off() // the Inspector moved to another track
  await wait(100)
  expect(runs).toBe(0)
})
