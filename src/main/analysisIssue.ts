// ── Deciding whether an analysis says the FILE is bad ────────────────────
// Pure, in its own module so a unit test can reach it: sidecar.ts imports
// electron. Same split as rescan.ts / rescanSweep.ts.
//
// The result is stored on the track (tracks.analysis_error) so a file that
// cannot be read is skipped by later bulk runs instead of being re-decoded
// every time, and so Crate Health can list it with a reason.
//
// What was measured, on files made by corrupting a real 60 s MP3:
//   truncated  decodes "successfully" to a third of its length; mpg123 says
//              nothing but a stream-size warning, so duration is the only
//              signal.
//   mid-file   decodes ~99% of the audio and prints the resync failure.
//   garbage    ffmpeg fallback also fails; the sidecar returns a failure.
//   tail junk  decodes fully and prints nothing.

export type AnalysisIssue = 'decode_failed' | 'truncated' | 'damaged' | 'timeout'

export const ANALYSIS_ISSUES: readonly AnalysisIssue[] = [
  'decode_failed',
  'truncated',
  'damaged',
  'timeout'
]

export function isAnalysisIssue(value: unknown): value is AnalysisIssue {
  return typeof value === 'string' && (ANALYSIS_ISSUES as readonly string[]).includes(value)
}

// A decode shorter than this fraction of the header's claimed length counts
// as truncated. Not 100%: decoders and encoder padding differ by a few frames.
export const TRUNCATION_RATIO = 0.95

// mpg123 gave up finding the next audio frame — the stream has a bad patch.
const STREAM_DAMAGE_PATTERN = /Giving up resync/i

export interface AnalysisOutcome {
  success: boolean
  error_code?: string
  duration_sec?: number | null
  expected_duration_sec?: number | null
}

// null means "nothing wrong with the file" — including failures that are not
// the file's fault (not found, a sidecar that would not start), which must
// never mark a track as corrupt.
export function classifyAnalysis(result: AnalysisOutcome, stderr: string): AnalysisIssue | null {
  if (!result.success) {
    return result.error_code === 'decode_failed' ? 'decode_failed' : null
  }

  const decoded = result.duration_sec
  const expected = result.expected_duration_sec
  if (
    typeof decoded === 'number' &&
    typeof expected === 'number' &&
    expected > 0 &&
    decoded < expected * TRUNCATION_RATIO
  ) {
    return 'truncated'
  }

  if (STREAM_DAMAGE_PATTERN.test(stderr)) return 'damaged'
  return null
}
