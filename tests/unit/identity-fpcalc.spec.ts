import { test, expect } from '@playwright/test'
import { join } from 'path'
import { findFpcalc, fpcalcCandidates, parseFpcalcOutput } from '../../src/main/identity/fpcalc'

const base = {
  platform: 'darwin' as const,
  arch: 'arm64',
  packaged: false,
  resourcesPath: '/Applications/DeepCrated.app/Contents/Resources',
  projectRoot: '/repo'
}

test('fpcalc JSON output is parsed', () => {
  expect(parseFpcalcOutput('{"duration": 215.4, "fingerprint": "AQADtEmU"}')).toEqual({
    fingerprint: 'AQADtEmU',
    duration: 215.4
  })
})

test('output with no fingerprint or no duration is an error, not an empty fingerprint', () => {
  expect(() => parseFpcalcOutput('{"duration": 10, "fingerprint": ""}')).toThrow()
  expect(() => parseFpcalcOutput('{"fingerprint": "AQ"}')).toThrow()
  expect(() => parseFpcalcOutput('{"duration": 0, "fingerprint": "AQ"}')).toThrow()
  expect(() => parseFpcalcOutput('not json')).toThrow()
})

test('a dev checkout looks under resources/bin, a packaged app under its resources', () => {
  expect(fpcalcCandidates(base)).toEqual([
    join('/repo', 'resources', 'bin', 'darwin-arm64', 'fpcalc'),
    join('/repo', 'resources', 'bin', 'fpcalc')
  ])
  expect(fpcalcCandidates({ ...base, packaged: true })).toEqual([
    join(base.resourcesPath, 'bin', 'fpcalc')
  ])
  expect(fpcalcCandidates({ ...base, platform: 'win32', packaged: true })[0]).toMatch(
    /fpcalc\.exe$/
  )
})

test('findFpcalc prefers a bundled copy, then PATH, then reports none', () => {
  const bundled = join('/repo', 'resources', 'bin', 'darwin-arm64', 'fpcalc')
  expect(
    findFpcalc(
      base,
      (p) => p === bundled,
      () => true
    )
  ).toBe(bundled)
  expect(
    findFpcalc(
      base,
      () => false,
      () => true
    )
  ).toBe('fpcalc')
  expect(
    findFpcalc(
      base,
      () => false,
      () => false
    )
  ).toBeNull()
})
