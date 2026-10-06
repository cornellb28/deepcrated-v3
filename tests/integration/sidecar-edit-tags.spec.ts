import { test, expect } from '@playwright/test'
import { readFileSync, statSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  ALL_EXTS,
  SERATO_AUTOTAG_EXTS,
  editTagsBatch,
  editTagsSingle,
  freshAudio,
  hasFfmpeg,
  makeTempDir,
  readFileTags,
  type AudioExt
} from '../helpers/audio'
import { hasSidecarVenv } from '../helpers/paths'

// Covers sidecar/edit_tags.py — the only thing in CrateCloud that writes
// metadata into the audio file itself, and therefore the only thing that
// can ever make an edit visible to Serato, Rekordbox or Finder.

test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

let workDir: string

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-tags-')
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const FULL_META = {
  title: 'Big Momma Thang',
  artist: 'Lil Kim',
  album: 'Hard Core',
  genre: 'Hip Hop',
  bpm: 95.7,
  key: '11A',
  year: '1996',
  comment: 'CLASSIC / HEADZ',
  label: 'Undeas',
  grouping: 'Crate Ready',
  composer: 'Composer Name',
  remixer: 'Remixer Name',
  cratecloud_id: 'f38438d6-56a8-4cb9-a9ac-c4b0a616b602'
}

// Fields each container format can actually carry. Anything listed here is
// asserted to survive the round trip; anything deliberately absent is
// asserted to stay unwritten by the "unsupported fields" test below, so a
// gap can never be mistaken for coverage.
const EXPECTED_FIELDS: Record<AudioExt, string[]> = {
  mp3: [
    'title',
    'artist',
    'album',
    'genre',
    'bpm',
    'key',
    'year',
    'comment',
    'label',
    'grouping',
    'composer',
    'remixer',
    'cratecloud_id'
  ],
  aiff: [
    'title',
    'artist',
    'album',
    'genre',
    'bpm',
    'key',
    'year',
    'comment',
    'label',
    'grouping',
    'composer',
    'remixer',
    'cratecloud_id'
  ],
  wav: [
    'title',
    'artist',
    'album',
    'genre',
    'bpm',
    'key',
    'year',
    'comment',
    'label',
    'grouping',
    'composer',
    'remixer',
    'cratecloud_id'
  ],
  flac: [
    'title',
    'artist',
    'album',
    'genre',
    'bpm',
    'key',
    'year',
    'comment',
    'label',
    'grouping',
    'composer',
    'remixer',
    'cratecloud_id'
  ],
  // MP4 has no standard frame for key, label or remixer — edit_m4a writes all
  // three as iTunes freeform atoms instead (see edit_tags.py). Serato reads
  // `initialkey` back but ignores an MP4's label and remixer, so those two
  // survive in the file and in CrateCloud without ever showing up in Serato.
  m4a: [
    'title',
    'artist',
    'album',
    'genre',
    'bpm',
    'key',
    'year',
    'comment',
    'label',
    'grouping',
    'composer',
    'remixer',
    'cratecloud_id'
  ]
}

// BPM is written as an integer in every format (TBPM/tmpo/BPM are whole
// numbers), so 95.7 comes back as "95".
const EXPECTED_VALUES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FULL_META).map(([key, value]) => [key, String(value)])),
  bpm: '95'
}

// ── Round trip, per format ────────────────────────────────────────────────

for (const ext of ALL_EXTS) {
  test(`${ext}: every supported field written by the sidecar reads back off disk`, async () => {
    const filepath = freshAudio(workDir, ext)
    const result = await editTagsSingle(filepath, FULL_META)
    expect(result.success, result.error).toBe(true)

    const tags = await readFileTags(filepath)
    for (const field of EXPECTED_FIELDS[ext]) {
      expect(tags[field as keyof typeof tags], `${ext} ${field}`).toBe(EXPECTED_VALUES[field])
    }
  })

  test(`${ext}: fields the format cannot carry are reported, not silently dropped`, async () => {
    const filepath = freshAudio(workDir, ext)
    await editTagsSingle(filepath, FULL_META)
    const tags = await readFileTags(filepath)

    const unwritten = [
      'title',
      'artist',
      'album',
      'genre',
      'bpm',
      'key',
      'year',
      'comment',
      'label',
      'grouping',
      'composer',
      'remixer',
      'cratecloud_id'
    ].filter((field) => !EXPECTED_FIELDS[ext].includes(field))

    for (const field of unwritten) {
      expect(tags[field as keyof typeof tags], `${ext} ${field} should be unwritten`).toBeNull()
    }
  })

  test(`${ext}: a partial edit leaves the fields it did not mention alone`, async () => {
    const filepath = freshAudio(workDir, ext)
    await editTagsSingle(filepath, { title: 'First Title', artist: 'First Artist' })
    await editTagsSingle(filepath, { artist: 'Second Artist' })

    const tags = await readFileTags(filepath)
    expect(tags.title).toBe('First Title')
    expect(tags.artist).toBe('Second Artist')
  })
}

// ── Serato Autotags ───────────────────────────────────────────────────────

for (const ext of SERATO_AUTOTAG_EXTS) {
  test(`${ext}: a bpm write also lands a Serato Autotags block in the file`, async () => {
    const filepath = freshAudio(workDir, ext)
    const result = await editTagsSingle(filepath, { title: 'T', bpm: 128 })

    expect(result.serato_written, result.serato_error).toBe(true)
    const tags = await readFileTags(filepath)
    expect(tags.geob).toContain('GEOB:Serato Autotags')
  })

  test(`${ext}: with no bpm there is nothing to write and the reason says so`, async () => {
    const filepath = freshAudio(workDir, ext)
    const result = await editTagsSingle(filepath, { title: 'No BPM here' })

    expect(result.success).toBe(true)
    expect(result.serato_written).toBe(false)
    expect(result.serato_error).toContain('bpm')
    expect((await readFileTags(filepath)).geob).toEqual([])
  })

  test(`${ext}: --no-serato writes standard tags only`, async () => {
    const filepath = freshAudio(workDir, ext)
    const result = await editTagsSingle(filepath, { title: 'T', bpm: 128 }, { noSerato: true })

    expect(result.serato_written).toBe(false)
    expect(result.serato_error).toContain('--no-serato')
    expect((await readFileTags(filepath)).bpm).toBe('128')
    expect((await readFileTags(filepath)).geob).toEqual([])
  })
}

for (const ext of ['flac', 'm4a'] as AudioExt[]) {
  test(`${ext}: Serato Autotags are refused with a reason rather than faked`, async () => {
    const filepath = freshAudio(workDir, ext)
    const result = await editTagsSingle(filepath, { title: 'T', bpm: 128 })

    expect(result.success).toBe(true)
    expect(result.serato_written).toBe(false)
    expect(result.serato_error).toBeTruthy()
  })
}

// ── Failure handling ──────────────────────────────────────────────────────

test('an unsupported extension fails loudly instead of reporting success', async () => {
  const filepath = join(workDir, 'track.ogg')
  writeFileSync(filepath, 'not really an ogg')

  const result = await editTagsSingle(filepath, { title: 'T' })
  expect(result.success).toBe(false)
  expect(result.error).toContain('.ogg')
})

test('a missing file fails with the path it could not find', async () => {
  const result = await editTagsSingle(join(workDir, 'nope.mp3'), { title: 'T' })
  expect(result.success).toBe(false)
  expect(result.error).toContain('not found')
})

// Documents current behaviour, which is not obviously the behaviour you
// would want: a file that mutagen cannot parse as MPEG audio still gets a
// fresh ID3 header prepended and still reports success. The undecodable
// audio only surfaces indirectly, as the Serato sub-result failing with
// "can't sync to MPEG frame". If this should become a hard failure, change
// edit_mp3's ID3Error fallback and flip this test.
test('a non-audio .mp3 is still tagged and still reports success', async () => {
  const filepath = join(workDir, 'broken.mp3')
  writeFileSync(filepath, 'this is not an mp3 at all, not even close')

  const result = await editTagsSingle(filepath, { title: 'T', bpm: 120 })
  expect(result.success).toBe(true)
  expect(result.serato_written).toBe(false)
  expect(readFileSync(filepath).subarray(0, 3).toString('ascii')).toBe('ID3')
  expect((await readFileTags(filepath)).title).toBe('T')
})

test('an audio file mutagen cannot open at all is left byte-for-byte unchanged', async () => {
  const filepath = join(workDir, 'broken.flac')
  const original = Buffer.from('this is not a flac stream')
  writeFileSync(filepath, original)

  const result = await editTagsSingle(filepath, { title: 'T' })
  expect(result.success).toBe(false)
  expect(readFileSync(filepath)).toEqual(original)
})

test("a failed edit leaves no temp file behind in the track's folder", async () => {
  const filepath = join(workDir, 'broken.flac')
  writeFileSync(filepath, 'garbage')
  await editTagsSingle(filepath, { title: 'T' })

  expect(readdirSync(workDir).filter((f) => f.startsWith('.cratecloud_edit_'))).toEqual([])
})

// ── CRATECLOUD_ID identity guard ──────────────────────────────────────────

test('writing a cratecloud_id onto a file that already has a different one is refused', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  await editTagsSingle(filepath, { cratecloud_id: 'first-uuid' })

  const result = await editTagsSingle(filepath, { title: 'T', cratecloud_id: 'second-uuid' })
  expect(result.success).toBe(false)
  expect(result.error).toBe('cratecloud_id_conflict')
  expect(result.existing).toBe('first-uuid')

  // The conflicting edit must not have partially landed.
  const tags = await readFileTags(filepath)
  expect(tags.cratecloud_id).toBe('first-uuid')
  expect(tags.title).toBeNull()
})

test('rewriting the same cratecloud_id is allowed and edits go through', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  await editTagsSingle(filepath, { cratecloud_id: 'same-uuid' })

  const result = await editTagsSingle(filepath, { title: 'Updated', cratecloud_id: 'same-uuid' })
  expect(result.success).toBe(true)
  expect((await readFileTags(filepath)).title).toBe('Updated')
})

test('the identity check does not add a tag block to an untagged file', async () => {
  // _read_cratecloud_id must stay read-only — a probe that created an ID3
  // header would change the file before any edit was even attempted.
  const filepath = freshAudio(workDir, 'mp3')
  const before = readFileSync(filepath)

  const result = await editTagsSingle(join(workDir, 'absent.mp3'), { cratecloud_id: 'x' })
  expect(result.success).toBe(false)
  expect(readFileSync(filepath)).toEqual(before)
})

// ── mtime, for the folder watcher and for Serato ──────────────────────────

test('a tag write moves the file mtime forward', async () => {
  // The live folder watcher and every external library that caches metadata
  // key off mtime; preserving it would make an edit invisible to both.
  const filepath = freshAudio(workDir, 'mp3')
  const before = statSync(filepath).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 1100))

  await editTagsSingle(filepath, { title: 'Changed' })
  expect(statSync(filepath).mtimeMs).toBeGreaterThan(before)
})

// ── Batch mode ────────────────────────────────────────────────────────────

test('batch mode returns one result per item, in the order submitted', async () => {
  const items = ALL_EXTS.map((ext, index) => ({
    filepath: freshAudio(workDir, ext, `batch-${index}`),
    meta: { title: `Batch ${index}`, artist: `Artist ${index}` }
  }))

  const results = await editTagsBatch(items)
  expect(results).toHaveLength(items.length)
  expect(results.map((r) => r.filepath)).toEqual(items.map((i) => i.filepath))
  expect(results.every((r) => r.success)).toBe(true)

  for (const [index, item] of items.entries()) {
    expect((await readFileTags(item.filepath)).title).toBe(`Batch ${index}`)
  }
})

test('one bad item in a batch fails alone and the rest still get written', async () => {
  const good = freshAudio(workDir, 'mp3', 'good')
  const bad = join(workDir, 'bad.ogg')
  writeFileSync(bad, 'nope')
  const alsoGood = freshAudio(workDir, 'flac', 'also-good')

  const results = await editTagsBatch([
    { filepath: good, meta: { title: 'Good' } },
    { filepath: bad, meta: { title: 'Bad' } },
    { filepath: alsoGood, meta: { title: 'Also Good' } }
  ])

  expect(results.map((r) => r.success)).toEqual([true, false, true])
  expect((await readFileTags(good)).title).toBe('Good')
  expect((await readFileTags(alsoGood)).title).toBe('Also Good')
})

test('a malformed batch line fails that item without aborting the batch', async () => {
  const good = freshAudio(workDir, 'mp3', 'good')
  const results = await editTagsBatch([
    { filepath: '', meta: { title: 'no filepath' } } as never,
    { filepath: good, meta: { title: 'Fine' } }
  ])

  expect(results[0].success).toBe(false)
  expect(results[1].success).toBe(true)
  expect((await readFileTags(good)).title).toBe('Fine')
})
