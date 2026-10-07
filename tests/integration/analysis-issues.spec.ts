import { test, expect } from '@playwright/test'
import { randomBytes } from 'crypto'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { freshAudio, hasFfmpeg, makeTempDir } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// ── What this file is for ─────────────────────────────────────────────────
// Analysis now concludes things about the FILE: cut off, damaged, undecodable,
// stuck. That verdict is stored on the track and takes it out of bulk
// analysis, so a bad file is decoded once instead of on every run. These
// specs corrupt a real MP3 in each way and run the real sidecar over it, which
// is the only way to know what the decoder actually says.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

interface Analysis {
  success: boolean
  analysis_issue: string | null
  error?: string
}

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('deepcrated-issues-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

async function analyze(filepath: string): Promise<Analysis> {
  const ops: ProbeOp[] = [{ fn: 'analyzeFile', args: [filepath] }]
  return unwrap<Analysis>(await probe.run(ops), ops)[0]
}

test('a healthy file reports no issue', async () => {
  const result = await analyze(freshAudio(workDir, 'mp3'))
  expect(result.success).toBe(true)
  expect(result.analysis_issue).toBeNull()
})

test('a file cut off part-way is truncated, though it decodes "successfully"', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const bytes = readFileSync(filepath)
  writeFileSync(filepath, bytes.subarray(0, Math.floor(bytes.length / 3)))

  const result = await analyze(filepath)
  expect(result.success).toBe(true)
  expect(result.analysis_issue).toBe('truncated')
})

test('a bad patch in the middle of the stream is damaged', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const bytes = readFileSync(filepath)
  const middle = Math.floor(bytes.length / 2)
  randomBytes(4000).copy(bytes, middle)
  writeFileSync(filepath, bytes)

  const result = await analyze(filepath)
  expect(result.success).toBe(true)
  expect(['damaged', 'truncated']).toContain(result.analysis_issue)
})

test('junk appended after the audio is not an issue', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  writeFileSync(filepath, Buffer.concat([readFileSync(filepath), randomBytes(3000)]))

  const result = await analyze(filepath)
  expect(result.success).toBe(true)
  expect(result.analysis_issue).toBeNull()
})

test('a file that is not audio at all is decode_failed', async () => {
  const filepath = join(workDir, 'garbage.mp3')
  writeFileSync(filepath, randomBytes(50_000))

  const result = await analyze(filepath)
  expect(result.success).toBe(false)
  expect(result.analysis_issue).toBe('decode_failed')
})

test('an empty file is decode_failed', async () => {
  const filepath = join(workDir, 'empty.mp3')
  writeFileSync(filepath, '')

  const result = await analyze(filepath)
  expect(result.success).toBe(false)
  expect(result.analysis_issue).toBe('decode_failed')
})

test('a file that is not there is NOT marked bad', async () => {
  // Missing is not corrupt: it has its own check, and marking it here would
  // keep a file out of analysis after it came back.
  const result = await analyze(join(workDir, 'gone.mp3'))
  expect(result.success).toBe(false)
  expect(result.analysis_issue).toBeNull()
})

test('a decode that outruns the timeout is killed and reported as a timeout', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const ops: ProbeOp[] = [{ fn: 'analyzeFileWithTimeout', args: [filepath, 50] }]
  const [result] = unwrap<Analysis>(await probe.run(ops), ops)
  expect(result.success).toBe(false)
  expect(result.analysis_issue).toBe('timeout')
})

// ── The stored verdict and the bulk-analysis skip ────────────────────────

function seed(filepath: string): ProbeOp[] {
  return [
    { fn: 'addRoot', args: ['Library', workDir] },
    { fn: 'insertTrack', args: [{ filepath, filename: 'a.mp3', title: 'A', artist: 'B' }] }
  ]
}

test('a track marked bad is skipped by bulk analysis, and clearing it brings it back', async () => {
  const filepath = join(workDir, 'a.mp3')
  const ops: ProbeOp[] = [
    ...seed(filepath),
    { fn: 'getUnanalyzedTracks' },
    { fn: 'setTrackAnalysisError', args: [1, 'decode_failed'] },
    { fn: 'getUnanalyzedTracks' },
    { fn: 'getTrackById', args: [1] },
    { fn: 'setTrackAnalysisError', args: [1, null] },
    { fn: 'getUnanalyzedTracks' }
  ]
  const results = unwrap<unknown>(await probe.run(ops), ops)
  const at = (fromEnd: number): unknown => results[results.length - fromEnd]

  expect(at(6)).toHaveLength(1)
  expect(at(4)).toHaveLength(0)
  expect((at(3) as { analysis_error: string }).analysis_error).toBe('decode_failed')
  expect(at(1)).toHaveLength(1)
})

test('Crate Health lists a marked track, and its count matches its queue', async () => {
  const filepath = join(workDir, 'a.mp3')
  const ops: ProbeOp[] = [
    ...seed(filepath),
    { fn: 'getHealthSummary' },
    { fn: 'setTrackAnalysisError', args: [1, 'truncated'] },
    { fn: 'getHealthSummary' },
    { fn: 'getHealthQueue', args: ['unreadable_audio'] }
  ]
  const results = unwrap<unknown>(await probe.run(ops), ops)
  const count = (s: unknown): number =>
    (s as { checks: { id: string; count: number }[] }).checks.find(
      (c) => c.id === 'unreadable_audio'
    )!.count

  expect(count(results[results.length - 4])).toBe(0)
  expect(count(results[results.length - 2])).toBe(1)
  expect(results[results.length - 1]).toEqual([1])
})
