import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Mix Profile storage and Track Match candidate selection against the real
// SQLite schema (db.ts), through main/trackMatchService.ts.

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

interface Stored {
  profile: Record<string, unknown>
  state: string
  updatedAt: number | null
}

test('no row means the defaults; skipping stores them; client_uuid is minted once', async () => {
  const [before] = await run<Stored>([{ fn: 'loadMixProfile' }])
  expect(before.state).toBe('defaults')
  expect(before.updatedAt).toBeNull()
  expect(before.profile).toMatchObject({ keyMode: 'flexible', bpmWindow: 6 })

  const [skipped, row1] = await run<unknown>([
    { fn: 'saveMixProfile', args: [{}, 'skipped'] },
    { fn: 'getMixProfileRow' }
  ])
  expect(skipped).toMatchObject({ state: 'skipped', profile: before.profile })
  const first = row1 as { client_uuid: string; updated_at: number }
  expect(first.client_uuid).toMatch(/^[0-9a-f-]{36}$/)

  await new Promise((r) => setTimeout(r, 5))
  const [, row2, after] = await run<unknown>([
    { fn: 'saveMixProfile', args: [{ keyMode: 'strict', bpmWindow: 3 }, 'completed'] },
    { fn: 'getMixProfileRow' },
    { fn: 'loadMixProfile' }
  ])
  const second = row2 as { client_uuid: string; updated_at: number; survey_state: string }
  expect(second.client_uuid).toBe(first.client_uuid) // never re-minted
  expect(second.updated_at).toBeGreaterThan(first.updated_at) // stamped every write
  expect(second.survey_state).toBe('completed')
  expect((after as Stored).profile).toMatchObject({ keyMode: 'strict', bpmWindow: 3 })
})

test('the pre-filter keeps the window (and half/double time), excludes the source, and ranks', async () => {
  const ops: ProbeOp[] = [
    track(1, { bpm: 124, key_camelot: '8A', artist: 'A', genre: 'House' }),
    track(2, { bpm: 125, key_camelot: '9A', artist: 'B', genre: 'House' }), // close
    track(3, { bpm: 62, key_camelot: '8A', artist: 'C', genre: 'House' }), // half time
    track(4, { bpm: 140, key_camelot: '8A', artist: 'D', genre: 'House' }), // outside window
    track(5, { bpm: 124, key_camelot: '3B', artist: 'E', genre: 'House' }), // incompatible key
    track(6, { bpm: 124, key_camelot: '?', artist: 'F', genre: 'House' }), // no key
    {
      fn: 'saveMixProfile',
      args: [{ keyMode: 'strict', bpmWindow: 6, halfDouble: true }, 'completed']
    },
    { fn: 'getRelatedTracks', args: [1, 'similar'] },
    {
      fn: 'saveMixProfile',
      args: [{ keyMode: 'strict', bpmWindow: 6, halfDouble: false }, 'completed']
    },
    { fn: 'getRelatedTracks', args: [1, 'similar'] }
  ]
  const r = await run<unknown>(ops)
  const withHalf = r[7] as { status: string; results: { id: number; reasons: string[] }[] }
  const withoutHalf = r[9] as typeof withHalf
  expect(withHalf.status).toBe('ok')
  expect(withHalf.results.map((x) => x.id).sort()).toEqual([2, 3])
  expect(withHalf.results.find((x) => x.id === 3)?.reasons).toContain('±0 BPM (half time)')
  expect(withoutHalf.results.map((x) => x.id)).toEqual([2])
})

test('candidates are capped and a track without key or BPM asks for them', async () => {
  const many: ProbeOp[] = Array.from({ length: 230 }, (_, i) =>
    track(i + 10, { bpm: 124, key_camelot: '8A', artist: `X${i}` })
  )
  const r = await run<unknown>([
    track(1, { bpm: 124, key_camelot: '8A' }),
    track(2, { bpm: null, key_camelot: '8A' }),
    track(3, { bpm: 124, key_camelot: '?' }),
    ...many,
    { fn: 'getRelatedTracks', args: [1, 'similar'] },
    { fn: 'getRelatedTracks', args: [2, 'similar'] },
    { fn: 'getRelatedTracks', args: [3, 'similar'] }
  ])
  const [ok, noBpm, noKey] = r.slice(-3) as {
    status: string
    candidatesScored?: number
    results?: unknown[]
  }[]
  expect(ok.status).toBe('ok')
  expect(ok.candidatesScored).toBe(200)
  expect(ok.results).toHaveLength(20)
  expect(noBpm.status).toBe('needs-key-bpm')
  expect(noKey.status).toBe('needs-key-bpm')
})

test('survey sliders: only tag fields with real values count as in use', async () => {
  const [empty] = await run<string[]>([{ fn: 'tagTypesInUse' }])
  expect(empty).toEqual([])
  const results = await run<unknown>([
    track(1, { genre: 'House', label: 'SERATOCOLLECTION' }),
    track(2, { composer: 'Someone', comment: '' }),
    { fn: 'tagTypesInUse' }
  ])
  // The Serato collection stamp alone does not make label "in use".
  expect(results.at(-1)).toEqual(['genre', 'composer'])
})
