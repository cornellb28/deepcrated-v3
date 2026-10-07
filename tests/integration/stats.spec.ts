import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// The stats consent/queue rules against the real SQLite schema: the
// migration, the recursive crate queries, and the purge SQL. The same rules
// are covered with an in-memory store in tests/unit/stats-*.spec.ts; this
// proves the SQL agrees with them and that state survives a restart.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})

test.afterEach(() => {
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

function seed(): ProbeOp[] {
  const tracks: ProbeOp[] = [1, 2, 3].map((n) => ({
    fn: 'insertTrack',
    args: [
      {
        filepath: `/music/${n}.mp3`,
        filename: `${n}.mp3`,
        title: `T${n}`,
        artist: 'A',
        // Track events need a canonical id; an ISRC read at import gives one.
        isrc: `USRC1760780${n}`
      }
    ]
  }))
  return [
    ...tracks,
    { fn: 'insertCrate', args: ['Public', null] }, // 1
    { fn: 'insertCrate', args: ['Private', null] }, // 2
    { fn: 'insertCrate', args: ['Child of private', 2] }, // 3
    { fn: 'addTracksToCrate', args: [1, [1]] },
    { fn: 'addTracksToCrate', args: [2, [2]] }
  ]
}

const PLAYED = { duration_bucket: 'lt30s', completed: true }

test('consent is off by default and nothing can be collected or queued', async () => {
  const results = await run<unknown>([
    ...seed(),
    { fn: 'statsGetConsent' },
    { fn: 'canCollect', args: [1, 1] },
    { fn: 'enqueueStat', args: ['crate_created', { nested: false }] },
    { fn: 'statsQueueCount' }
  ])
  const [consent, can, queued, count] = results.slice(-4)
  expect(consent).toMatchObject({ enabled: false, textVersion: null })
  expect(can).toBe(false)
  expect(queued).toBe(false)
  expect(count).toBe(0)
})

test('canCollect honours private tracks, private crates and nested crates', async () => {
  const r = await run<unknown>([
    ...seed(),
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'statsSetTracksPrivate', args: [[3], true] },
    { fn: 'statsSetCratePrivate', args: [2, true] },
    { fn: 'canCollect', args: [1, 1] }, // public track, public crate
    { fn: 'canCollect', args: [3, null] }, // private track
    { fn: 'canCollect', args: [2, null] }, // track inside the private crate
    { fn: 'canCollect', args: [null, 2] }, // the private crate
    { fn: 'canCollect', args: [null, 3] }, // nested under the private crate
    { fn: 'canCollect', args: [99, null] } // unknown track
  ])
  expect(r.slice(-6)).toEqual([true, false, false, false, false, false])
})

test('consent, private flags and the audit log persist across a restart', async () => {
  await run([
    ...seed(),
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'statsSetTracksPrivate', args: [[3], true] }
  ])
  const r = await run<unknown>([
    { fn: 'statsGetConsent' },
    { fn: 'canCollect', args: [1, null] },
    { fn: 'canCollect', args: [3, null] }
  ])
  expect(r[0]).toMatchObject({ enabled: true, textVersion: 1 })
  expect((r[0] as { changedAt: number }).changedAt).toBeGreaterThan(0)
  expect(r.slice(1)).toEqual([true, false])
})

test('turning consent off deletes the queue and the install id; opting in again makes a new id', async () => {
  const r = await run<unknown>([
    ...seed(),
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'statsInstallId' },
    { fn: 'enqueueStat', args: ['crate_created', { nested: true }] },
    { fn: 'enqueueStat', args: ['track_played', PLAYED, { trackId: 1 }] },
    { fn: 'statsQueueCount' },
    { fn: 'statsSetConsent', args: [false] },
    { fn: 'statsQueueCount' },
    { fn: 'statsInstallId' },
    { fn: 'enqueueStat', args: ['crate_created', { nested: true }] },
    { fn: 'statsQueueCount' },
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'statsInstallId' }
  ])
  const [
    ,
    firstId,
    ,
    ,
    queuedBefore,
    ,
    queuedAfter,
    idAfter,
    enqueuedAfter,
    countAfter,
    ,
    secondId
  ] = r.slice(seed().length)
  expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(queuedBefore).toBe(2)
  expect(queuedAfter).toBe(0)
  expect(idAfter).toBeNull()
  expect(enqueuedAfter).toBe(false)
  expect(countAfter).toBe(0)
  expect(secondId).toMatch(/^[0-9a-f-]{36}$/)
  expect(secondId).not.toBe(firstId)
})

test('marking a track or crate private purges what was already queued for it', async () => {
  const r = await run<unknown>([
    ...seed(),
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'enqueueStat', args: ['track_played', PLAYED, { trackId: 1 }] },
    {
      fn: 'enqueueStat',
      args: ['track_added_to_crate', { crate_depth: 0 }, { trackId: 1, crateId: 1 }]
    },
    { fn: 'enqueueStat', args: ['crate_created', { nested: false }] },
    { fn: 'statsQueueCount' },
    { fn: 'statsSetCratePrivate', args: [1, true] },
    { fn: 'statsQueueCount' }
  ])
  expect(r.slice(-3)).toEqual([3, null, 1]) // 3 queued; purge leaves only the global event
})

test('a track event carries the canonical id from the database and nothing local', async () => {
  const r = await run<unknown>([
    ...seed(),
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'enqueueStat', args: ['track_played', PLAYED, { trackId: 1 }] },
    { fn: 'statsQueuedPayloads' }
  ])
  const payloads = r[r.length - 1] as string[]
  expect(payloads).toHaveLength(1)
  expect(JSON.parse(payloads[0])).toEqual({
    ...PLAYED,
    canonical_track_id: 'isrc:USRC17607801'
  })
  expect(payloads[0]).not.toContain('/music/')
})

test('a track with no canonical id yet produces no event', async () => {
  const r = await run<unknown>([
    ...seed(),
    { fn: 'insertTrack', args: [{ filepath: '/music/4.mp3', filename: '4.mp3', title: 'T4' }] },
    { fn: 'statsSetConsent', args: [true] },
    { fn: 'enqueueStat', args: ['track_played', PLAYED, { trackId: 4 }] },
    { fn: 'statsQueueCount' }
  ])
  expect(r.slice(-2)).toEqual([false, 0])
})
