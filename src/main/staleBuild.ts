// ── Stale-build detection ─────────────────────────────────────────────────
// A preload script is read once, when the BrowserWindow is constructed, and
// the main process is whatever was on disk when Electron launched. The
// renderer, meanwhile, hot-reloads. So it is entirely possible — and in
// practice routine — to be looking at new renderer code talking to a main
// process from twenty minutes ago.
//
// It does not fail loudly. It fails as a signature mismatch: the renderer
// sends an argument shape the old handler was never written for, and the
// first thing that notices is SQLite refusing to bind an array. That is a
// long way from "restart the app", which is the actual fix.
//
// electron-vite normally restarts on a main-process change, but it cannot
// when the rebuild belongs to a DIFFERENT dev server than the one holding
// requestSingleInstanceLock — start a second `npm run dev` and the new one
// builds into out/ while the old process keeps running the old code.
//
// So rather than trusting the build pipeline, this asks the only question
// that matters: are the bundles on disk still the ones this process loaded?

import { readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'

export interface BuildStatus {
  stale: boolean
  // Which bundles changed, for a message that says what to expect.
  changed: string[]
}

// Bundle paths relative to the running main bundle (out/main/index.js).
const BUNDLES: Record<string, string> = {
  main: join(__dirname, 'index.js'),
  preload: join(__dirname, '..', 'preload', 'index.js')
}

// Content hash, not mtime: a rebuild that produces identical output is not a
// stale process, and touching a file without changing it should not nag.
function fingerprint(path: string): string | null {
  try {
    // Size first as a cheap guard — hashing a 170 KB bundle on every poll is
    // avoidable when the size alone already differs.
    const { size } = statSync(path)
    const hash = createHash('sha1').update(readFileSync(path)).digest('hex')
    return `${size}:${hash}`
  } catch {
    // Missing bundle: nothing useful to compare against, so say nothing.
    return null
  }
}

// Captured once, at import — which is as close to "what this process is
// actually running" as we can get from inside it.
const loaded: Record<string, string | null> = Object.fromEntries(
  Object.entries(BUNDLES).map(([name, path]) => [name, fingerprint(path)])
)

export function checkBuildStatus(): BuildStatus {
  const changed: string[] = []

  for (const [name, path] of Object.entries(BUNDLES)) {
    const before = loaded[name]
    if (before === null) continue
    const now = fingerprint(path)
    if (now !== null && now !== before) changed.push(name)
  }

  return { stale: changed.length > 0, changed }
}
