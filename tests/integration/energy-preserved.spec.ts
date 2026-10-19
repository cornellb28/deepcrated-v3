import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'
import { analysisUpdate } from '../../src/main/analysisUpdate'

// A user-set energy survives re-import (the upsert), a rescan's re-read and
// re-analysis, against the real schema (db.ts).

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession
test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => probe.cleanup())

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

const file = { filepath: '/music/e.mp3', filename: 'e.mp3', title: 'E', artist: 'A' }

test('re-import, rescan and re-analysis never overwrite a user-set energy', async () => {
  const [inserted] = await run<{ lastInsertRowid: number }>([
    { fn: 'insertTrack', args: [{ ...file, bpm: 120 }] }
  ])
  const id = inserted.lastInsertRowid
  await run([{ fn: 'updateTrackMeta', args: [{ id, energy: 7 }] }])

  // Re-import / rescan: the same file read again, which carries no energy.
  await run([{ fn: 'insertTrack', args: [{ ...file, bpm: 121, energy: null }] }])
  // Re-analysis, through the payload both analysis paths now build.
  await run([
    {
      fn: 'updateTrackMeta',
      args: [
        analysisUpdate(
          id,
          { title: 'E', artist: 'A', genre: null, comment: null, artwork_path: null },
          { bpm: 122, key_camelot: '8A' }
        )
      ]
    }
  ])
  const [row] = await run<{ energy: number | null; bpm: number; key_camelot: string }>([
    { fn: 'getTrackById', args: [id] }
  ])
  expect(row.energy).toBe(7)
  expect(row.bpm).toBe(122) // the analysis itself did land
  expect(row.key_camelot).toBe('8A')

  // The DJ clearing it is the one thing that does change it.
  await run([{ fn: 'updateTrackMeta', args: [{ id, energy: null }] }])
  const [cleared] = await run<{ energy: number | null }>([{ fn: 'getTrackById', args: [id] }])
  expect(cleared.energy).toBeNull()
})
