import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createEngine, type IdentityTagResult } from '../../src/main/identity/engine'
import { NEGATIVE_CACHE_MS, createLookup } from '../../src/main/identity/lookup'
import { createSqliteIdentityStore, readStatsTrackId } from '../../src/main/identity/sqliteStore'

// What a DJ gets from the "Identify tracks online" toggle, end to end: the
// real engine, the real SQLite store and the real AcoustID/MusicBrainz client.
// Only fetch, the tag reader and the fingerprinter are faked, so no request
// leaves the machine and no file is opened. The schema below is the subset of
// db.ts the identity store touches (the integration suite covers db.ts's own
// migration).

const ISRC = 'USRC17607839'
const TAG_MBID = 'b9ad642e-b012-41c7-b72a-42cf4911f9ff'
const FOUND_MBID = '11111111-2222-4333-8444-555555555555'
const NOW = Date.UTC(2026, 9, 9)

type Reply = Response | 'network-down'

interface Harness {
  db: Database.Database
  run: () => ReturnType<ReturnType<typeof createEngine>['run']>
  state: { lookupEnabled: boolean; online: boolean; now: number }
  requests: string[]
  tagReads: string[]
  fingerprinted: string[]
  reply: { acoustid: () => Reply; musicbrainz: () => Reply }
  statsId: (filepath: string) => string | null
  row: (filepath: string) => {
    musicbrainz_recording_id: string | null
    recording_id_source: string | null
    canonical_track_id: string | null
    fingerprint_status: string | null
  }
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY,
      filepath TEXT NOT NULL UNIQUE,
      missing INTEGER NOT NULL DEFAULT 0,
      isrc TEXT,
      musicbrainz_recording_id TEXT,
      recording_id_source TEXT CHECK (recording_id_source IN ('tag', 'lookup')),
      acoustid_fingerprint TEXT,
      fingerprint_duration INTEGER,
      fingerprint_hash TEXT,
      canonical_track_id TEXT,
      fingerprint_status TEXT,
      identity_tags_read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE identity_lookup_cache (
      fingerprint_hash TEXT PRIMARY KEY,
      recording_id     TEXT,
      status           TEXT    NOT NULL CHECK (status IN ('match','none','ambiguous')),
      looked_up_at     INTEGER NOT NULL
    );
  `)
  return db
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function harness(tracks: Record<string, Partial<IdentityTagResult>>): Harness {
  const db = makeDb()
  const insert = db.prepare(`INSERT INTO tracks (filepath) VALUES (?)`)
  for (const filepath of Object.keys(tracks)) insert.run(filepath)

  const store = createSqliteIdentityStore(db)
  const state = { lookupEnabled: false, online: true, now: NOW }
  const requests: string[] = []
  const tagReads: string[] = []
  const fingerprinted: string[] = []
  const reply = {
    acoustid: (): Reply =>
      json({ status: 'ok', results: [{ score: 0.97, recordings: [{ id: FOUND_MBID }] }] }),
    musicbrainz: (): Reply => json({ id: FOUND_MBID })
  }

  const lookup = createLookup({
    fetch: async (url) => {
      requests.push(url)
      const r = url.includes('acoustid') ? reply.acoustid() : reply.musicbrainz()
      if (r === 'network-down') throw new TypeError('fetch failed')
      return r
    },
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms
    },
    config: { acoustidKey: 'app-key', contact: 'dev@example.com', appVersion: '1.0.0' }
  })

  const engine = createEngine({
    store,
    now: () => state.now,
    readTags: async (paths) => {
      tagReads.push(...paths)
      return paths.map((filepath) => ({
        filepath,
        ok: true,
        isrc: null,
        musicbrainz_recording_id: null,
        ...tracks[filepath]
      }))
    },
    fingerprint: async (filepath) => {
      fingerprinted.push(filepath)
      return { fingerprint: `AQAD-fingerprint-of-${filepath}`, duration: 215 }
    },
    lookup,
    lookupEnabled: () => state.lookupEnabled,
    isOnline: () => state.online,
    shouldPause: () => false
  })

  const row = (filepath: string): ReturnType<Harness['row']> =>
    db
      .prepare(
        `SELECT musicbrainz_recording_id, recording_id_source, canonical_track_id,
                fingerprint_status
         FROM tracks WHERE filepath = ?`
      )
      .get(filepath) as ReturnType<Harness['row']>

  const statsId = (filepath: string): string | null => {
    const { id } = db.prepare(`SELECT id FROM tracks WHERE filepath = ?`).get(filepath) as {
      id: number
    }
    return readStatsTrackId(db, id)
  }

  return {
    db,
    run: () => engine.run(),
    statsId,
    state,
    requests,
    tagReads,
    fingerprinted,
    reply,
    row
  }
}

const acoustidCalls = (h: Harness): string[] => h.requests.filter((u) => u.includes('acoustid'))
const cacheRows = (h: Harness): { status: string }[] =>
  h.db.prepare(`SELECT status FROM identity_lookup_cache`).all() as { status: string }[]

const library = {
  '/music/has-isrc.mp3': { isrc: ISRC },
  '/music/has-mbid.flac': { musicbrainz_recording_id: TAG_MBID },
  '/music/untagged.mp3': {}
}

// ── 1. OFF: local work still happens, nothing goes online ─────────────────

test('toggle OFF: tags are read and untagged tracks fingerprinted, but no request is made', async () => {
  const h = harness(library)
  const r = await h.run()

  expect(h.requests).toEqual([])
  expect(r).toMatchObject({ tagsRead: 3, fingerprinted: 1, resolved: 0 })
  expect(h.tagReads.sort()).toEqual(Object.keys(library).sort())
  expect(h.fingerprinted).toEqual(['/music/untagged.mp3'])
  expect(h.row('/music/untagged.mp3').canonical_track_id).toMatch(/^fp:[0-9a-f]{40}$/)
  expect(cacheRows(h)).toEqual([])
})

// ── 2. ON: only tracks with no id are looked up; a match lands in the DB ──

test('toggle ON: only a track with neither ISRC nor recording id is looked up, and a match updates both columns', async () => {
  const h = harness(library)
  h.state.lookupEnabled = true
  const r = await h.run()

  expect(r.resolved).toBe(1)
  // One AcoustID request (the untagged track) and one MusicBrainz confirmation.
  expect(acoustidCalls(h)).toHaveLength(1)
  expect(h.requests).toHaveLength(2)

  const found = h.row('/music/untagged.mp3')
  expect(found.musicbrainz_recording_id).toBe(FOUND_MBID)
  // Read straight from the column: recomputed in the database, fp: -> mbid:.
  expect(found.canonical_track_id).toBe(`mbid:${FOUND_MBID}`)

  // The tagged tracks were left exactly as their tags made them.
  expect(h.row('/music/has-isrc.mp3').canonical_track_id).toBe(`isrc:${ISRC}`)
  expect(h.row('/music/has-mbid.flac').musicbrainz_recording_id).toBe(TAG_MBID)
  expect(h.row('/music/has-mbid.flac').canonical_track_id).toBe(`mbid:${TAG_MBID}`)
})

// ── 3. switched OFF mid-batch ─────────────────────────────────────────────

test('toggle switched OFF mid-batch: the next track is not looked up, and ON again picks up the rest', async () => {
  const h = harness({ '/music/a.mp3': {}, '/music/b.mp3': {}, '/music/c.mp3': {} })
  h.state.lookupEnabled = true
  h.reply.musicbrainz = () => {
    h.state.lookupEnabled = false // the DJ flips it while the first lookup is in flight
    return json({ id: FOUND_MBID })
  }
  await h.run()

  expect(acoustidCalls(h)).toHaveLength(1)
  expect(h.row('/music/a.mp3').musicbrainz_recording_id).toBe(FOUND_MBID)
  for (const p of ['/music/b.mp3', '/music/c.mp3']) {
    expect(h.row(p).musicbrainz_recording_id).toBeNull()
    expect(h.row(p).canonical_track_id).toMatch(/^fp:/)
  }

  // Reversible: back ON, the remaining two are matched and nothing is redone.
  h.reply.musicbrainz = () => json({ id: FOUND_MBID })
  h.state.lookupEnabled = true
  await h.run()
  expect(acoustidCalls(h)).toHaveLength(3)
  expect(h.row('/music/c.mp3').canonical_track_id).toBe(`mbid:${FOUND_MBID}`)
})

// ── 6. errors and offline ─────────────────────────────────────────────────

for (const failure of [429, 500, 503, 'network-down'] as const) {
  test(`a ${failure} from AcoustID ends the run quietly, caches nothing, and the next run retries`, async () => {
    const h = harness({ '/music/a.mp3': {}, '/music/b.mp3': {} })
    h.state.lookupEnabled = true
    h.reply.acoustid = () =>
      failure === 'network-down' ? 'network-down' : new Response(null, { status: failure })

    await expect(h.run()).resolves.toMatchObject({ resolved: 0 })
    // Stopped at the first failure rather than hammering the service.
    expect(acoustidCalls(h)).toHaveLength(1)
    expect(cacheRows(h)).toEqual([])
    expect(h.row('/music/a.mp3').musicbrainz_recording_id).toBeNull()

    h.reply.acoustid = () =>
      json({ status: 'ok', results: [{ score: 0.97, recordings: [{ id: FOUND_MBID }] }] })
    await expect(h.run()).resolves.toMatchObject({ resolved: 2 })
  })
}

test('a 503 from MusicBrainz after an AcoustID match is also retried, not cached as a miss', async () => {
  const h = harness({ '/music/a.mp3': {} })
  h.state.lookupEnabled = true
  h.reply.musicbrainz = () => new Response(null, { status: 503 })
  await expect(h.run()).resolves.toMatchObject({ resolved: 0 })
  expect(cacheRows(h)).toEqual([])

  h.reply.musicbrainz = () => json({ id: FOUND_MBID })
  await expect(h.run()).resolves.toMatchObject({ resolved: 1 })
})

test('offline: lookups are skipped entirely while tags and fingerprints still run', async () => {
  const h = harness(library)
  h.state.lookupEnabled = true
  h.state.online = false
  const r = await h.run()
  expect(h.requests).toEqual([])
  expect(r).toMatchObject({ tagsRead: 3, fingerprinted: 1, resolved: 0 })
  expect(cacheRows(h)).toEqual([])
})

// ── 7. no-match caching ───────────────────────────────────────────────────

test('a no-match is cached in the database, so the next run makes no request until it expires', async () => {
  const h = harness({ '/music/obscure-white-label.mp3': {} })
  h.state.lookupEnabled = true
  h.reply.acoustid = () => json({ status: 'ok', results: [] })

  await h.run()
  await h.run()
  await h.run()
  expect(acoustidCalls(h)).toHaveLength(1)
  expect(cacheRows(h)).toEqual([{ status: 'none' }])
  expect(h.row('/music/obscure-white-label.mp3').canonical_track_id).toMatch(/^fp:/)

  h.state.now += NEGATIVE_CACHE_MS + 1000
  await h.run()
  expect(acoustidCalls(h)).toHaveLength(2)
})

// ── the stats id does not depend on the toggle ────────────────────────────

test('stats id is identical with the toggle ON and OFF, for tagged and untagged tracks', async () => {
  const off = harness(library)
  await off.run()

  const on = harness(library)
  on.state.lookupEnabled = true
  await on.run()
  // The lookup really did change the local id of the untagged track...
  expect(on.row('/music/untagged.mp3').canonical_track_id).toBe(`mbid:${FOUND_MBID}`)
  expect(off.row('/music/untagged.mp3').canonical_track_id).toMatch(/^fp:/)

  // ...but not what stats would send, for any of the three.
  for (const path of Object.keys(library)) {
    expect(on.statsId(path), path).toBe(off.statsId(path))
  }
  expect(on.statsId('/music/has-isrc.mp3')).toBe(`isrc:${ISRC}`)
  expect(on.statsId('/music/has-mbid.flac')).toBe(`mbid:${TAG_MBID}`)
  expect(on.statsId('/music/untagged.mp3')).toBe(off.row('/music/untagged.mp3').canonical_track_id)
})

test('a recording id from the lookup is marked as such and never used by stats, even after OFF', async () => {
  const h = harness({
    '/music/untagged.mp3': {},
    '/music/has-mbid.flac': library['/music/has-mbid.flac']
  })
  h.state.lookupEnabled = true
  await h.run()
  expect(h.row('/music/untagged.mp3').recording_id_source).toBe('lookup')
  expect(h.row('/music/has-mbid.flac').recording_id_source).toBe('tag')

  const statsBefore = h.statsId('/music/untagged.mp3')
  expect(statsBefore).toMatch(/^fp:[0-9a-f]{40}$/)

  // Turning it off keeps the match locally; stats is unchanged either way.
  h.state.lookupEnabled = false
  await h.run()
  expect(h.row('/music/untagged.mp3').musicbrainz_recording_id).toBe(FOUND_MBID)
  expect(h.statsId('/music/untagged.mp3')).toBe(statsBefore)
})
