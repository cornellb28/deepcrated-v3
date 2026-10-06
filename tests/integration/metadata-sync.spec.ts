import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import {
  ALL_EXTS,
  freshAudio,
  hasFfmpeg,
  makeTempDir,
  readFileTags,
  type AudioExt
} from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// ── What this file is for ─────────────────────────────────────────────────
// A CrateCloud edit has to land in two places to be worth anything: the
// SQLite row (so the app still shows it next launch) and the audio file's
// own tags (so anything else — Serato, Rekordbox, Finder — can ever see
// it). These specs drive the real main-process modules and then check both
// sides, because a write that only reaches one of them looks completely
// fine inside CrateCloud and is invisible everywhere else.
//
// The renderer is not involved. Every sequence below mirrors what
// Inspector.saveField / BulkEditModal.handleSave actually send over IPC:
// db.updateTrackMeta for the row, then sidecar writeTags for the file.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-sync-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

interface TrackRow {
  id: number
  [key: string]: unknown
}

// Every field the inspector, the bulk editor or a tag badge can change,
// paired with the database column it lands in and the edit_tags.py meta key
// it travels under. One list so a new editable field cannot be added to the
// UI without showing up as a gap here.
const EDITABLE_FIELDS = [
  { column: 'title', metaKey: 'title', value: 'Edited Title' },
  { column: 'artist', metaKey: 'artist', value: 'Edited Artist' },
  { column: 'album', metaKey: 'album', value: 'Edited Album' },
  { column: 'genre', metaKey: 'genre', value: 'Edited Genre' },
  { column: 'year', metaKey: 'year', value: '2024' },
  { column: 'comment', metaKey: 'comment', value: 'Edited Comment' },
  { column: 'label', metaKey: 'label', value: 'Edited Label' },
  { column: 'grouping', metaKey: 'grouping', value: 'Edited Grouping' },
  { column: 'composer', metaKey: 'composer', value: 'Edited Composer' },
  { column: 'remixer', metaKey: 'remixer', value: 'Edited Remixer' }
] as const

function seedTrack(filepath: string, overrides: Record<string, unknown> = {}): ProbeOp {
  return {
    fn: 'insertTrack',
    args: [
      {
        filepath,
        filename: filepath.split('/').pop(),
        title: 'Original Title',
        artist: 'Original Artist',
        album: 'Original Album',
        genre: 'Original Genre',
        year: '1996',
        comment: 'Original Comment',
        label: 'Original Label',
        grouping: 'Original Grouping',
        composer: 'Original Composer',
        remixer: 'Original Remixer',
        bpm: 100,
        key_camelot: '1A',
        ...overrides
      }
    ]
  }
}

// ── The database half ─────────────────────────────────────────────────────

test('every editable field survives updateTrackMeta', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const edits = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f.column, f.value]))

  const [, , row] = await run<TrackRow>([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, ...edits, bpm: 128, key_camelot: '8A' }] },
    { fn: 'getTrackById', args: [1] }
  ])

  const dropped = EDITABLE_FIELDS.filter((f) => row[f.column] !== f.value).map((f) => f.column)
  expect(
    dropped,
    `updateTrackMeta silently discarded these columns — its UPDATE statement has no ` +
      `clause for them, and better-sqlite3 ignores named parameters a statement does ` +
      `not bind, so the call still reports success`
  ).toEqual([])
})

test('bpm, key and energy survive updateTrackMeta', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const [, , row] = await run<TrackRow>([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, bpm: 128.5, key_camelot: '8A', energy: 7 }] },
    { fn: 'getTrackById', args: [1] }
  ])

  expect(row.bpm).toBe(128.5)
  expect(row.key_camelot).toBe('8A')
  expect(row.energy).toBe(7)
})

test('an edit is still in the database after the app restarts', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  await run([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, title: 'Persisted Title', bpm: 142 }] }
  ])

  // A second probe run is a second Electron process against the same
  // SQLite file — the only way to tell a real write from a cached one.
  const [row] = await run<TrackRow>([{ fn: 'getTrackById', args: [1] }])
  expect(row.title).toBe('Persisted Title')
  expect(row.bpm).toBe(142)
})

test('updateTrackMeta merges onto the existing row instead of blanking omitted fields', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const [, , row] = await run<TrackRow>([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, bpm: 128 }] },
    { fn: 'getTrackById', args: [1] }
  ])

  expect(row.title).toBe('Original Title')
  expect(row.artist).toBe('Original Artist')
  expect(row.comment).toBe('Original Comment')
})

// ── The file half, and the two together ───────────────────────────────────

test('an inspector edit reaches the database and the file with the same value', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const edits = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f.column, f.value]))
  const meta = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f.metaKey, f.value]))

  const [, , , row] = await run<TrackRow>([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, ...edits }] },
    { fn: 'editTags', args: [[{ filepath, meta }], { writeSerato: true }] },
    { fn: 'getTrackById', args: [1] }
  ])

  const fileTags = await readFileTags(filepath)

  const divergent = EDITABLE_FIELDS.filter(
    (f) => row[f.column] !== f.value || fileTags[f.metaKey as keyof typeof fileTags] !== f.value
  ).map((f) => ({
    field: f.column,
    wanted: f.value,
    database: row[f.column],
    file: fileTags[f.metaKey as keyof typeof fileTags]
  }))

  expect(
    divergent,
    'the database row and the file tags must agree after one edit — a field ' +
      'that only reaches one of them is invisible in the other place'
  ).toEqual([])
})

test('a bpm edit reaches the file as well as the database', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const [, , , row] = await run<TrackRow>([
    seedTrack(filepath),
    { fn: 'updateTrackMeta', args: [{ id: 1, bpm: 128 }] },
    { fn: 'editTags', args: [[{ filepath, meta: { bpm: 128 } }], { writeSerato: true }] },
    { fn: 'getTrackById', args: [1] }
  ])

  expect(row.bpm).toBe(128)
  expect((await readFileTags(filepath)).bpm).toBe('128')
})

test('a bpm edit also lands Serato Autotags, so Serato sees the tempo', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const [, results] = await run<unknown>([
    seedTrack(filepath),
    { fn: 'editTags', args: [[{ filepath, meta: { bpm: 128 } }], { writeSerato: true }] }
  ])

  const [first] = results as { success: boolean; serato_written?: boolean }[]
  expect(first.success).toBe(true)
  expect(first.serato_written).toBe(true)
  expect((await readFileTags(filepath)).geob).toContain('GEOB:Serato Autotags')
})

for (const ext of ALL_EXTS) {
  test(`${ext}: a title edit reaches both the database and the file`, async () => {
    const filepath = freshAudio(workDir, ext as AudioExt)
    const [, , , row] = await run<TrackRow>([
      seedTrack(filepath),
      { fn: 'updateTrackMeta', args: [{ id: 1, title: 'Cross Format' }] },
      { fn: 'editTags', args: [[{ filepath, meta: { title: 'Cross Format' } }], {}] },
      { fn: 'getTrackById', args: [1] }
    ])

    expect(row.title).toBe('Cross Format')
    expect((await readFileTags(filepath)).title).toBe('Cross Format')
  })
}

// ── Stable identity ───────────────────────────────────────────────────────

test("the track's client_uuid is written into the file as CRATECLOUD_ID", async () => {
  // insertTrack mints a client_uuid per row, and analyze.py reads
  // CRATECLOUD_ID back as that same identity so a track survives a rename
  // or a move. That only works if a write actually puts it on the file.
  const filepath = freshAudio(workDir, 'mp3')
  const [, row] = await run<TrackRow>([seedTrack(filepath), { fn: 'getTrackById', args: [1] }])
  const clientUuid = row.client_uuid as string
  expect(clientUuid, 'insertTrack should mint a client_uuid').toBeTruthy()

  await run([
    {
      fn: 'editTags',
      args: [[{ filepath, meta: { title: 'Has Identity', cratecloud_id: clientUuid } }], {}]
    }
  ])

  expect((await readFileTags(filepath)).cratecloud_id).toBe(clientUuid)
})

test('a re-read of a moved file matches it back by its CRATECLOUD_ID', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const [, row] = await run<TrackRow>([seedTrack(filepath), { fn: 'getTrackById', args: [1] }])
  const clientUuid = row.client_uuid as string

  await run([{ fn: 'editTags', args: [[{ filepath, meta: { cratecloud_id: clientUuid } }], {}] }])

  const [analysis] = await run<{ client_uuid: string | null }>([
    { fn: 'readTagsFast', args: [filepath] }
  ])
  expect(analysis.client_uuid).toBe(clientUuid)
})

// ── Concurrency ───────────────────────────────────────────────────────────

test('two writes to one file in a single batch both land', async () => {
  // Batched items run sequentially inside one sidecar process, so the
  // second edit sees the first one's committed file.
  const filepath = freshAudio(workDir, 'mp3')
  await run([
    seedTrack(filepath),
    {
      fn: 'editTags',
      args: [
        [
          { filepath, meta: { title: 'First' } },
          { filepath, meta: { artist: 'Second' } }
        ],
        {}
      ]
    }
  ])

  const tags = await readFileTags(filepath)
  expect(tags.title).toBe('First')
  expect(tags.artist).toBe('Second')
})

// Concurrency is covered properly in tag-writes.spec.ts, against the real
// queue in src/main/tagWrites.ts. Probe ops run one after another, so a
// spec written here could not have started two writes at the same moment.
