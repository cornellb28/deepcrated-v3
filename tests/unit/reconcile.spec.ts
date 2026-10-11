import { test, expect } from '@playwright/test'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  computePartialHash,
  findReconcileMatch,
  reconcileCandidateFor,
  reconcileFile,
  PARTIAL_HASH_BYTES,
  CANONICAL_DURATION_TOLERANCE_SEC,
  FINGERPRINT_DURATION_TOLERANCE_SEC
} from '../../src/main/reconcile'
import { makeTempDir } from '../helpers/audio'

// Covers the track-identity fingerprinting added in 54d4d08/3c2d6dd and
// changed in ec1f81e (sample from mid-file, sha256) — the thing that lets a
// renamed or moved file re-attach to its existing row instead of coming
// back as a new track.

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('deepcrated-reconcile-')
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

type Candidate = Parameters<typeof findReconcileMatch>[0]
type Missing = Parameters<typeof findReconcileMatch>[1][number]

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    filepath: '/music/Track.mp3',
    filename: 'Track.mp3',
    client_uuid: null,
    file_size_bytes: 1000,
    duration_sec: 180,
    ...overrides
  }
}

function missing(overrides: Record<string, unknown> = {}): Missing {
  return {
    id: 1,
    filepath: '/music/old/Track.mp3',
    filename: 'Track.mp3',
    client_uuid: null,
    partial_hash: null,
    file_size_bytes: 1000,
    duration_sec: 180,
    ...overrides
  } as Missing
}

// ── Partial hash ──────────────────────────────────────────────────────────

test('a file changes hash when its middle changes but not when its head does', async () => {
  // The whole point of sampling from 40% in: a tag write rewrites the
  // ID3/MP4 container at the start of the file, and the fingerprint has to
  // survive that.
  const size = PARTIAL_HASH_BYTES * 4
  const body = Buffer.alloc(size, 0x41)
  const filepath = join(workDir, 'big.bin')

  writeFileSync(filepath, body)
  const original = await computePartialHash(filepath)

  const headChanged = Buffer.from(body)
  headChanged.fill(0x42, 0, 1024)
  writeFileSync(filepath, headChanged)
  expect(await computePartialHash(filepath)).toBe(original)

  const middleChanged = Buffer.from(body)
  middleChanged.fill(0x43, Math.floor(size * 0.4), Math.floor(size * 0.4) + 64)
  writeFileSync(filepath, middleChanged)
  expect(await computePartialHash(filepath)).not.toBe(original)
})

test('a file smaller than the sample window hashes whole', async () => {
  const filepath = join(workDir, 'small.bin')
  writeFileSync(filepath, Buffer.alloc(128, 0x41))
  const hash = await computePartialHash(filepath)
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
})

test('a missing file hashes to null instead of throwing', async () => {
  expect(await computePartialHash(join(workDir, 'nope.bin'))).toBeNull()
})

// ── Matching ──────────────────────────────────────────────────────────────

test('a matching client_uuid wins outright, even against a different size', async () => {
  const match = await findReconcileMatch(
    candidate({ client_uuid: 'uuid-a', file_size_bytes: 999_999 }),
    [missing({ id: 5, client_uuid: 'uuid-a', file_size_bytes: 1000 })]
  )
  expect(match?.id).toBe(5)
})

test('size plus duration matches a single candidate', async () => {
  const match = await findReconcileMatch(candidate(), [missing({ id: 9 })])
  expect(match?.id).toBe(9)
})

test('a duration inside the rounding tolerance still matches', async () => {
  const match = await findReconcileMatch(candidate({ duration_sec: 180 }), [
    missing({ id: 3, duration_sec: 180 + FINGERPRINT_DURATION_TOLERANCE_SEC })
  ])
  expect(match?.id).toBe(3)
})

test('a duration outside the tolerance does not match', async () => {
  const match = await findReconcileMatch(candidate({ duration_sec: 180 }), [
    missing({ duration_sec: 181 })
  ])
  expect(match).toBeNull()
})

test('a different file size never matches, however close the duration', async () => {
  expect(await findReconcileMatch(candidate(), [missing({ file_size_bytes: 1001 })])).toBeNull()
})

test('a candidate with no size or duration is not guessed at', async () => {
  expect(await findReconcileMatch(candidate({ file_size_bytes: null }), [missing()])).toBeNull()
  expect(await findReconcileMatch(candidate({ duration_sec: null }), [missing()])).toBeNull()
})

test('an empty missing pool returns no match', async () => {
  expect(await findReconcileMatch(candidate(), [])).toBeNull()
})

test('a tie on size and duration is broken by partial hash', async () => {
  const filepath = join(workDir, 'tie.bin')
  writeFileSync(filepath, Buffer.alloc(PARTIAL_HASH_BYTES * 3, 0x41))
  const hash = await computePartialHash(filepath)

  const match = await findReconcileMatch(candidate({ filepath, filename: 'tie.bin' }), [
    missing({ id: 1, partial_hash: 'some-other-hash' }),
    missing({ id: 2, partial_hash: hash })
  ])
  expect(match?.id).toBe(2)
})

test('a tie the hash cannot break falls back to a unique filename', async () => {
  const filepath = join(workDir, 'Track.mp3')
  writeFileSync(filepath, Buffer.alloc(256, 0x41))

  const match = await findReconcileMatch(candidate({ filepath, filename: 'Track.mp3' }), [
    missing({ id: 1, filename: 'Other.mp3' }),
    missing({ id: 2, filename: 'Track.mp3' })
  ])
  expect(match?.id).toBe(2)
})

test('genuine ambiguity returns no match rather than picking one', async () => {
  const filepath = join(workDir, 'Track.mp3')
  writeFileSync(filepath, Buffer.alloc(256, 0x41))

  const match = await findReconcileMatch(candidate({ filepath, filename: 'Track.mp3' }), [
    missing({ id: 1, filename: 'Track.mp3' }),
    missing({ id: 2, filename: 'Track.mp3' })
  ])
  expect(match).toBeNull()
})

// ── canonical_track_id: after size+duration, before partial_hash ──────────

const ISRC_ID = 'isrc:USRC17607839'
const OTHER_ID = 'isrc:GBAYE0601498'

// A file whose size changed (its tags were rewritten, or it was re-encoded):
// size+duration finds nothing, so only the canonical id can link it.
function retagged(overrides: Partial<Candidate> = {}): Candidate {
  return candidate({ file_size_bytes: 1234, canonical_track_id: ISRC_ID, ...overrides })
}

test('the candidate canonical id is built from the tags read at import', () => {
  const c = reconcileCandidateFor({
    filepath: '/music/a.mp3',
    filename: 'a.mp3',
    client_uuid: null,
    file_size_bytes: 1,
    duration_sec: 1,
    isrc: 'us-rc1-76-07839',
    musicbrainz_recording_id: null
  })
  expect(c.canonical_track_id).toBe(ISRC_ID)
})

test('with no size+duration match, one track sharing the canonical id is relinked', async () => {
  const pool = [missing({ id: 1, canonical_track_id: ISRC_ID }), missing({ id: 2 })]
  const outcome = await reconcileFile(retagged(), pool)
  expect(outcome).toEqual({ kind: 'match', track: pool[0] })
})

test('a canonical match still needs the length to agree, or it is only a suggestion', async () => {
  // Same ISRC, 40 s longer: a remix or an extended mix reusing the ISRC.
  const pool = [missing({ id: 1, canonical_track_id: ISRC_ID, duration_sec: 220 })]
  const outcome = await reconcileFile(retagged(), pool)
  expect(outcome).toEqual({ kind: 'ambiguous', candidates: pool })
  // Within the tolerance it is a match.
  const close = [
    missing({
      id: 1,
      canonical_track_id: ISRC_ID,
      duration_sec: 180 + CANONICAL_DURATION_TOLERANCE_SEC
    })
  ]
  expect((await reconcileFile(retagged(), close)).kind).toBe('match')
})

test('two tracks sharing the canonical id: no auto-relink, both are offered to pick', async () => {
  const pool = [
    missing({ id: 1, canonical_track_id: ISRC_ID }),
    missing({ id: 2, canonical_track_id: ISRC_ID, filepath: '/music/other/Track.mp3' }),
    missing({ id: 3, canonical_track_id: OTHER_ID })
  ]
  const outcome = await reconcileFile(retagged(), pool)
  expect(outcome).toEqual({ kind: 'ambiguous', candidates: [pool[0], pool[1]] })
  // Callers that cannot ask see exactly what they saw before: no match.
  expect(await findReconcileMatch(retagged(), pool)).toBeNull()
})

test('an empty or absent canonical id never matches anything', async () => {
  for (const id of [null, undefined, '', '   ']) {
    const pool = [
      missing({ id: 1, canonical_track_id: id }),
      missing({ id: 2, canonical_track_id: id })
    ]
    expect(await reconcileFile(retagged({ canonical_track_id: id }), pool), String(id)).toEqual({
      kind: 'none'
    })
  }
  // And a candidate with an id never matches a pool row without one.
  const pool = [missing({ id: 1, canonical_track_id: null })]
  expect(await reconcileFile(retagged(), pool)).toEqual({ kind: 'none' })
})

test('a different canonical id is no match', async () => {
  const pool = [missing({ id: 1, canonical_track_id: OTHER_ID })]
  expect(await reconcileFile(retagged(), pool)).toEqual({ kind: 'none' })
})

test('client_uuid still wins over a canonical id pointing at another track', async () => {
  const pool = [
    missing({ id: 1, canonical_track_id: ISRC_ID }),
    missing({ id: 2, client_uuid: 'uuid-2', file_size_bytes: 9 })
  ]
  const outcome = await reconcileFile(retagged({ client_uuid: 'uuid-2' }), pool)
  expect(outcome).toEqual({ kind: 'match', track: pool[1] })
})

test('a unique size+duration match still wins over a canonical id pointing elsewhere', async () => {
  const pool = [
    missing({ id: 1, canonical_track_id: OTHER_ID }), // size+duration match
    missing({ id: 2, canonical_track_id: ISRC_ID, file_size_bytes: 9 })
  ]
  const outcome = await reconcileFile(candidate({ canonical_track_id: ISRC_ID }), pool)
  expect(outcome).toEqual({ kind: 'match', track: pool[0] })
})

test('a size+duration tie is settled by the canonical id before any file is read', async () => {
  // The candidate path does not exist: if the hash step ran it would hash to
  // null and fall through to filename, which is identical for both rows.
  const pool = [
    missing({ id: 1, canonical_track_id: OTHER_ID }),
    missing({ id: 2, canonical_track_id: ISRC_ID })
  ]
  const outcome = await reconcileFile(
    candidate({ filepath: join(workDir, 'nope.mp3'), canonical_track_id: ISRC_ID }),
    pool
  )
  expect(outcome).toEqual({ kind: 'match', track: pool[1] })
})

test('a size+duration tie the canonical id cannot settle goes on to partial hash as before', async () => {
  const file = join(workDir, 'Track.mp3')
  writeFileSync(file, Buffer.alloc(1000, 7))
  const hash = await computePartialHash(file)
  const pool = [
    missing({ id: 1, canonical_track_id: ISRC_ID, partial_hash: 'something-else' }),
    missing({ id: 2, canonical_track_id: ISRC_ID, partial_hash: hash })
  ]
  const outcome = await reconcileFile(
    candidate({ filepath: file, canonical_track_id: ISRC_ID }),
    pool
  )
  expect(outcome).toEqual({ kind: 'match', track: pool[1] })
})

test('an unresolved size+duration tie is still "none", never offered as a pick', async () => {
  const pool = [missing({ id: 1, filename: 'A.mp3' }), missing({ id: 2, filename: 'B.mp3' })]
  const outcome = await reconcileFile(candidate({ filepath: join(workDir, 'nope.mp3') }), pool)
  expect(outcome).toEqual({ kind: 'none' })
})
