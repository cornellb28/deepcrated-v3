import { execFileSync, execFile } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { ELECTRON_BIN, ESBUILD_BIN, REPO_ROOT } from './paths'
import { makeTempDir } from './audio'

const execFileAsync = promisify(execFile)

const PROBE_BUILD_DIR = join(REPO_ROOT, 'tests', '.probe')
const PROBE_ENTRY = join(REPO_ROOT, 'tests', 'probe', 'main.ts')
const PROBE_BUNDLE = join(PROBE_BUILD_DIR, 'main.js')

export interface ProbeOp {
  fn: string
  args?: unknown[]
}

export type ProbeResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

let built = false

// Electron needs a directory containing a package.json with a "main" entry —
// pointing it at a bare .js file makes it fall back to the app name
// "Electron", which would send app.getPath('userData') somewhere other than
// the directory the probe was told to use.
function buildProbe(): void {
  if (built) return
  mkdirSync(PROBE_BUILD_DIR, { recursive: true })
  writeFileSync(
    join(PROBE_BUILD_DIR, 'package.json'),
    JSON.stringify({ name: 'cratecloud-probe', version: '0.0.0', main: 'main.js' }, null, 2)
  )
  execFileSync(
    ESBUILD_BIN,
    [
      PROBE_ENTRY,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node20',
      // electron is injected by the runtime; better-sqlite3 is a native
      // addon and must stay a real require() resolved from node_modules.
      '--external:electron',
      '--external:better-sqlite3',
      `--outfile=${PROBE_BUNDLE}`
    ],
    { stdio: 'pipe' }
  )
  built = true
}

export interface ProbeSession {
  userDataDir: string
  run<T = unknown>(ops: ProbeOp[]): Promise<ProbeResult<T>[]>
  cleanup(): void
}

// One session == one SQLite database. Each run() is a fresh Electron
// process against that same database, so a spec can assert that a write in
// one process is still there in the next (which is what "persisted" means
// here, as opposed to "the in-memory store said so").
export function createProbeSession(): ProbeSession {
  const userDataDir = makeTempDir('cratecloud-probe-')

  return {
    userDataDir,
    async run<T = unknown>(ops: ProbeOp[]): Promise<ProbeResult<T>[]> {
      buildProbe()
      const ioDir = makeTempDir('cratecloud-probe-io-')
      const opsPath = join(ioDir, 'ops.json')
      const outPath = join(ioDir, 'out.json')
      writeFileSync(opsPath, JSON.stringify(ops))

      const env = { ...process.env }
      // Set globally in this project's shell; leaving it set makes Electron
      // run the entry as plain Node, where `app` is undefined.
      delete env.ELECTRON_RUN_AS_NODE
      env.PROBE_OPS = opsPath
      env.PROBE_OUT = outPath
      env.PROBE_USER_DATA = userDataDir

      try {
        await execFileAsync(ELECTRON_BIN, [PROBE_BUILD_DIR], {
          env,
          cwd: REPO_ROOT,
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`probe process failed: ${detail}`)
      }

      if (!existsSync(outPath)) throw new Error('probe produced no output file')
      const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as ProbeResult<T>[]
      rmSync(ioDir, { recursive: true, force: true })
      return parsed
    },
    cleanup(): void {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

// Convenience for the common case: assert every op succeeded and hand back
// just the values, so a spec reads as a list of calls rather than a list of
// result envelopes.
export function unwrap<T = unknown>(results: ProbeResult[], ops: ProbeOp[]): T[] {
  return results.map((result, index) => {
    if (!result.ok) {
      throw new Error(`probe op ${index} (${ops[index]?.fn}) failed: ${result.error}`)
    }
    return result.value as T
  })
}
