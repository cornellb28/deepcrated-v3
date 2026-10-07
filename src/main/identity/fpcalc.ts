// ── Track identity: running fpcalc (Chromaprint) ──────────────────────────
// fpcalc is NOT bundled with the app yet (pending the licence decision), so
// this only discovers one: a binary placed under resources/bin in a dev
// checkout, a packaged one under the app's resources/bin, or one on PATH. If
// none is found the fingerprint phase is skipped and nothing breaks.
//
// Spawned as a separate process, never linked, with the lowest practical
// priority so a library-wide backfill does not compete with the DJ's audio.

import { execFile, execFileSync } from 'child_process'
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

// Where a bundled copy would live. Listing them here is not bundling.
export function fpcalcCandidates(loc: FpcalcLocation): string[] {
  const exe = loc.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
  if (loc.packaged) return [join(loc.resourcesPath, 'bin', exe)]
  return [
    join(loc.projectRoot, 'resources', 'bin', `${loc.platform}-${loc.arch}`, exe),
    join(loc.projectRoot, 'resources', 'bin', exe)
  ]
}

export function findFpcalc(
  loc: FpcalcLocation,
  exists: (p: string) => boolean = existsSync,
  onPath: () => boolean = fpcalcOnPath
): string | null {
  for (const candidate of fpcalcCandidates(loc)) if (exists(candidate)) return candidate
  return onPath() ? 'fpcalc' : null
}

function fpcalcOnPath(): boolean {
  try {
    execFileSync('fpcalc', ['-version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
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
          if (err) return reject(err)
          try {
            resolve(parseFpcalcOutput(stdout))
          } catch (e) {
            reject(e)
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
