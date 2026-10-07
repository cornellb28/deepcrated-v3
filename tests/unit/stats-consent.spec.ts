import { test, expect } from '@playwright/test'
import {
  CONSENT_TEXT_VERSION,
  createConsent,
  isReservedSettingKey,
  type ConsentService
} from '../../src/main/stats/consent'
import { createStatsQueue, type StatsQueue } from '../../src/main/stats/queue'
import { FakeStatsStore } from '../helpers/fakeStatsStore'

const NOW = Date.UTC(2026, 9, 6, 13, 37, 12, 345)

function setup(): { store: FakeStatsStore; consent: ConsentService; queue: StatsQueue } {
  const store = new FakeStatsStore()
    .addTrack(1)
    .addTrack(2)
    .addTrack(3, true) // a private track
    .addCrate(10)
    .addCrate(11, 10) // child of 10
    .addCrate(20, null, true) // a private crate
    .addCrate(21, 20) // child of the private crate
    .put(10, 1)
    .put(20, 2)
  let n = 0
  const consent = createConsent(store, { now: () => NOW, uuid: () => `uuid-${++n}` })
  const queue = createStatsQueue(store, consent, { now: () => NOW, appVersion: '1.0.0' })
  return { store, consent, queue }
}

// ── canCollect ────────────────────────────────────────────────────────────

test('canCollect is false before anyone has consented', () => {
  const { consent } = setup()
  expect(consent.canCollect()).toBe(false)
  expect(consent.canCollect(1, 10)).toBe(false)
})

test('with consent on, a public track in a public crate is collectable', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect()).toBe(true)
  expect(consent.canCollect(1)).toBe(true)
  expect(consent.canCollect(1, 10)).toBe(true)
  expect(consent.canCollect(null, 10)).toBe(true)
})

test('a private track is never collectable', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect(3)).toBe(false)
  expect(consent.canCollect(3, 10)).toBe(false)
})

test('a private crate blocks itself, its sub-crates, and the tracks inside it', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect(null, 20)).toBe(false)
  expect(consent.canCollect(null, 21)).toBe(false) // nested under a private crate
  expect(consent.canCollect(2)).toBe(false) // track 2 lives in the private crate
  expect(consent.canCollect(2, 10)).toBe(false) // ...even viewed from a public crate
})

test('unknown ids fail closed', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect(999)).toBe(false)
  expect(consent.canCollect(null, 999)).toBe(false)
  expect(consent.canCollect(1.5)).toBe(false)
})

test('a failing store fails closed', () => {
  const { store, consent } = setup()
  consent.setConsent(true)
  store.throwOnRead = true
  expect(consent.canCollect(1, 10)).toBe(false)
})

test('turning consent off makes canCollect false immediately', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect(1)).toBe(true)
  consent.setConsent(false)
  expect(consent.canCollect(1)).toBe(false)
})

test('marking something private takes effect immediately', () => {
  const { consent } = setup()
  consent.setConsent(true)
  expect(consent.canCollect(1, 10)).toBe(true)
  consent.setCratePrivate(10, true)
  expect(consent.canCollect(1, 10)).toBe(false)
  expect(consent.canCollect(null, 11)).toBe(false)
  consent.setCratePrivate(10, false)
  consent.setTracksPrivate([1], true)
  expect(consent.canCollect(1)).toBe(false)
})

// ── consent log ───────────────────────────────────────────────────────────

test('consent is off by default and the log records grant and withdrawal', () => {
  const { store, consent } = setup()
  expect(consent.getState().enabled).toBe(false)
  consent.setConsent(true)
  consent.setConsent(false)
  expect(store.consent).toEqual([
    { action: 'granted', textVersion: CONSENT_TEXT_VERSION, at: NOW },
    { action: 'withdrawn', textVersion: CONSENT_TEXT_VERSION, at: NOW }
  ])
  expect(consent.getState()).toMatchObject({ enabled: false, changedAt: NOW })
})

test('setting consent to its current value does not add log rows', () => {
  const { store, consent } = setup()
  consent.setConsent(false)
  expect(store.consent).toHaveLength(0)
  consent.setConsent(true)
  consent.setConsent(true)
  expect(store.consent).toHaveLength(1)
})

test('consent given under an old text version does not count and expires at startup', () => {
  const { store, consent, queue } = setup()
  store.consent.push({ action: 'granted', textVersion: CONSENT_TEXT_VERSION - 1, at: 1 })
  store.installId = 'old-id'
  expect(consent.canCollect(1)).toBe(false)
  consent.reconcile()
  expect(store.consent.at(-1)?.action).toBe('expired')
  expect(store.installId).toBeNull()
  expect(queue.enqueueStat('crate_created', { nested: false })).toBe(false)
})

// ── install id ────────────────────────────────────────────────────────────

test('an install id exists only while consent is on, and opting in again makes a new one', () => {
  const { store, consent } = setup()
  expect(store.installId).toBeNull()
  consent.setConsent(true)
  const first = store.installId
  expect(first).toBe('uuid-1')
  consent.setConsent(false)
  expect(store.installId).toBeNull()
  consent.setConsent(true)
  expect(store.installId).toBe('uuid-2')
  expect(store.installId).not.toBe(first)
})

// ── the consent-off purge ─────────────────────────────────────────────────

test('turning consent off deletes everything queued and not yet uploaded', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  expect(queue.enqueueStat('crate_created', { nested: true })).toBe(true)
  expect(
    queue.enqueueStat(
      'track_played',
      { duration_bucket: 'lt30s', completed: false },
      { trackId: 1 }
    )
  ).toBe(true)
  expect(store.rows).toHaveLength(2)

  consent.setConsent(false)

  expect(store.rows).toHaveLength(0)
  // ...and nothing can be queued afterwards.
  expect(queue.enqueueStat('crate_created', { nested: true })).toBe(false)
  expect(store.rows).toHaveLength(0)
})

test('marking a track private deletes what is already queued for it', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat('track_played', { duration_bucket: 'lt30s', completed: true }, { trackId: 1 })
  queue.enqueueStat('crate_created', { nested: false })
  consent.setTracksPrivate([1], true)
  expect(store.rows.map((r) => r.event_type)).toEqual(['crate_created'])
})

test('marking a crate private deletes queued events for it and for tracks in it', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat('track_added_to_crate', { crate_depth: 0 }, { trackId: 1, crateId: 10 })
  queue.enqueueStat('track_played', { duration_bucket: '2m-5m', completed: true }, { trackId: 1 })
  queue.enqueueStat('app_session', { library_size_bucket: 'lt100' })
  consent.setCratePrivate(10, true)
  expect(store.rows.map((r) => r.event_type)).toEqual(['app_session'])
})

// ── enqueue gate ──────────────────────────────────────────────────────────

test('enqueue rounds the timestamp to the hour and stamps version and install id', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat('crate_created', { nested: false })
  expect(store.rows[0]).toMatchObject({
    anon_install_id: 'uuid-1',
    event_type: 'crate_created',
    payload: '{"nested":false}',
    app_version: '1.0.0',
    created_at: '2026-10-06T13:00:00.000Z'
  })
})

test('enqueue refuses unknown events, bad payloads, and track events without a track', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  expect(queue.enqueueStat('open_file', { path: '/a/b.mp3' })).toBe(false)
  expect(queue.enqueueStat('crate_created', { nested: 'yes' })).toBe(false)
  expect(queue.enqueueStat('track_tagged', { field: 'genre', source: 'manual' })).toBe(false)
  expect(
    queue.enqueueStat('track_tagged', { field: 'genre', source: 'manual' }, { trackId: 3 })
  ).toBe(false)
  expect(store.rows).toHaveLength(0)
})

test('enqueue strips undeclared fields before storing', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat('crate_created', { nested: true, name: 'Secret crate', path: '/x' })
  expect(JSON.parse(store.rows[0].payload)).toEqual({ nested: true })
})

test('the queue is capped, keeping the newest events', () => {
  const { store, consent } = setup()
  consent.setConsent(true)
  const queue = createStatsQueue(store, consent, { now: () => NOW, appVersion: '1.0.0' })
  for (let i = 0; i < 5005; i++) queue.enqueueStat('crate_created', { nested: false })
  expect(store.rows).toHaveLength(5000)
  expect(store.rows.some((r) => r.id === 1)).toBe(false)
  expect(store.rows.some((r) => r.id === 5005)).toBe(true)
})

test('events older than 30 days are dropped when the next one is queued', () => {
  const { store, consent } = setup()
  consent.setConsent(true)
  let t = NOW
  const queue = createStatsQueue(store, consent, { now: () => t, appVersion: '1.0.0' })
  queue.enqueueStat('crate_created', { nested: false })
  t += 31 * 24 * 3_600_000
  queue.enqueueStat('crate_created', { nested: true })
  expect(store.rows).toHaveLength(1)
  expect(JSON.parse(store.rows[0].payload)).toEqual({ nested: true })
})

// ── reserved settings keys ────────────────────────────────────────────────

test('stats_ settings keys are reserved', () => {
  expect(isReservedSettingKey('stats_install_id')).toBe(true)
  expect(isReservedSettingKey('stats_anything')).toBe(true)
  expect(isReservedSettingKey('view_mode:tab:all')).toBe(false)
  expect(isReservedSettingKey(undefined)).toBe(false)
})

// ── canonical_track_id on track events ────────────────────────────────────

test('a track event is stamped with the track canonical id from the database', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  expect(
    queue.enqueueStat('track_played', { duration_bucket: 'lt30s', completed: true }, { trackId: 1 })
  ).toBe(true)
  expect(JSON.parse(store.rows[0].payload)).toEqual({
    duration_bucket: 'lt30s',
    completed: true,
    canonical_track_id: 'isrc:USRC17607801'
  })
})

test('an id supplied by the caller is replaced, never trusted', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat(
    'track_played',
    { duration_bucket: 'lt30s', completed: true, canonical_track_id: '/Users/dj/Music/a.mp3' },
    { trackId: 1 }
  )
  expect(JSON.parse(store.rows[0].payload).canonical_track_id).toBe('isrc:USRC17607801')
})

test('a track with no canonical id yet produces no event', () => {
  const { store, consent, queue } = setup()
  store.addTrack(5, false, null)
  consent.setConsent(true)
  expect(
    queue.enqueueStat('track_played', { duration_bucket: 'lt30s', completed: true }, { trackId: 5 })
  ).toBe(false)
  expect(store.rows).toHaveLength(0)
})

test('a path, filename or local id never appears in a queued payload', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat(
    'track_tagged',
    { field: 'genre', source: 'manual', filepath: '/a/b.mp3', track_id: 1 },
    { trackId: 1 }
  )
  const raw = JSON.stringify(store.rows[0])
  expect(raw).not.toContain('/a/b.mp3')
  expect(JSON.parse(store.rows[0].payload)).not.toHaveProperty('track_id')
  expect(JSON.parse(store.rows[0].payload)).not.toHaveProperty('filepath')
})

test('global events are not given a canonical id', () => {
  const { store, consent, queue } = setup()
  consent.setConsent(true)
  queue.enqueueStat('crate_created', { nested: false })
  expect(JSON.parse(store.rows[0].payload)).toEqual({ nested: false })
})
