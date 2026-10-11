// ── Track identity: lifecycle ─────────────────────────────────────────────
// Runs the backfill engine in the background: shortly after launch, every
// ten minutes, and whenever kicked (after an import, or when the lookup
// setting is switched on). Never blocks the UI — all work is async, in child
// processes, in small batches — and it steps aside while an import runs.

import { app, net } from 'electron'
import { join } from 'path'
import { getIdentityStore, getSetting } from '../db'
import { readIdentityTags } from '../sidecar'
import { createEngine } from './engine'
import {
  createFingerprinter,
  FpcalcError,
  getFpcalc,
  type FingerprintFn,
  type FpcalcInfo
} from './fpcalc'
import { createLookup, isLookupConfigured, type Lookup, type LookupConfig } from './lookup'
import type { IdentityProgress } from './types'

// A plain preference, deliberately not under the reserved stats_ prefix: it
// is not consent for stats and the renderer may read and write it directly.
// OFF unless the user turns it on: it sends fingerprints to third parties.
export const IDENTITY_LOOKUP_KEY = 'identity_lookup_enabled'

const ACOUSTID_KEY = import.meta.env.MAIN_VITE_ACOUSTID_API_KEY
const MB_CONTACT = import.meta.env.MAIN_VITE_MB_CONTACT

const FIRST_RUN_DELAY_MS = 30_000
const INTERVAL_MS = 10 * 60 * 1000

export interface IdentityStatus {
  active: boolean
  phase: 'tags' | 'fingerprint' | 'lookup' | 'idle'
  progress: IdentityProgress
  // Whether the optional online lookup could run at all: an API key and a
  // MusicBrainz contact are both configured.
  lookupAvailable: boolean
  // Whether a fingerprinter was found on this machine.
  fingerprintAvailable: boolean
  // Which one, for Settings: bundled with the app, or found on PATH.
  fingerprintSource: FpcalcInfo['source']
  fingerprintVersion: string | null
}

export interface IdentityRuntimeDeps {
  send: (status: IdentityStatus) => void
  isImportRunning: () => boolean
}

const store = getIdentityStore()
let deps: IdentityRuntimeDeps | null = null
let running = false
let lastStatus: IdentityStatus | null = null
let timer: ReturnType<typeof setInterval> | null = null

// Release builds and CI deliberately ship without these credentials, so the
// toggle shows "Not available in this build." — keep it that way.
// TODO(deepcrated): DeepCrated uses AcoustID and MusicBrainz under their
// non-commercial terms because the desktop app is free. Revisit commercial
// terms (and a key per install vs. one shared key) before any paid feature
// depends on this lookup.
function lookupConfig(): LookupConfig | null {
  const config = {
    acoustidKey: ACOUSTID_KEY,
    contact: MB_CONTACT,
    appVersion: app.getVersion()
  }
  return isLookupConfigured(config) ? config : null
}

function fpcalc(): Promise<FpcalcInfo> {
  return getFpcalc({
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: join(__dirname, '..', '..')
  })
}

// One concise warning per session: a broken fpcalc fails every track the
// same way, and the engine already records each one as failed.
let warnedFingerprintFailure = false

function fingerprinter(info: FpcalcInfo): FingerprintFn | null {
  if (!info.path) return null
  const run = createFingerprinter(info.path)
  return async (filepath) => {
    try {
      return await run(filepath)
    } catch (err) {
      if (!warnedFingerprintFailure) {
        warnedFingerprintFailure = true
        const kind = err instanceof FpcalcError ? err.kind : 'unknown'
        console.warn(
          `[identity] fingerprinting failed (${kind}): ${(err as Error).message}. ` +
            'Further failures this session are not logged.'
        )
      }
      throw err
    }
  }
}

function fingerprintFields(
  info: FpcalcInfo
): Pick<IdentityStatus, 'fingerprintAvailable' | 'fingerprintSource' | 'fingerprintVersion'> {
  return {
    fingerprintAvailable: info.path !== null,
    fingerprintSource: info.source,
    fingerprintVersion: info.version
  }
}

function buildLookup(): Lookup | null {
  const config = lookupConfig()
  if (!config) return null
  return createLookup({
    fetch: (url, init) => net.fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config
  })
}

export async function getIdentityStatus(): Promise<IdentityStatus> {
  const info = await fpcalc()
  return {
    active: running,
    phase: lastStatus?.phase ?? 'idle',
    progress: store.progress(),
    lookupAvailable: lookupConfig() !== null,
    ...fingerprintFields(info)
  }
}

export function kickIdentity(): void {
  if (running || !deps) return
  running = true
  void fpcalc()
    .then(runBackfill)
    .catch((err) => {
      // Never leave the backfill marked running: the next kick would no-op.
      running = false
      console.warn('[identity] backfill could not start:', (err as Error).message)
    })
}

function runBackfill(info: FpcalcInfo): void {
  const fingerprint = fingerprinter(info)
  const engine = createEngine({
    store,
    now: () => Date.now(),
    readTags: readIdentityTags,
    fingerprint,
    lookup: buildLookup(),
    lookupEnabled: () => getSetting(IDENTITY_LOOKUP_KEY) === 'true',
    isOnline: () => net.isOnline(),
    shouldPause: () => deps?.isImportRunning() ?? false,
    onProgress: (p) => {
      lastStatus = {
        active: p.phase !== 'idle',
        phase: p.phase,
        progress: p.progress,
        lookupAvailable: lookupConfig() !== null,
        ...fingerprintFields(info)
      }
      deps?.send(lastStatus)
    }
  })
  void engine
    .run()
    .catch((err) => console.warn('[identity] backfill stopped:', (err as Error).message))
    .finally(async () => {
      running = false
      // Whatever the run ended on, the UI row must go away.
      const done: IdentityStatus = { ...(await getIdentityStatus()), active: false, phase: 'idle' }
      lastStatus = done
      deps?.send(done)
    })
}

export function startIdentityBackfill(d: IdentityRuntimeDeps): void {
  deps = d
  if (timer) return
  // Find fpcalc now, off the critical path, so the first status request
  // and the first run do not wait on it. One line per session says which.
  void fpcalc().then((info) =>
    console.log(
      info.path
        ? `[identity] fingerprinting with ${info.source} fpcalc ${info.version} (${info.path})`
        : '[identity] fingerprinting not available: no fpcalc bundled or on PATH'
    )
  )
  setTimeout(kickIdentity, FIRST_RUN_DELAY_MS).unref()
  timer = setInterval(kickIdentity, INTERVAL_MS)
  timer.unref()
}
