// ── Headless main-process probe ───────────────────────────────────────────
// Boots Electron with no window, points userData at a throwaway directory,
// then runs a list of {fn, args} operations against the REAL main-process
// modules (src/main/db.ts, src/main/sidecar.ts, src/main/serato.ts) and
// writes the results out as JSON.
//
// Why this and not Playwright's electron.launch(): electron.launch() passes
// --remote-debugging-port=0, which this project's Electron rejects outright
// ("bad option"), so the existing e2e suite cannot start at all here. The
// probe needs no debugging port and no window — it only needs `app` to be
// real so db.ts's app.getPath('userData') and sidecar.ts's app.isPackaged
// resolve the way they do in production.

import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'

interface ProbeOp {
  fn: string
  args?: unknown[]
}

type ProbeResult = { ok: true; value: unknown } | { ok: false; error: string }

const userData = process.env.PROBE_USER_DATA
if (userData) {
  mkdirSync(userData, { recursive: true })
  // Must happen before db.ts is loaded — it resolves its SQLite path at
  // import time. Hence the dynamic imports inside run().
  app.setPath('userData', userData)
}

// Map/Set/BigInt all appear in db.ts return values (ensureFolderTree,
// getArtworkHashesInUse, lastInsertRowid) and none survive JSON.stringify
// untouched.
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof Set) return Array.from(value)
  if (Buffer.isBuffer(value)) return { __buffer__: value.toString('base64') }
  return value
}

async function run(): Promise<void> {
  const ops: ProbeOp[] = JSON.parse(readFileSync(process.env.PROBE_OPS!, 'utf8'))
  const results: ProbeResult[] = []

  const db = await import('../../src/main/db')
  const sidecar = await import('../../src/main/sidecar')
  const serato = await import('../../src/main/serato')
  const seratoImport = await import('../../src/main/serato/seratoImport')
  const tagWrites = await import('../../src/main/tagWrites')
  const rescanSweep = await import('../../src/main/rescanSweep')
  const authStore = await import('../../src/main/authStore')
  const moveEngine = await import('../../src/main/moveEngine')
  const filenameTemplate = await import('../../src/main/filenameTemplate')
  const folderRename = await import('../../src/main/folderRename')
  const expectedChanges = await import('../../src/main/expectedChanges')

  const registry: Record<string, (...args: never[]) => unknown> = {
    ...(db as unknown as Record<string, (...args: never[]) => unknown>),
    ...(serato as unknown as Record<string, (...args: never[]) => unknown>),
    ...(seratoImport as unknown as Record<string, (...args: never[]) => unknown>),

    // sweepTracks takes a Set, which does not survive JSON on the way in —
    // a spec sends the plain array of walked paths instead.
    sweepTracks: ((scanPrefix: string, seen: string[]) =>
      rescanSweep.sweepTracks(scanPrefix, new Set(seen))) as unknown as (
      ...args: never[]
    ) => unknown,
    sweepFolders: ((rootId: number, rootPath: string, scannedPath: string, visited: string[]) =>
      rescanSweep.sweepFolders(rootId, rootPath, scannedPath, new Set(visited))) as unknown as (
      ...args: never[]
    ) => unknown,

    // The shared move engine: real files, real rename/EXDEV handling, real
    // DB update. Testing it through here rather than through fs:move-files
    // keeps the assertions on the engine instead of on the job wrapper.
    buildFilename: filenameTemplate.buildFilename as unknown as (...args: never[]) => unknown,
    // The whole rename: real directory, real DB. Exercised end to end rather
    // than through the handler, which a test cannot reach.
    renameFolder: folderRename.renameFolder as unknown as (...args: never[]) => unknown,
    planFolderRename: folderRename.planFolderRename as unknown as (...args: never[]) => unknown,
    moveTrackToFolder: moveEngine.moveTrackToFolder as unknown as (...args: never[]) => unknown,
    moveTracksToFolder: moveEngine.moveTracksToFolder as unknown as (...args: never[]) => unknown,
    clearExpectations: expectedChanges.clearExpectations as unknown as (
      ...args: never[]
    ) => unknown,
    pendingExpectationCount: expectedChanges.pendingExpectationCount as unknown as (
      ...args: never[]
    ) => unknown,

    // Session persistence runs against the real safeStorage + OS keychain
    // under the probe's throwaway userData dir, which is the only way to
    // find out whether the encrypted blob actually round-trips.
    ...(authStore as unknown as Record<string, (...args: never[]) => unknown>),

    // editTagsBatch streams results through a callback; collect them so a
    // spec gets the same per-file outcomes the renderer sees over
    // edit-tags:progress.
    editTags: (async (
      items: { filepath: string; meta: Record<string, unknown> }[],
      options?: { writeSerato?: boolean }
    ) => {
      const collected: unknown[] = []
      await sidecar.editTagsBatch(items, (result) => collected.push(result), options ?? {})
      return collected
    }) as unknown as (...args: never[]) => unknown,

    // The real write path behind sidecar:write-tags — per-file
    // serialization plus the CRATECLOUD_ID conflict retry.
    writeTagsForFile: tagWrites.writeTagsForFile as unknown as (...args: never[]) => unknown,

    // Starts N writes at once without awaiting them, the way two IPC calls
    // arriving together would, and resolves once all have settled.
    writeTagsConcurrently: (async (items: { filepath: string; meta: Record<string, unknown> }[]) =>
      Promise.all(
        items.map((item) => tagWrites.writeTagsForFile(item.filepath, item.meta))
      )) as unknown as (...args: never[]) => unknown,

    analyzeFile: sidecar.analyzeFile as unknown as (...args: never[]) => unknown,

    // analyzeFile's stage callback is what drives the progress bar on a track
    // card. Collecting the stages here is the only way to assert the real
    // path: the stages are parsed out of the sidecar's live stderr stream, so
    // a spec that only looked at the return value would never touch that code.
    analyzeFileWithStages: (async (filepath: string) => {
      const stages: unknown[] = []
      const result = await sidecar.analyzeFile(filepath, (stage) => stages.push(stage))
      return { stages, success: result.success, bpm: result.bpm ?? null }
    }) as unknown as (...args: never[]) => unknown,

    readTagsFast: sidecar.readTagsFast as unknown as (...args: never[]) => unknown,

    // runSeratoImport takes a Set and a progress callback, neither of which
    // survives JSON. This wrapper takes the plain array a spec can send and
    // supplies a no-op onStage.
    seratoImport: (async (
      location: Parameters<typeof seratoImport.runSeratoImport>[0],
      folderPath: string,
      rootId: number,
      freshlyInsertedTrackIds: number[] = []
    ) =>
      seratoImport.runSeratoImport(
        location,
        folderPath,
        rootId,
        new Set(freshlyInsertedTrackIds),
        () => {}
      )) as unknown as (...args: never[]) => unknown
  }

  for (const op of ops) {
    try {
      const fn = registry[op.fn]
      if (typeof fn !== 'function') throw new Error(`unknown probe fn: ${op.fn}`)
      const value = await (fn as (...args: unknown[]) => unknown)(...(op.args ?? []))
      results.push({ ok: true, value: JSON.parse(JSON.stringify(value ?? null, replacer)) })
    } catch (err) {
      results.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  writeFileSync(process.env.PROBE_OUT!, JSON.stringify(results, replacer))
}

app
  .whenReady()
  .then(run)
  .then(
    () => app.exit(0),
    (err) => {
      console.error('[probe] fatal:', err)
      app.exit(1)
    }
  )
