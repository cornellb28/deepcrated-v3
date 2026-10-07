import { test, expect } from '@playwright/test'
import { createConsent, type ConsentService } from '../../src/main/stats/consent'
import { createStatsQueue, type StatsQueue } from '../../src/main/stats/queue'
import { createHttpSender, statsEndpoint } from '../../src/main/stats/transport'
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BATCH_SIZE,
  UPLOAD_INTERVAL_MS,
  backoffMs,
  createUploader,
  type SendOutcome,
  type Uploader
} from '../../src/main/stats/uploader'
import type { QueuedStat } from '../../src/main/stats/types'
import { FakeStatsStore } from '../helpers/fakeStatsStore'

const T0 = Date.UTC(2026, 9, 6, 13, 0, 0)

interface SetupResult {
  store: FakeStatsStore
  consent: ConsentService
  queue: StatsQueue
  uploader: Uploader
  sent: QueuedStat[][]
  setOutcome: (o: SendOutcome) => void
  advance: (ms: number) => void
}

function setup(opts: { consentOn?: boolean } = {}): SetupResult {
  const store = new FakeStatsStore().addTrack(1)
  let now = T0
  let n = 0
  const consent = createConsent(store, { now: () => now, uuid: () => `uuid-${++n}` })
  const queue = createStatsQueue(store, consent, { now: () => now, appVersion: '1.0.0' })
  if (opts.consentOn !== false) consent.setConsent(true)
  const sent: QueuedStat[][] = []
  let outcome: SendOutcome = 'ok'
  const uploader = createUploader(store, consent, {
    now: () => now,
    random: () => 0.5,
    send: async (rows) => {
      sent.push(rows)
      return outcome
    }
  })
  return {
    store,
    consent,
    queue,
    uploader,
    sent,
    setOutcome: (o: SendOutcome) => {
      outcome = o
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

// ── consent off means nothing uploads ─────────────────────────────────────

test('with consent never given, nothing is queued and nothing is sent', async () => {
  const { queue, uploader, sent, store } = setup({ consentOn: false })
  expect(queue.enqueueStat('crate_created', { nested: true })).toBe(false)
  await uploader.flush({ force: true })
  expect(sent).toHaveLength(0)
  expect(store.rows).toHaveLength(0)
})

test('consent withdrawn before the flush: zero sends, queue gone', async () => {
  const { queue, consent, uploader, sent, store } = setup()
  queue.enqueueStat('crate_created', { nested: true })
  queue.enqueueStat('app_session', { library_size_bucket: 'lt100' })
  consent.setConsent(false)
  await uploader.flush({ force: true })
  expect(sent).toHaveLength(0)
  expect(store.rows).toHaveLength(0)
})

test('rows that somehow survive a withdrawal are purged by the uploader, not sent', async () => {
  const { queue, store, consent, uploader, sent } = setup()
  queue.enqueueStat('crate_created', { nested: true })
  // Simulate a stale queue: consent flips off without the purge having run.
  store.consent.push({ action: 'withdrawn', textVersion: 1, at: T0 })
  expect(consent.isConsentActive()).toBe(false)
  await uploader.flush({ force: true })
  expect(sent).toHaveLength(0)
  expect(store.rows).toHaveLength(0)
})

test('withdrawing consent mid-flush stops the next batch', async () => {
  const store = new FakeStatsStore()
  const consent = createConsent(store, { now: () => T0, uuid: () => 'id' })
  const queue = createStatsQueue(store, consent, { now: () => T0, appVersion: '1.0.0' })
  consent.setConsent(true)
  for (let i = 0; i < BATCH_SIZE + 5; i++) queue.enqueueStat('crate_created', { nested: false })
  let calls = 0
  const uploader = createUploader(store, consent, {
    now: () => T0,
    random: () => 0.5,
    send: async () => {
      calls++
      consent.setConsent(false) // the user flips it off while a batch is in flight
      return 'ok'
    }
  })
  await uploader.flush({ force: true })
  expect(calls).toBe(1)
  expect(store.rows).toHaveLength(0)
})

// ── the request itself ────────────────────────────────────────────────────

test('the upload carries only the anon key — no Authorization header, no user token', async () => {
  const { queue, store } = setup()
  queue.enqueueStat('crate_created', { nested: true })
  let seen: { url: string; init: RequestInit } | null = null
  const send = createHttpSender({
    supabaseUrl: 'https://proj.supabase.co/rest/v1/',
    anonKey: 'anon-key',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
  })
  expect(await send(store.queueDue(Number.MAX_SAFE_INTEGER, 10))).toBe('ok')

  const { url, init } = seen as unknown as { url: string; init: RequestInit }
  expect(url).toBe('https://proj.supabase.co/rest/v1/stats_events')
  const headers = Object.fromEntries(
    Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
  )
  expect(headers.apikey).toBe('anon-key')
  expect(headers).not.toHaveProperty('authorization')
  expect(headers.prefer).toBe('return=minimal')
  expect(init.credentials).toBe('omit')
})

test('the body has only table columns: no local ids, track ids or crate ids', async () => {
  const { queue, store } = setup()
  queue.enqueueStat('track_played', { duration_bucket: 'lt30s', completed: true }, { trackId: 1 })
  let body = ''
  const send = createHttpSender({
    supabaseUrl: 'https://proj.supabase.co',
    anonKey: 'k',
    fetchImpl: (async (_u: string, init: RequestInit) => {
      body = init.body as string
      return new Response(null, { status: 201 })
    }) as unknown as typeof fetch
  })
  await send(store.queueDue(Number.MAX_SAFE_INTEGER, 10))
  const [row] = JSON.parse(body)
  expect(Object.keys(row).sort()).toEqual([
    'anon_install_id',
    'app_version',
    'created_at',
    'event_type',
    'payload'
  ])
  expect(row.created_at).toBe('2026-10-06T13:00:00.000Z')
})

test('statsEndpoint accepts the URL with or without /rest/v1', () => {
  for (const u of [
    'https://p.supabase.co',
    'https://p.supabase.co/',
    'https://p.supabase.co/rest/v1',
    'https://p.supabase.co/rest/v1/'
  ]) {
    expect(statsEndpoint(u)).toBe('https://p.supabase.co/rest/v1/stats_events')
  }
})

test('HTTP outcomes: 2xx ok, bad batch dropped, everything else retried', async () => {
  const statusOf = async (status: number | 'throw'): Promise<SendOutcome> =>
    createHttpSender({
      supabaseUrl: 'https://p.supabase.co',
      anonKey: 'k',
      fetchImpl: (async () => {
        if (status === 'throw') throw new Error('offline')
        return new Response(null, { status })
      }) as unknown as typeof fetch
    })([])
  expect(await statusOf(201)).toBe('ok')
  expect(await statusOf(400)).toBe('drop')
  expect(await statusOf(422)).toBe('drop')
  expect(await statusOf(401)).toBe('retry')
  expect(await statusOf(429)).toBe('retry')
  expect(await statusOf(503)).toBe('retry')
  expect(await statusOf('throw')).toBe('retry')
})

// ── batching, interval, retry ─────────────────────────────────────────────

test('queued events go out in batches and are deleted once delivered', async () => {
  const { queue, uploader, sent, store } = setup()
  for (let i = 0; i < BATCH_SIZE + 20; i++) queue.enqueueStat('crate_created', { nested: false })
  const r = await uploader.flush()
  expect(r.sent).toBe(BATCH_SIZE + 20)
  expect(sent.map((b) => b.length)).toEqual([BATCH_SIZE, 20])
  expect(store.rows).toHaveLength(0)
})

test('uploads happen at most once per interval, but quit can force one', async () => {
  const { queue, uploader, sent, advance } = setup()
  queue.enqueueStat('crate_created', { nested: false })
  await uploader.flush()
  expect(sent).toHaveLength(1)

  queue.enqueueStat('crate_created', { nested: true })
  advance(UPLOAD_INTERVAL_MS - 1000)
  await uploader.flush()
  expect(sent).toHaveLength(1) // too soon

  await uploader.flush({ force: true })
  expect(sent).toHaveLength(2) // quit-time flush ignores the interval

  queue.enqueueStat('app_session', { library_size_bucket: 'lt100' })
  advance(UPLOAD_INTERVAL_MS + 1000)
  await uploader.flush()
  expect(sent).toHaveLength(3)
})

test('a failed send keeps the rows, backs off, and retries once the delay has passed', async () => {
  const { queue, uploader, sent, store, setOutcome, advance } = setup()
  queue.enqueueStat('crate_created', { nested: false })
  setOutcome('retry')
  await uploader.flush()
  expect(sent).toHaveLength(1)
  expect(store.rows).toHaveLength(1)
  expect(store.rows[0].attempts).toBe(1)

  // Still inside the backoff window: not retried, even with a forced flush.
  await uploader.flush({ force: true })
  expect(sent).toHaveLength(1)

  // A failure does not start the 3-hour interval, so the retry is due as
  // soon as the backoff has passed.
  setOutcome('ok')
  advance(BACKOFF_BASE_MS * 4)
  await uploader.flush()
  expect(sent).toHaveLength(2)
  expect(store.rows).toHaveLength(0)
})

test('a batch the server will never accept is dropped, not retried forever', async () => {
  const { queue, uploader, store, setOutcome } = setup()
  queue.enqueueStat('crate_created', { nested: false })
  setOutcome('drop')
  await uploader.flush()
  expect(store.rows).toHaveLength(0)
})

test('a throwing sender is treated as a retry', async () => {
  const store = new FakeStatsStore()
  const consent = createConsent(store, { now: () => T0, uuid: () => 'id' })
  const queue = createStatsQueue(store, consent, { now: () => T0, appVersion: '1.0.0' })
  consent.setConsent(true)
  queue.enqueueStat('crate_created', { nested: false })
  const uploader = createUploader(store, consent, {
    now: () => T0,
    random: () => 0.5,
    send: async () => {
      throw new Error('boom')
    }
  })
  await expect(uploader.flush()).resolves.toEqual({ sent: 0 })
  expect(store.rows).toHaveLength(1)
})

test('events older than 30 days are dropped before upload', async () => {
  const { queue, uploader, sent, store, advance } = setup()
  queue.enqueueStat('crate_created', { nested: false })
  advance(31 * 24 * 3_600_000)
  await uploader.flush()
  expect(sent).toHaveLength(0)
  expect(store.rows).toHaveLength(0)
})

test('backoff grows exponentially, is capped, and is jittered within ±20%', () => {
  expect(backoffMs(0, () => 0.5)).toBe(BACKOFF_BASE_MS)
  expect(backoffMs(1, () => 0.5)).toBe(BACKOFF_BASE_MS * 2)
  expect(backoffMs(30, () => 0.5)).toBe(BACKOFF_MAX_MS)
  expect(backoffMs(2, () => 0)).toBe(Math.round(BACKOFF_BASE_MS * 4 * 0.8))
  expect(backoffMs(2, () => 1)).toBe(Math.round(BACKOFF_BASE_MS * 4 * 1.2))
})
