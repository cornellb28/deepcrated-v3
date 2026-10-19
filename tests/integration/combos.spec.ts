import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Find combos against the real schema (db.ts), through main/comboService.ts.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession
test.beforeEach(() => {
  probe = createProbeSession()
})
test.afterEach(() => probe.cleanup())

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

function track(n: number, extra: Record<string, unknown>): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [{ filepath: `/music/${n}.mp3`, filename: `${n}.mp3`, title: `T${n}`, ...extra }]
  }
}

interface Response {
  status: string
  results: { id: number; reasons: string[]; partial: boolean; missing: string[] }[]
  considered: number
}

test('candidates come from the database cut; partial matches are kept and marked', async () => {
  await run([
    track(1, { bpm: 128, key_camelot: '8A', genre: 'House' }),
    track(2, { bpm: 129, key_camelot: '9A', genre: 'House' }), // full match
    track(3, { bpm: 128, key_camelot: null }), // no key: partial
    track(4, { bpm: null, key_camelot: '8B' }), // no BPM: partial
    track(5, { bpm: 150, key_camelot: '8A' }), // BPM out of range
    track(6, { bpm: 128, key_camelot: '3B' }), // clashing key
    track(7, { bpm: 64, key_camelot: '8A' }), // half time
    track(8, { bpm: null, key_camelot: null }) // nothing to go on
  ])
  await run([
    { fn: 'updateTrackMeta', args: [{ id: 1, energy: 6 }] },
    { fn: 'updateTrackMeta', args: [{ id: 2, energy: 7 }] }
  ])
  const [r] = await run<Response>([{ fn: 'findCombos', args: [1, { goal: 'build' }] }])
  expect(r.status).toBe('ok')
  const ids = r.results.map((x) => x.id)
  // Goal "build" from energy 6: track 2 (rated 7, +1 key) leads; track 7 is
  // a perfect key/tempo fit but unrated, so it cannot be shown to build.
  expect(ids.slice(0, 2)).toEqual([2, 7])
  expect(r.results.slice(1).every((x) => x.partial)).toBe(true)
  expect(new Set(ids)).toEqual(new Set([2, 3, 4, 7]))
  expect(r.results.find((x) => x.id === 2)?.reasons).toEqual([
    'Key 8A → 9A (+1)',
    'BPM +0.8%',
    'Energy 6 → 7',
    'Same genre'
  ])
  expect(r.results.find((x) => x.id === 3)?.missing).toContain('key')
  expect(r.results.find((x) => x.id === 4)?.missing).toContain('bpm')
  expect(r.results.find((x) => x.id === 7)?.reasons[1]).toContain('half time')
  const [none] = await run<Response>([{ fn: 'findCombos', args: [999, {}] }])
  expect(none.status).toBe('not-found')
})
