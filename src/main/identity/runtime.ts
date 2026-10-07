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
import { createFingerprinter, findFpcalc, type FingerprintFn } from './fpcalc'
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

function lookupConfig(): LookupConfig | null {
  const config = {
    acoustidKey: ACOUSTID_KEY,
    contact: MB_CONTACT,
    appVersion: app.getVersion()
  }
  return isLookupConfigured(config) ? config : null
}

function fingerprinter(): FingerprintFn | null {
  const binary = findFpcalc({
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: join(__dirname, '..', '..')
  })
  return binary ? createFingerprinter(binary) : null
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

export function getIdentityStatus(): IdentityStatus {
  return {
    active: running,
    phase: lastStatus?.phase ?? 'idle',
    progress: store.progress(),
    lookupAvailable: lookupConfig() !== null,
    fingerprintAvailable: fingerprinter() !== null
  }
}

export function kickIdentity(): void {
  if (running || !deps) return
  running = true
  const fingerprint = fingerprinter()
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
        fingerprintAvailable: fingerprint !== null
      }
      deps?.send(lastStatus)
    }
  })
  void engine
    .run()
    .catch((err) => console.warn('[identity] backfill stopped:', (err as Error).message))
    .finally(() => {
      running = false
      // Whatever the run ended on, the UI row must go away.
      const done: IdentityStatus = { ...getIdentityStatus(), active: false, phase: 'idle' }
      lastStatus = done
      deps?.send(done)
    })
}

export function startIdentityBackfill(d: IdentityRuntimeDeps): void {
  deps = d
  if (timer) return
  setTimeout(kickIdentity, FIRST_RUN_DELAY_MS).unref()
  timer = setInterval(kickIdentity, INTERVAL_MS)
  timer.unref()
}
