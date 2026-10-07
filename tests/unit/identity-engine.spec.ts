import { test, expect } from '@playwright/test'
import {
  createEngine,
  type EngineDeps,
  type IdentityTagResult
} from '../../src/main/identity/engine'
import { NEGATIVE_CACHE_MS, TransientLookupError } from '../../src/main/identity/lookup'
import type { Lookup } from '../../src/main/identity/lookup'
import { FakeIdentityStore } from '../helpers/fakeIdentityStore'

const ISRC = 'USRC17607839'
const MBID = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const NOW = Date.UTC(2026, 9, 6)

interface Harness {
  store: FakeIdentityStore
  deps: EngineDeps
  tagReads: string[][]
  fingerprinted: string[]
  lookups: number[]
  state: { lookupEnabled: boolean; online: boolean; paused: boolean; now: number }
}

function harness(
  tagsByPath: Record<string, Partial<IdentityTagResult>> = {},
  opts: { withFingerprint?: boolean; lookup?: Lookup | null } = {}
): Harness {
  const store = new FakeIdentityStore()
  const state = { lookupEnabled: false, online: true, paused: false, now: NOW }
  const tagReads: string[][] = []
  const fingerprinted: string[] = []
  const lookups: number[] = []
  const lookup: Lookup | null =
    opts.lookup === undefined
      ? {
          async resolve(c) {
            lookups.push(c.id)
            return { status: 'match', recordingId: MBID }
          }
        }
      : opts.lookup
  const deps: EngineDeps = {
    store,
    now: () => state.now,
    readTags: async (paths) => {
      tagReads.push(paths)
      return paths.map((filepath) => ({
        filepath,
        ok: true,
        isrc: null,
        musicbrainz_recording_id: null,
        ...tagsByPath[filepath]
      }))
    },
    fingerprint:
      opts.withFingerprint === false
        ? null
        : async (filepath) => {
            fingerprinted.push(filepath)
            return { fingerprint: `fp-of-${filepath}`, duration: 200 }
          },
    lookup,
    lookupEnabled: () => state.lookupEnabled,
    isOnline: () => state.online,
    shouldPause: () => state.paused
  }
  return { store, deps, tagReads, fingerprinted, lookups, state }
}

test('tags are read in bulk, not one process per file', async () => {
  const h = harness()
  for (let i = 0; i < 450; i++) h.store.add(`/m/${i}.mp3`)
  await createEngine(h.deps).run()
  expect(h.tagReads.map((b) => b.length)).toEqual([200, 200, 50])
})

test('an ISRC or recording id in the tags means no fingerprinting for that track', async () => {
  const h = harness({
    '/m/a.mp3': { isrc: ISRC },
    '/m/b.mp3': { musicbrainz_recording_id: MBID }
  })
  const a = h.store.add('/m/a.mp3')
  const b = h.store.add('/m/b.mp3')
  const c = h.store.add('/m/c.mp3')
  await createEngine(h.deps).run()
  expect(h.fingerprinted).toEqual(['/m/c.mp3'])
  expect(h.store.getCanonicalTrackId(a)).toBe(`isrc:${ISRC}`)
  expect(h.store.getCanonicalTrackId(b)).toBe(`mbid:${MBID}`)
  expect(h.store.getCanonicalTrackId(c)).toMatch(/^fp:[0-9a-f]{40}$/)
})

test('tracks whose tags were already read at import are not read again', async () => {
  const h = harness()
  h.store.add('/m/a.mp3', { tagsRead: true, isrc: ISRC })
  h.store.add('/m/b.mp3')
  await createEngine(h.deps).run()
  expect(h.tagReads).toEqual([['/m/b.mp3']])
})

test('missing files are skipped', async () => {
  const h = harness()
  h.store.add('/m/gone.mp3', { missing: true })
  await createEngine(h.deps).run()
  expect(h.tagReads).toEqual([])
  expect(h.fingerprinted).toEqual([])
})

test('a track whose tags cannot be read still leaves the work list', async () => {
  const h = harness({ '/m/bad.mp3': { ok: false } })
  const id = h.store.add('/m/bad.mp3')
  await createEngine(h.deps).run()
  expect(h.store.row(id).tagsRead).toBe(true)
})

test('with no fpcalc available the fingerprint phase is skipped and nothing fails', async () => {
  const h = harness({}, { withFingerprint: false })
  const id = h.store.add('/m/a.mp3')
  const r = await createEngine(h.deps).run()
  expect(r.fingerprinted).toBe(0)
  expect(h.store.getCanonicalTrackId(id)).toBeNull()
  expect(h.store.row(id).fpStatus).toBeNull() // still pending for when one is installed
})

test('a fingerprinting failure is recorded once and not retried every run', async () => {
  const h = harness()
  h.deps.fingerprint = async () => {
    throw new Error('fpcalc crashed')
  }
  const id = h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  expect(h.store.row(id).fpStatus).toBe('failed')
  expect(h.store.tracksNeedingFingerprint(10)).toEqual([])
})

test('an empty fingerprint is a failure, not an id', async () => {
  const h = harness()
  h.deps.fingerprint = async () => ({ fingerprint: '', duration: 10 })
  const id = h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  expect(h.store.row(id).fpStatus).toBe('failed')
  expect(h.store.getCanonicalTrackId(id)).toBeNull()
})

// ── the lookup: off by default, and only when asked and online ────────────

test('with the setting off (the default) no lookup is ever attempted', async () => {
  const h = harness()
  h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  expect(h.lookups).toEqual([])
})

test('with the setting on and online, a fingerprint resolves to a recording id', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  const id = h.store.add('/m/a.mp3')
  const r = await createEngine(h.deps).run()
  expect(r.resolved).toBe(1)
  expect(h.store.getCanonicalTrackId(id)).toBe(`mbid:${MBID}`)
})

test('offline: nothing is looked up and nothing is cached', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  h.state.online = false
  h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  expect(h.lookups).toEqual([])
  expect(h.store.cache.size).toBe(0)
})

test('the setting being switched off mid-run stops the next lookup', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  h.store.add('/m/a.mp3')
  h.store.add('/m/b.mp3')
  h.deps.lookup = {
    async resolve(c) {
      h.lookups.push(c.id)
      h.state.lookupEnabled = false
      return { status: 'match', recordingId: MBID }
    }
  }
  await createEngine(h.deps).run()
  expect(h.lookups).toHaveLength(1)
})

test('without a configured lookup (no API key) the setting does nothing', async () => {
  const h = harness({}, { lookup: null })
  h.state.lookupEnabled = true
  h.store.add('/m/a.mp3')
  await expect(createEngine(h.deps).run()).resolves.toMatchObject({ resolved: 0 })
})

test('a transient failure stops the run without caching a "no match"', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  h.deps.lookup = {
    async resolve() {
      throw new TransientLookupError('offline')
    }
  }
  const id = h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  expect(h.store.cache.size).toBe(0)
  // ...so the next run asks again.
  h.deps.lookup = {
    async resolve() {
      return { status: 'match', recordingId: MBID }
    }
  }
  await createEngine(h.deps).run()
  expect(h.store.getCanonicalTrackId(id)).toBe(`mbid:${MBID}`)
})

test('results are cached: the same audio is never looked up twice', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  // Two tracks with identical audio share a fingerprint hash.
  h.deps.fingerprint = async () => ({ fingerprint: 'same-audio', duration: 200 })
  h.store.add('/m/a.mp3')
  h.store.add('/m/b.mp3')
  await createEngine(h.deps).run()
  expect(h.lookups).toHaveLength(1)
  expect(h.store.rows.map((r) => r.mbid)).toEqual([MBID, MBID])
})

test('a "no match" is cached and not asked again until the cache expires', async () => {
  const h = harness()
  h.state.lookupEnabled = true
  h.deps.lookup = {
    async resolve(c) {
      h.lookups.push(c.id)
      return { status: 'none', recordingId: null }
    }
  }
  h.store.add('/m/a.mp3')
  await createEngine(h.deps).run()
  await createEngine(h.deps).run()
  expect(h.lookups).toHaveLength(1)

  h.state.now += NEGATIVE_CACHE_MS + 1000
  await createEngine(h.deps).run()
  expect(h.lookups).toHaveLength(2)
})

// ── resuming and not getting in the way ───────────────────────────────────

test('a paused run leaves work for the next one, which finishes it without redoing any', async () => {
  const h = harness()
  for (let i = 0; i < 450; i++) h.store.add(`/m/${i}.mp3`)
  let calls = 0
  h.deps.shouldPause = () => ++calls > 2 // allow the first two tag batches only
  const first = await createEngine(h.deps).run()
  expect(first.paused).toBe(true)
  expect(h.store.progress().tagsPending).toBe(50)

  h.deps.shouldPause = () => false
  const second = await createEngine(h.deps).run()
  expect(second.paused).toBe(false)
  expect(second.tagsRead).toBe(50)
  expect(h.store.progress().tagsPending).toBe(0)
  const allReads = h.tagReads.flat()
  expect(new Set(allReads).size).toBe(allReads.length) // nothing read twice
})

test('it steps aside entirely while paused (an import is running)', async () => {
  const h = harness()
  h.state.paused = true
  h.store.add('/m/a.mp3')
  const r = await createEngine(h.deps).run()
  expect(r.paused).toBe(true)
  expect(h.tagReads).toEqual([])
})

test('an abort signal stops it at the next batch', async () => {
  const h = harness()
  for (let i = 0; i < 450; i++) h.store.add(`/m/${i}.mp3`)
  const signal = { aborted: false }
  h.deps.readTags = async (paths) => {
    signal.aborted = true
    return paths.map((filepath) => ({
      filepath,
      ok: true,
      isrc: null,
      musicbrainz_recording_id: null
    }))
  }
  const r = await createEngine(h.deps).run(signal)
  expect(r.paused).toBe(true)
  expect(r.tagsRead).toBe(200)
})

test('progress is reported per batch and ends idle', async () => {
  const h = harness()
  for (let i = 0; i < 250; i++) h.store.add(`/m/${i}.mp3`)
  const seen: string[] = []
  h.deps.onProgress = (p) => seen.push(p.phase)
  await createEngine(h.deps).run()
  expect(seen[0]).toBe('tags')
  expect(seen[seen.length - 1]).toBe('idle')
})
