import { test, expect } from '@playwright/test'
import {
  ACOUSTID_MIN_INTERVAL_MS,
  MIN_MATCH_SCORE,
  MUSICBRAINZ_MIN_INTERVAL_MS,
  TransientLookupError,
  createLimiter,
  createLookup,
  isLookupConfigured,
  pickRecording,
  type FetchLike
} from '../../src/main/identity/lookup'
import type { LookupCandidate } from '../../src/main/identity/types'

const REC_A = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const REC_B = '11111111-2222-4333-8444-555555555555'
const REC_MERGED_TO = '99999999-8888-4777-8666-555555555555'

const candidate: LookupCandidate = {
  id: 1,
  fingerprint: 'AQADtEmUaEmSJEEi',
  fingerprint_duration: 215,
  fingerprint_hash: 'a'.repeat(40)
}

const config = { acoustidKey: 'app-key', contact: 'dj@example.com', appVersion: '1.2.3' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

// ── picking a recording ───────────────────────────────────────────────────

test('a confident single-recording result is a match', () => {
  expect(
    pickRecording({ status: 'ok', results: [{ score: 0.97, recordings: [{ id: REC_A }] }] })
  ).toEqual({ status: 'match', recordingId: REC_A })
})

test('results below the confidence threshold are no match', () => {
  expect(
    pickRecording({
      status: 'ok',
      results: [{ score: MIN_MATCH_SCORE - 0.01, recordings: [{ id: REC_A }] }]
    })
  ).toEqual({ status: 'none' })
})

test('the highest-scoring result wins over a lower one', () => {
  expect(
    pickRecording({
      status: 'ok',
      results: [
        { score: 0.92, recordings: [{ id: REC_B }] },
        { score: 0.99, recordings: [{ id: REC_A }] }
      ]
    })
  ).toEqual({ status: 'match', recordingId: REC_A })
})

test('several recordings for the best result is ambiguous and is never guessed at', () => {
  expect(
    pickRecording({
      status: 'ok',
      results: [{ score: 0.99, recordings: [{ id: REC_A }, { id: REC_B }] }]
    })
  ).toEqual({ status: 'ambiguous' })
  expect(
    pickRecording({
      status: 'ok',
      results: [
        { score: 0.99, recordings: [{ id: REC_A }] },
        { score: 0.99, recordings: [{ id: REC_B }] }
      ]
    })
  ).toEqual({ status: 'ambiguous' })
})

test('errors, empty results and malformed ids are no match', () => {
  expect(pickRecording({ status: 'error' })).toEqual({ status: 'none' })
  expect(pickRecording({ status: 'ok', results: [] })).toEqual({ status: 'none' })
  expect(pickRecording(null)).toEqual({ status: 'none' })
  expect(
    pickRecording({ status: 'ok', results: [{ score: 1, recordings: [{ id: 'not-a-uuid' }] }] })
  ).toEqual({ status: 'none' })
  expect(pickRecording({ status: 'ok', results: [{ score: 1 }] })).toEqual({ status: 'none' })
})

// ── rate limiting ─────────────────────────────────────────────────────────

test('the limiter keeps the published minimum interval between request starts', async () => {
  let now = 0
  const starts: number[] = []
  const limiter = createLimiter(
    1000,
    () => now,
    async (ms) => {
      now += ms
    }
  )
  await Promise.all([1, 2, 3, 4].map(() => limiter.run(async () => starts.push(now))))
  expect(starts).toEqual([0, 1000, 2000, 3000])
})

test('the configured intervals respect AcoustID 3/s and MusicBrainz 1/s', () => {
  expect(1000 / ACOUSTID_MIN_INTERVAL_MS).toBeLessThanOrEqual(3)
  expect(1000 / MUSICBRAINZ_MIN_INTERVAL_MS).toBeLessThanOrEqual(1)
})

test('a failing call does not stall the limiter', async () => {
  const limiter = createLimiter(
    0,
    () => 0,
    async () => {}
  )
  await expect(limiter.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
  await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
})

// ── the two services ──────────────────────────────────────────────────────

function lookupWith(fetchImpl: FetchLike, clock = { now: 0 }) {
  const calls: { url: string; init: RequestInit }[] = []
  const wrapped: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} })
    return fetchImpl(url, init)
  }
  const lookup = createLookup({
    fetch: wrapped,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    config
  })
  return { lookup, calls, clock }
}

test('a match is confirmed against MusicBrainz and returns the current recording id', async () => {
  const { lookup, calls } = lookupWith(async (url) =>
    url.includes('acoustid')
      ? json({ status: 'ok', results: [{ score: 0.98, recordings: [{ id: REC_A }] }] })
      : // MusicBrainz answers with the recording a merged id now points to.
        json({ id: REC_MERGED_TO })
  )
  await expect(lookup.resolve(candidate)).resolves.toEqual({
    status: 'match',
    recordingId: REC_MERGED_TO
  })
  expect(calls).toHaveLength(2)
  expect(calls[1].url).toContain(`/ws/2/recording/${REC_A}`)
})

test('requests carry no credentials, no Authorization header, and identify the app', async () => {
  const { lookup, calls } = lookupWith(async (url) =>
    url.includes('acoustid')
      ? json({ status: 'ok', results: [{ score: 0.98, recordings: [{ id: REC_A }] }] })
      : json({ id: REC_A })
  )
  await lookup.resolve(candidate)
  for (const { init } of calls) {
    expect(init.credentials).toBe('omit')
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
    expect(headers).not.toHaveProperty('authorization')
    expect(headers['user-agent']).toBe('DeepCrated/1.2.3 ( dj@example.com )')
  }
})

test('only the fingerprint, duration and app key go to AcoustID — no paths or names', async () => {
  const { lookup, calls } = lookupWith(async () => json({ status: 'ok', results: [] }))
  await lookup.resolve(candidate)
  const sent = new URLSearchParams(calls[0].init.body as string)
  expect([...sent.keys()].sort()).toEqual(['client', 'duration', 'fingerprint', 'meta'])
  expect(sent.get('client')).toBe('app-key')
  expect(sent.get('duration')).toBe('215')
  expect(sent.get('fingerprint')).toBe(candidate.fingerprint)
})

test('no match from AcoustID means MusicBrainz is not asked at all', async () => {
  const { lookup, calls } = lookupWith(async () => json({ status: 'ok', results: [] }))
  await expect(lookup.resolve(candidate)).resolves.toEqual({ status: 'none', recordingId: null })
  expect(calls).toHaveLength(1)
})

test('a recording MusicBrainz no longer has is no match', async () => {
  const { lookup } = lookupWith(async (url) =>
    url.includes('acoustid')
      ? json({ status: 'ok', results: [{ score: 0.98, recordings: [{ id: REC_A }] }] })
      : new Response(null, { status: 404 })
  )
  await expect(lookup.resolve(candidate)).resolves.toEqual({ status: 'none', recordingId: null })
})

test('offline and throttled responses are transient, so nothing gets cached as a miss', async () => {
  const offline = lookupWith(async () => {
    throw new Error('offline')
  })
  await expect(offline.lookup.resolve(candidate)).rejects.toBeInstanceOf(TransientLookupError)

  for (const status of [429, 503, 500]) {
    const busy = lookupWith(async () => new Response(null, { status }))
    await expect(busy.lookup.resolve(candidate), String(status)).rejects.toBeInstanceOf(
      TransientLookupError
    )
  }
})

test('a rejected request (bad key) is a miss, not an endless retry', async () => {
  const { lookup } = lookupWith(async () => new Response(null, { status: 400 }))
  await expect(lookup.resolve(candidate)).resolves.toEqual({ status: 'none', recordingId: null })
})

test('consecutive lookups are spaced to the published limits', async () => {
  const stamps: { service: string; at: number }[] = []
  const clock = { now: 0 }
  const { lookup } = lookupWith(async (url) => {
    stamps.push({ service: url.includes('acoustid') ? 'acoustid' : 'musicbrainz', at: clock.now })
    return url.includes('acoustid')
      ? json({ status: 'ok', results: [{ score: 0.98, recordings: [{ id: REC_A }] }] })
      : json({ id: REC_A })
  }, clock)
  for (let i = 0; i < 4; i++) await lookup.resolve(candidate)

  for (const [service, minGap] of [
    ['acoustid', ACOUSTID_MIN_INTERVAL_MS],
    ['musicbrainz', MUSICBRAINZ_MIN_INTERVAL_MS]
  ] as const) {
    const times = stamps.filter((s) => s.service === service).map((s) => s.at)
    expect(times).toHaveLength(4)
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1], `${service} gap ${i}`).toBeGreaterThanOrEqual(minGap)
    }
  }
})

test('lookup needs both an API key and a contact', () => {
  expect(isLookupConfigured(config)).toBe(true)
  expect(isLookupConfigured({ ...config, acoustidKey: '' })).toBe(false)
  expect(isLookupConfigured({ ...config, contact: undefined })).toBe(false)
  expect(isLookupConfigured({})).toBe(false)
})
