import { test, expect } from '@playwright/test'
import { classifyAnalysis, isAnalysisIssue, TRUNCATION_RATIO } from '../../src/main/analysisIssue'

// What analysis says about the FILE. The rules come from corrupting a real
// 60 s MP3 and watching what the sidecar returned for each case.

const RESYNC =
  'Note: Illegal Audio-MPEG-Header 0xff6a2119 at offset 480697.\nNote: Trying to resync...\n' +
  '[src/libmpg123/parse.c:wetwork():1349] error: Giving up resync after 1024 bytes - your stream is not nice...'

test('a clean analysis is not an issue', () => {
  expect(
    classifyAnalysis({ success: true, duration_sec: 60, expected_duration_sec: 60.03 }, '')
  ).toBeNull()
})

test('a decode failure is decode_failed', () => {
  expect(classifyAnalysis({ success: false, error_code: 'decode_failed' }, '')).toBe(
    'decode_failed'
  )
})

test('failures that are not the file’s fault never mark it', () => {
  // File not found, a sidecar that would not start, an unknown failure.
  expect(classifyAnalysis({ success: false }, '')).toBeNull()
  expect(classifyAnalysis({ success: false, error_code: 'something_else' }, RESYNC)).toBeNull()
})

test('a decode far shorter than the header claims is truncated', () => {
  // The measured case: 19.96 s decoded from a file whose header says 60 s,
  // with nothing on stderr but a stream-size warning.
  expect(
    classifyAnalysis(
      { success: true, duration_sec: 19.96, expected_duration_sec: 60.03 },
      'Warning: Xing stream size off by more than 1%'
    )
  ).toBe('truncated')
})

test('the truncation threshold is 95% of the claimed length', () => {
  const expected = 100
  const at = (ratio: number): ReturnType<typeof classifyAnalysis> =>
    classifyAnalysis(
      { success: true, duration_sec: expected * ratio, expected_duration_sec: expected },
      ''
    )
  expect(at(TRUNCATION_RATIO - 0.01)).toBe('truncated')
  expect(at(TRUNCATION_RATIO)).toBeNull()
  expect(at(0.994)).toBeNull() // the measured mid-file-garbage case: 59.61 of 60.03
  expect(at(1.0)).toBeNull()
})

test('no trusted header length means no truncation verdict', () => {
  for (const expected of [null, undefined, 0, -1]) {
    expect(
      classifyAnalysis({ success: true, duration_sec: 5, expected_duration_sec: expected }, '')
    ).toBeNull()
  }
  expect(classifyAnalysis({ success: true, expected_duration_sec: 60 }, '')).toBeNull()
})

test('a failed resync on a file that otherwise decoded is damaged', () => {
  // The measured mid-file-garbage case: 99.4% decoded, resync failure on stderr.
  expect(
    classifyAnalysis({ success: true, duration_sec: 59.61, expected_duration_sec: 60.03 }, RESYNC)
  ).toBe('damaged')
  expect(classifyAnalysis({ success: true }, RESYNC)).toBe('damaged')
})

test('truncated outranks damaged when both show', () => {
  expect(
    classifyAnalysis({ success: true, duration_sec: 10, expected_duration_sec: 60 }, RESYNC)
  ).toBe('truncated')
})

test('ordinary decoder chatter is not an issue', () => {
  const chatter =
    'Note: Trying to resync...\nNote: Skipped 1024 bytes in input.\n' +
    '[src/libmpg123/id3.c:process_extra():684] error: No extra frame text / valid description?'
  // The id3 line from the original report is a metadata nit, not audio damage.
  expect(
    classifyAnalysis({ success: true, duration_sec: 60, expected_duration_sec: 60 }, chatter)
  ).toBeNull()
})

test('only known codes are accepted', () => {
  for (const code of ['decode_failed', 'truncated', 'damaged', 'timeout']) {
    expect(isAnalysisIssue(code)).toBe(true)
  }
  expect(isAnalysisIssue('nope')).toBe(false)
  expect(isAnalysisIssue(null)).toBe(false)
  expect(isAnalysisIssue(undefined)).toBe(false)
})
