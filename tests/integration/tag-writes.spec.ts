import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { freshAudio, hasFfmpeg, makeTempDir, readFileTags } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Covers src/main/tagWrites.ts: the per-file serialization every tag write
// goes through, and the CRATECLOUD_ID conflict retry.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-tagwrites-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

interface WriteResult {
  success: boolean
  error?: string
  existing?: string
  serato_written?: boolean
}

// ── Serialization ─────────────────────────────────────────────────────────

test('writes to one file started at the same moment do not lose an edit', async () => {
  // Without the queue both writes copy the pre-edit file and the later
  // atomic replace discards the earlier one's change entirely.
  const filepath = freshAudio(workDir, 'mp3')

  await run([
    {
      fn: 'writeTagsConcurrently',
      args: [
        [
          { filepath, meta: { title: 'Writer A' } },
          { filepath, meta: { artist: 'Writer B' } },
          { filepath, meta: { album: 'Writer C' } }
        ]
      ]
    }
  ])

  const tags = await readFileTags(filepath)
  expect(tags.title).toBe('Writer A')
  expect(tags.artist).toBe('Writer B')
  expect(tags.album).toBe('Writer C')
})

test('writes to different files are not serialized against each other', async () => {
  const first = freshAudio(workDir, 'mp3', 'first')
  const second = freshAudio(workDir, 'mp3', 'second')

  await run([
    {
      fn: 'writeTagsConcurrently',
      args: [
        [
          { filepath: first, meta: { title: 'First' } },
          { filepath: second, meta: { title: 'Second' } }
        ]
      ]
    }
  ])

  expect((await readFileTags(first)).title).toBe('First')
  expect((await readFileTags(second)).title).toBe('Second')
})

test('a failed write does not block the next write to that file', async () => {
  const filepath = freshAudio(workDir, 'mp3')

  const [failed, succeeded] = await run<WriteResult[]>([
    // A cratecloud_id conflict cannot be the failure here, so use a path
    // that does not exist for the failing half.
    { fn: 'writeTagsForFile', args: [`${workDir}/absent.mp3`, { title: 'Nope' }] },
    { fn: 'writeTagsForFile', args: [filepath, { title: 'Still works' }] }
  ])

  expect(failed[0].success).toBe(false)
  expect(succeeded[0].success).toBe(true)
  expect((await readFileTags(filepath)).title).toBe('Still works')
})

// ── CRATECLOUD_ID conflicts ───────────────────────────────────────────────

test('an edit still lands when the file already carries a different CRATECLOUD_ID', async () => {
  const filepath = freshAudio(workDir, 'mp3')

  const [, retried] = await run<WriteResult[]>([
    { fn: 'writeTagsForFile', args: [filepath, { cratecloud_id: 'id-from-another-library' }] },
    {
      fn: 'writeTagsForFile',
      args: [filepath, { title: 'Edited Anyway', artist: 'Edited Too', cratecloud_id: 'our-id' }]
    }
  ])

  expect(retried[0].success, 'the retry without the identity field must succeed').toBe(true)

  const tags = await readFileTags(filepath)
  expect(tags.title).toBe('Edited Anyway')
  expect(tags.artist).toBe('Edited Too')
  // The file keeps the id it already had — the retry drops ours rather than
  // overwriting an identity another library may still be matching on.
  expect(tags.cratecloud_id).toBe('id-from-another-library')
})

test('a matching CRATECLOUD_ID is written through without a retry', async () => {
  const filepath = freshAudio(workDir, 'mp3')

  const [, second] = await run<WriteResult[]>([
    { fn: 'writeTagsForFile', args: [filepath, { cratecloud_id: 'same-id' }] },
    { fn: 'writeTagsForFile', args: [filepath, { title: 'Fine', cratecloud_id: 'same-id' }] }
  ])

  expect(second[0].success).toBe(true)
  expect(second[0].error).toBeUndefined()
  const tags = await readFileTags(filepath)
  expect(tags.title).toBe('Fine')
  expect(tags.cratecloud_id).toBe('same-id')
})

test('a first write stamps the identity onto a file that had none', async () => {
  const filepath = freshAudio(workDir, 'mp3')

  const [results] = await run<WriteResult[]>([
    { fn: 'writeTagsForFile', args: [filepath, { title: 'Fresh', cratecloud_id: 'brand-new' }] }
  ])

  expect(results[0].success).toBe(true)
  expect((await readFileTags(filepath)).cratecloud_id).toBe('brand-new')
})

test('a real failure is still reported rather than retried away', async () => {
  const [results] = await run<WriteResult[]>([
    { fn: 'writeTagsForFile', args: [`${workDir}/missing.mp3`, { title: 'T' }] }
  ])

  expect(results[0].success).toBe(false)
  expect(results[0].error).toContain('not found')
})
