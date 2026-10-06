import { test, expect } from '@playwright/test'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import {
  computePartialHash,
  findReconcileMatch,
  PARTIAL_HASH_BYTES,
  FINGERPRINT_DURATION_TOLERANCE_SEC
} from '../../src/main/reconcile'
import { makeTempDir } from '../helpers/audio'

// Covers the track-identity fingerprinting added in 54d4d08/3c2d6dd and
// changed in ec1f81e (sample from mid-file, sha256) — the thing that lets a
// renamed or moved file re-attach to its existing row instead of coming
// back as a new track.

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-reconcile-')
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
