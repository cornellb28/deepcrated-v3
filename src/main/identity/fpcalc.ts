// ── Track identity: running fpcalc (Chromaprint) ──────────────────────────
// fpcalc 1.6.1 is bundled per platform (scripts/fetch-fpcalc.mjs puts it in
// resources/fpcalc/<platform>-<arch>/; electron-builder ships only the
// build's own copy to <resources>/fpcalc/). getFpcalc() finds it — bundled
// first, then one on PATH, then none — once per session. With none, the
// fingerprint phase is skipped and nothing breaks. Licence: LGPL 2.1, see
// resources/licenses/chromaprint/NOTICE.md.
//
// Spawned as a separate process, never linked, with the lowest practical
// priority so a library-wide backfill does not compete with the DJ's audio.

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { setPriority } from 'os'

// 120 s is Chromaprint's own default and what AcoustID expects; fingerprinting
// the whole of a long mix would only cost time.
export const FINGERPRINT_SECONDS = 120
const RUN_TIMEOUT_MS = 90_000

export interface FpcalcOutput {
  fingerprint: string
  duration: number
}

export function parseFpcalcOutput(stdout: string): FpcalcOutput {
  const parsed = JSON.parse(stdout) as { fingerprint?: unknown; duration?: unknown }
  if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0) {
    throw new Error('fpcalc returned no fingerprint')
  }
  const duration = Number(parsed.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('fpcalc returned no duration')
  return { fingerprint: parsed.fingerprint, duration }
}

export interface FpcalcLocation {
  platform: NodeJS.Platform
  arch: string
  packaged: boolean
  resourcesPath: string // process.resourcesPath
  projectRoot: string
}

// Where a bundled copy lives, in order. resources/bin is the older,
// hand-placed location, still honoured so a setup that works keeps working.
export function fpcalcCandidates(loc: FpcalcLocation): string[] {
  const exe = loc.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
  if (loc.packaged) {
    return [join(loc.resourcesPath, 'fpcalc', exe), join(loc.resourcesPath, 'bin', exe)]
  }
  const target = `${loc.platform}-${loc.arch}`
  return [
    join(loc.projectRoot, 'resources', 'fpcalc', target, exe),
    join(loc.projectRoot, 'resources', 'bin', target, exe),
    join(loc.projectRoot, 'resources', 'bin', exe)
  ]
}

export type FpcalcSource = 'bundled' | 'system'

export interface FpcalcInfo {
  // null when no working fpcalc was found.
  path: string | null
  source: FpcalcSource | null
  version: string | null
}

export const NO_FPCALC: FpcalcInfo = { path: null, source: null, version: null }

export interface ResolveDeps {
  exists: (path: string) => boolean
  // The version a binary reports, or null if it cannot be run.
  probeVersion: (binary: string) => Promise<string | null>
}

// Bundled first, then PATH. A bundled file that will not run (wrong arch,
// stripped exec bit, quarantined) is passed over rather than trusted.
export async function resolveFpcalc(loc: FpcalcLocation, deps: ResolveDeps): Promise<FpcalcInfo> {
  for (const candidate of fpcalcCandidates(loc)) {
    if (!deps.exists(candidate)) continue
    const version = await deps.probeVersion(candidate)
    if (version !== null) return { path: candidate, source: 'bundled', version }
    console.warn(`[identity] bundled fpcalc at ${candidate} did not run; trying PATH`)
  }
  const version = await deps.probeVersion('fpcalc')
  if (version !== null) return { path: 'fpcalc', source: 'system', version }
  return NO_FPCALC
}

// "fpcalc version 1.6.1 (FFmpeg …)" -> "1.6.1". Anything that ran but did
// not say counts as found, version unknown.
export function parseFpcalcVersion(stdout: string): string {
  return /fpcalc version (\S+)/.exec(stdout)?.[1] ?? 'unknown'
}

function probeVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parseFpcalcVersion(stdout))
    })
  })
}

let cached: Promise<FpcalcInfo> | null = null

// The one way to find fpcalc. Resolved once per session (asynchronously, so
// it never blocks the main process) and shared by every caller.
export function getFpcalc(loc: FpcalcLocation, deps?: Partial<ResolveDeps>): Promise<FpcalcInfo> {
  cached ??= resolveFpcalc(loc, {
    exists: deps?.exists ?? existsSync,
    probeVersion: deps?.probeVersion ?? probeVersion
  }).catch(() => NO_FPCALC)
  return cached
}

// Tests only.
export function resetFpcalcCache(): void {
  cached = null
}

// Why a fingerprint run failed. The backfill marks that one track failed
// and carries on; nothing here is fatal.
export type FpcalcErrorKind = 'spawn' | 'timeout' | 'exit' | 'bad-output'

export class FpcalcError extends Error {
  constructor(
    readonly kind: FpcalcErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'FpcalcError'
  }
}

export function classifyFpcalcError(
  err: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null
): FpcalcError | null {
  if (!err) return null
  if (err.killed || err.signal === 'SIGTERM') {
    return new FpcalcError('timeout', `fpcalc timed out after ${RUN_TIMEOUT_MS / 1000} s`)
  }
  if (typeof err.code === 'string') {
    return new FpcalcError('spawn', `fpcalc could not start (${err.code})`)
  }
  if (typeof err.code === 'number') {
    return new FpcalcError('exit', `fpcalc exited with code ${err.code}`)
  }
  return new FpcalcError('spawn', err.message)
}

export type FingerprintFn = (filepath: string) => Promise<FpcalcOutput>

export function createFingerprinter(binary: string): FingerprintFn {
  return (filepath) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        ['-json', '-length', String(FINGERPRINT_SECONDS), filepath],
        { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          const failure = classifyFpcalcError(err)
          if (failure) return reject(failure)
          try {
            resolve(parseFpcalcOutput(stdout))
          } catch (e) {
            reject(new FpcalcError('bad-output', (e as Error).message))
          }
        }
      )
      try {
        if (child.pid) setPriority(child.pid, 10)
      } catch {
        // Lowering priority is a courtesy, not a requirement.
      }
    })
}
