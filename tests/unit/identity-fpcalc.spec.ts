import { test, expect } from '@playwright/test'
import { join } from 'path'
import {
  classifyFpcalcError,
  createFingerprinter,
  FpcalcError,
  fpcalcCandidates,
  getFpcalc,
  NO_FPCALC,
  parseFpcalcOutput,
  parseFpcalcVersion,
  resetFpcalcCache,
  resolveFpcalc,
  type ResolveDeps
} from '../../src/main/identity/fpcalc'

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

test('a dev checkout looks under resources/fpcalc/<platform>-<arch>, then the older resources/bin', () => {
  expect(fpcalcCandidates(base)).toEqual([
    join('/repo', 'resources', 'fpcalc', 'darwin-arm64', 'fpcalc'),
    join('/repo', 'resources', 'bin', 'darwin-arm64', 'fpcalc'),
    join('/repo', 'resources', 'bin', 'fpcalc')
  ])
})

test('a packaged app looks in its own resources/fpcalc, then resources/bin', () => {
  expect(fpcalcCandidates({ ...base, packaged: true })).toEqual([
    join(base.resourcesPath, 'fpcalc', 'fpcalc'),
    join(base.resourcesPath, 'bin', 'fpcalc')
  ])
  expect(fpcalcCandidates({ ...base, platform: 'win32', packaged: true })[0]).toMatch(
    /fpcalc[\\/]fpcalc\.exe$/
  )
})

// ── getFpcalc: bundled, then system, then none ────────────────────────────

const BUNDLED = join('/repo', 'resources', 'fpcalc', 'darwin-arm64', 'fpcalc')

function deps(opts: { files?: string[]; runs?: Record<string, string | null> }): ResolveDeps & {
  probed: string[]
} {
  const probed: string[] = []
  return {
    probed,
    exists: (p) => (opts.files ?? []).includes(p),
    probeVersion: async (binary) => {
      probed.push(binary)
      return opts.runs?.[binary] ?? null
    }
  }
}

test.beforeEach(() => resetFpcalcCache())

test('a bundled copy that runs wins, with its version', async () => {
  const d = deps({ files: [BUNDLED], runs: { [BUNDLED]: '1.6.1', fpcalc: '1.5.1' } })
  await expect(resolveFpcalc(base, d)).resolves.toEqual({
    path: BUNDLED,
    source: 'bundled',
    version: '1.6.1'
  })
  expect(d.probed).toEqual([BUNDLED]) // PATH is not even asked
})

test('with nothing bundled, fpcalc on PATH is used', async () => {
  const d = deps({ runs: { fpcalc: '1.5.1' } })
  await expect(resolveFpcalc(base, d)).resolves.toEqual({
    path: 'fpcalc',
    source: 'system',
    version: '1.5.1'
  })
})

test('a bundled file that will not run is passed over for PATH', async () => {
  const d = deps({ files: [BUNDLED], runs: { [BUNDLED]: null, fpcalc: '1.5.1' } })
  await expect(resolveFpcalc(base, d)).resolves.toMatchObject({ source: 'system' })
})

test('with neither, there is no fpcalc — never a guess', async () => {
  await expect(resolveFpcalc(base, deps({}))).resolves.toEqual(NO_FPCALC)
})

test('getFpcalc resolves once per session and shares the answer', async () => {
  const d = deps({ files: [BUNDLED], runs: { [BUNDLED]: '1.6.1' } })
  const [a, b] = await Promise.all([getFpcalc(base, d), getFpcalc(base, d)])
  await getFpcalc(base, d)
  expect(a).toBe(b)
  expect(d.probed).toEqual([BUNDLED])
})

test('a resolver that throws reads as no fpcalc, not a crash', async () => {
  const result = await getFpcalc(base, {
    exists: () => {
      throw new Error('disk gone')
    }
  })
  expect(result).toEqual(NO_FPCALC)
})

test('the version is read from fpcalc -version', () => {
  expect(parseFpcalcVersion('fpcalc version 1.6.1 (FFmpeg Lavc62.11.100 Lavf62.3.100)')).toBe(
    '1.6.1'
  )
  expect(parseFpcalcVersion('something else')).toBe('unknown')
})

// ── failures are typed ────────────────────────────────────────────────────

test('spawn errors, timeouts and bad exits become typed errors', () => {
  const spawn = classifyFpcalcError(Object.assign(new Error('x'), { code: 'ENOENT' }))
  expect(spawn).toBeInstanceOf(FpcalcError)
  expect(spawn?.kind).toBe('spawn')
  expect(classifyFpcalcError(Object.assign(new Error('x'), { code: 'EACCES' }))?.kind).toBe('spawn')
  expect(
    classifyFpcalcError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }))?.kind
  ).toBe('timeout')
  expect(classifyFpcalcError(Object.assign(new Error('x'), { code: 3 }))?.kind).toBe('exit')
  expect(classifyFpcalcError(null)).toBeNull()
})

test('a real run of a missing binary rejects with a spawn error, it does not throw or hang', async () => {
  const run = createFingerprinter('/nonexistent/fpcalc')
  const err = await run('/nonexistent/track.mp3').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(FpcalcError)
  expect((err as FpcalcError).kind).toBe('spawn')
})
