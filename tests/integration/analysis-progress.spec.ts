import { test, expect } from '@playwright/test'
import { rmSync } from 'fs'
import { freshAudio, hasFfmpeg, makeTempDir } from '../helpers/audio'
import { hasElectron, hasSidecarVenv } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// ── What this file is for ─────────────────────────────────────────────────
// A re-analysis is one blocking sidecar call of a few seconds, and the card
// shows a progress bar while it runs. The stages behind that bar take an
// unusual route: analyze.py prints them to STDERR (stdout carries the single
// JSON result every caller parses whole), and main/sidecar.ts picks them out
// of the live stderr stream by a sentinel while leaving librosa's warnings
// alone. That parsing is the part worth pinning down — a chunk boundary can
// fall anywhere, including mid-line, and the failure mode is a bar that never
// moves rather than anything that looks broken.
//
// The renderer is not involved. This drives the real main-process analyzeFile,
// which is what the sidecar:analyze IPC handler calls.

test.skip(!hasElectron(), 'electron/esbuild not installed')
test.skip(!hasSidecarVenv(), 'sidecar/.venv not built — run sidecar/build.sh')
test.skip(!hasFfmpeg(), 'ffmpeg is required to generate audio fixtures')

interface Stage {
  stage: string
  step: number
  steps: number
}

interface StagedAnalysis {
  stages: Stage[]
  success: boolean
  bpm: number | null
}

let workDir: string
let probe: ProbeSession

test.beforeEach(() => {
  workDir = makeTempDir('cratecloud-analysis-')
  probe = createProbeSession()
})

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  probe.cleanup()
})

test('every analysis stage reaches the caller, in the order the sidecar runs them', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const ops: ProbeOp[] = [{ fn: 'analyzeFileWithStages', args: [filepath] }]
  const [analysis] = unwrap<StagedAnalysis>(await probe.run(ops), ops)

  expect(analysis.success).toBe(true)
  expect(analysis.stages.map((s) => s.stage)).toEqual([
    'tags',
    'decode',
    'bpm',
    'key',
    'artwork',
    'done'
  ])
})

test('step counts stages finished, so the bar starts empty and ends full', async () => {
  const filepath = freshAudio(workDir, 'mp3')
  const ops: ProbeOp[] = [{ fn: 'analyzeFileWithStages', args: [filepath] }]
  const [analysis] = unwrap<StagedAnalysis>(await probe.run(ops), ops)

  expect(analysis.stages.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5])
  // Every stage carries the same denominator, and the last one fills the bar
  // exactly — a step past steps would render wider than the card.
  for (const stage of analysis.stages) {
    expect(stage.steps).toBe(5)
    expect(stage.step).toBeLessThanOrEqual(stage.steps)
  }
  expect(analysis.stages.at(-1)).toEqual({ stage: 'done', step: 5, steps: 5 })
})

test('the stage lines stay out of the result every caller parses', async () => {
  // The sentinel lines would break JSON.parse outright if they went to stdout,
  // so a normal-looking result IS the assertion that they did not.
  const filepath = freshAudio(workDir, 'mp3')
  const ops: ProbeOp[] = [
    { fn: 'analyzeFileWithStages', args: [filepath] },
    // No callback at all — the shape every other caller (import, autoAnalyze)
    // still uses. It must behave exactly as it did before stages existed.
    { fn: 'analyzeFile', args: [filepath] }
  ]
  const [staged, plain] = unwrap<StagedAnalysis & { success: boolean }>(await probe.run(ops), ops)

  expect(staged.success).toBe(true)
  expect(staged.bpm).not.toBeNull()
  expect(plain.success).toBe(true)
})

test('an unreadable file reports no stages past the one that failed', async () => {
  // load_audio throws, so decode is the last stage announced and 'done' never
  // arrives. The bar is cleared by the renderer when the call settles rather
  // than by a final event, which is what keeps this from stranding a card.
  const ops: ProbeOp[] = [{ fn: 'analyzeFileWithStages', args: ['/nope/missing.mp3'] }]
  const [analysis] = unwrap<StagedAnalysis>(await probe.run(ops), ops)

  expect(analysis.success).toBe(false)
  expect(analysis.stages.map((s) => s.stage)).not.toContain('done')
})
