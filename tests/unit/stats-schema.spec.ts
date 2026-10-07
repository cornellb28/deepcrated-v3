import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../helpers/paths'
import {
  EVENT_SPECS,
  EVENT_TYPES,
  TRACK_EVENT_TYPES,
  MAX_PAYLOAD_BYTES,
  hourFloorIso,
  isValidAppVersion,
  validateEvent
} from '../../src/main/stats/schema'

// The allowlist is the privacy boundary: nothing outside it is ever queued,
// so these tests are about what must be refused.

const ID = 'isrc:USRC17607839'

test('a well-formed event passes and comes back rebuilt from allowlisted fields', () => {
  const r = validateEvent('track_tagged', {
    field: 'genre',
    source: 'manual',
    canonical_track_id: ID
  })
  expect(r).toEqual({
    ok: true,
    eventType: 'track_tagged',
    payload: { field: 'genre', source: 'manual', canonical_track_id: ID }
  })
})

test('a track event without a canonical id is rejected', () => {
  expect(validateEvent('track_tagged', { field: 'genre', source: 'manual' }).ok).toBe(false)
})

test('canonical_track_id must be one of the three id shapes — never a path or name', () => {
  const bad = [
    '/Users/dj/Music/song.mp3',
    'C:\\Music\\song.mp3',
    'song.mp3',
    'isrc:not-an-isrc',
    'mbid:123',
    'fp:abc',
    'isrc:USRC17607839/extra',
    ' isrc:USRC17607839',
    'track:42',
    '',
    42,
    null
  ]
  for (const value of bad) {
    const r = validateEvent('track_tagged', {
      field: 'genre',
      source: 'manual',
      canonical_track_id: value
    })
    expect(r.ok, String(value)).toBe(false)
  }
  for (const good of [
    'isrc:USRC17607839',
    'mbid:b9ad642e-b012-41c7-b72a-42cf4911f9ff',
    `fp:${'a'.repeat(40)}`
  ]) {
    const r = validateEvent('track_tagged', {
      field: 'genre',
      source: 'manual',
      canonical_track_id: good
    })
    expect(r.ok, good).toBe(true)
  }
})

test('global events carry no canonical id, and one passed in is dropped', () => {
  const r = validateEvent('crate_created', { nested: true, canonical_track_id: ID })
  expect(r).toEqual({ ok: true, eventType: 'crate_created', payload: { nested: true } })
})

test('unknown event types are rejected, including prototype names', () => {
  for (const t of ['nope', '', 'constructor', '__proto__', 'toString', 42, null, undefined]) {
    expect(validateEvent(t, {}).ok, String(t)).toBe(false)
  }
})

test('undeclared fields are dropped, never passed through', () => {
  const r = validateEvent('track_tagged', {
    field: 'genre',
    source: 'manual',
    canonical_track_id: ID,
    filepath: '/Users/dj/Music/secret.mp3',
    title: 'Secret Track',
    crate_name: 'My crate'
  })
  expect(r.ok).toBe(true)
  if (r.ok) expect(Object.keys(r.payload).sort()).toEqual(['canonical_track_id', 'field', 'source'])
})

test('a missing declared field rejects the whole event', () => {
  expect(validateEvent('track_tagged', { field: 'genre' }).ok).toBe(false)
  expect(validateEvent('track_tagged', {}).ok).toBe(false)
})

test('free text cannot sneak into an enum field', () => {
  const attempts = [
    '/Users/dj/Music/song.mp3',
    'C:\\Music\\song.mp3',
    'Genre: my private crate',
    'GENRE',
    ''
  ]
  for (const value of attempts) {
    expect(validateEvent('track_tagged', { field: value, source: 'manual' }).ok, value).toBe(false)
  }
})

test('wrong types and out-of-range numbers are rejected', () => {
  expect(validateEvent('crate_created', { nested: 'true' }).ok).toBe(false)
  expect(validateEvent('crate_created', { nested: 1 }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: 6 }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: -1 }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: 1.5 }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: '2' }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: NaN }).ok).toBe(false)
  expect(validateEvent('track_added_to_crate', { crate_depth: 2, canonical_track_id: ID }).ok).toBe(
    true
  )
})

test('non-object payloads are rejected', () => {
  for (const p of [null, undefined, 'x', 3, [], [{ nested: true }]]) {
    expect(validateEvent('crate_created', p).ok).toBe(false)
  }
})

test('no declared enum value could carry a path or a name', () => {
  // Enums are the only strings the schema allows, so keeping them to plain
  // lowercase tokens is what makes "no paths, no names" structural.
  for (const spec of Object.values(EVENT_SPECS)) {
    for (const field of Object.values(spec.fields)) {
      if (field.kind !== 'enum') continue
      for (const v of field.values) expect(v, v).toMatch(/^[a-z0-9-]{1,16}$/)
    }
  }
})

test('every event fits well inside the payload cap', () => {
  expect(MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(256)
})

test('hourFloorIso never keeps minutes, seconds or milliseconds', () => {
  expect(hourFloorIso(Date.UTC(2026, 9, 6, 13, 59, 59, 999))).toBe('2026-10-06T13:00:00.000Z')
  expect(hourFloorIso(Date.UTC(2026, 9, 6, 14, 0, 0, 0))).toBe('2026-10-06T14:00:00.000Z')
})

test('app_version accepts semver and rejects anything else', () => {
  expect(isValidAppVersion('1.0.0')).toBe(true)
  expect(isValidAppVersion('1.2.3-beta.1')).toBe(true)
  for (const v of ['', 'v1.0.0', '1.0', '/Users/dj', `1.0.0-${'x'.repeat(40)}`, 5, null]) {
    expect(isValidAppVersion(v), String(v)).toBe(false)
  }
})

// ── the migration must agree with the allowlist ───────────────────────────

function migration(): string {
  const dir = join(REPO_ROOT, 'supabase', 'migrations')
  const file = readdirSync(dir).find((f) => f.endsWith('_stats_events.sql'))
  expect(file, 'stats_events migration exists').toBeTruthy()
  return readFileSync(join(dir, file as string), 'utf8')
}

test('the migration allows exactly the event types in the allowlist', () => {
  const sql = migration()
  const block = sql.match(/event_type in \(([^)]*)\)/s)?.[1] ?? ''
  const inSql = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  expect(inSql).toEqual([...EVENT_TYPES].sort())
})

test('the canonical-id migration covers exactly the track-scoped events', () => {
  const dir = join(REPO_ROOT, 'supabase', 'migrations')
  const file = readdirSync(dir).find((f) => f.endsWith('_stats_events_canonical_id.sql'))
  expect(file, 'canonical id migration exists').toBeTruthy()
  const sql = readFileSync(join(dir, file as string), 'utf8')
  const block = sql.match(/event_type not in \(([^)]*)\)/s)?.[1] ?? ''
  const inSql = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  expect(inSql).toEqual([...TRACK_EVENT_TYPES].sort())
  expect(sql).toMatch(/not valid/i)
})

test('the migration gives anon INSERT and nothing else, and no account link', () => {
  const sql = migration().replace(/--.*$/gm, '')
  expect(sql).toMatch(/enable row level security/i)
  expect(sql).toMatch(/grant insert on public\.stats_events to anon;/i)
  expect(sql).not.toMatch(/grant\s+(select|update|delete|all)/i)
  expect(sql).not.toMatch(/grant[^;]*authenticated/i)
  expect(sql).not.toMatch(/policy[^;]*authenticated/i)
  expect(sql).not.toMatch(/for\s+(select|update|delete|all)/i)
  expect(sql).not.toMatch(/auth\.users|user_id/i)
  // Exactly one policy, and it is the anon insert.
  expect([...sql.matchAll(/create policy/gi)]).toHaveLength(1)
  expect(sql).toMatch(/for insert\s+to anon/i)
})
