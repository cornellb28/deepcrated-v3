import { app } from 'electron'
import { hostname } from 'os'
import { join } from 'path'
import { getDesktopId, getLocalSyncPhoneStore, getSetting, setSetting } from '../db'
import { loadOrCreateCertificate } from './cert'
import { createBonjourAdvertiser } from './discovery'
import { pairingQrDataUrl, shortFingerprint } from './protocol'
import {
  createLocalSyncServer,
  LocalSyncError,
  type LocalSyncServer,
  type PairingEvent,
  type Routes
} from './server'
import {
  buildPhoneSyncState,
  defaultDesktopName,
  normalizeDesktopName,
  type LocalSyncStatus,
  type PhoneSyncPairing,
  type PhoneSyncPairingEnd,
  type PhoneSyncState
} from './view'

// ── Local sync in the running app ─────────────────────────────────────────
// Off by default: the server starts only when the local_sync_enabled
// setting is on. Settings > Phone sync drives it over IPC (main/index.ts),
// and everything it shows comes from getPhoneSyncState, which view.ts builds
// field by field so no secret reaches the renderer. Patch and snapshot
// endpoints arrive later through registerLocalSyncRoutes.

export const LOCAL_SYNC_ENABLED_SETTING = 'local_sync_enabled'
export const DESKTOP_NAME_SETTING = 'local_sync_desktop_name'

// Entitlement hook. Account contract v4.3: local wifi sync is free, on every
// plan, signed in or not. Kept as a function so a future change has one
// place to land. TODO(entitlements): only if the contract changes.
export function canUseLocalSync(): boolean {
  return true
}

export type { LocalSyncStatus }

let server: LocalSyncServer | null = null
let status: LocalSyncStatus = { state: 'off' }
let routes: Routes = {}
let starting: Promise<LocalSyncStatus> | null = null
let fingerprint: string | null = null
// The live pairing session as shown on screen. Only valid while the
// server's code is still active (checked on every read).
let pairing: { qrDataUrl: string; code: string; expiresAt: number } | null = null
let lastPairingEnd: PhoneSyncPairingEnd | null = null
let listener: ((state: PhoneSyncState) => void) | null = null

// Same folder as the library and the encrypted session (db.ts explains the
// cratecloud name).
const secretsDir = (): string => join(app.getPath('userData'), 'cratecloud')

export function getDefaultDesktopName(): string {
  return defaultDesktopName(hostname())
}

export function getDesktopName(): string {
  return normalizeDesktopName(getSetting(DESKTOP_NAME_SETTING) ?? '') ?? getDefaultDesktopName()
}

// Pushes go through this, like auth's setAuthStateListener, so this module
// never holds a window.
export function setLocalSyncListener(next: ((state: PhoneSyncState) => void) | null): void {
  listener = next
}

function emit(): void {
  try {
    listener?.(getPhoneSyncState())
  } catch (err) {
    console.error(`[local-sync] state push failed: ${(err as Error).message}`)
  }
}

export function registerLocalSyncRoutes(next: Routes): void {
  routes = { ...routes, ...next }
}

export function isLocalSyncEnabled(): boolean {
  return getSetting(LOCAL_SYNC_ENABLED_SETTING) === '1'
}

export function getLocalSyncStatus(): LocalSyncStatus {
  return status
}

export async function setLocalSyncEnabled(enabled: boolean): Promise<LocalSyncStatus> {
  setSetting(LOCAL_SYNC_ENABLED_SETTING, enabled ? '1' : '0')
  if (!enabled) {
    await stopLocalSync()
    return status
  }
  return startLocalSyncIfEnabled()
}

export function startLocalSyncIfEnabled(): Promise<LocalSyncStatus> {
  if (!isLocalSyncEnabled() || !canUseLocalSync()) return Promise.resolve(status)
  if (server) return Promise.resolve(status)
  if (starting) return starting
  starting = start().finally(() => {
    starting = null
  })
  return starting
}

async function start(): Promise<LocalSyncStatus> {
  status = { state: 'starting' }
  emit()
  try {
    const tls = await loadOrCreateCertificate(secretsDir())
    const next = createLocalSyncServer({
      phones: getLocalSyncPhoneStore(),
      desktopId: getDesktopId(),
      desktopName: getDesktopName,
      tls,
      routes,
      advertiser: createBonjourAdvertiser(),
      onPairingEvent: handlePairingEvent
    })
    const info = await next.start()
    server = next
    fingerprint = tls.fingerprint
    status = { state: 'running', port: info.port, addresses: info.addresses }
    console.log(
      `[local-sync] listening on port ${info.port} (${info.addresses.length} address(es))`
    )
  } catch (err) {
    const code = err instanceof LocalSyncError ? err.code : 'start_failed'
    status = { state: 'error', code, message: (err as Error).message }
    console.error(`[local-sync] could not start: ${(err as Error).message}`)
  }
  emit()
  return status
}

export async function stopLocalSync(): Promise<void> {
  if (starting) await starting
  const current = server
  server = null
  pairing = null
  status = { state: 'off' }
  if (current) await current.stop()
  emit()
}

function handlePairingEvent(event: PairingEvent): void {
  pairing = null
  lastPairingEnd =
    event.type === 'paired'
      ? { reason: 'paired', displayName: event.displayName, at: Date.now() }
      : { reason: 'locked', at: Date.now() }
  emit()
}

// ── Pairing ───────────────────────────────────────────────────────────────

function livePairing(): PhoneSyncPairing | null {
  const info = server?.listenInfo()
  const payload = server?.pairingPayload()
  if (!server || !info || !payload || !pairing || !fingerprint) return null
  if (payload.pairingCode !== pairing.code) return null
  return {
    qrDataUrl: pairing.qrDataUrl,
    hosts: info.hosts,
    port: info.port,
    pairingCode: pairing.code,
    shortFingerprint: shortFingerprint(fingerprint),
    expiresAt: pairing.expiresAt
  }
}

// Issues a new code (replacing any live one) and renders its QR.
export async function startPairing(): Promise<PhoneSyncState> {
  if (!server) return getPhoneSyncState()
  const { code, expiresAt } = server.issuePairingCode()
  const payload = server.pairingPayload()
  if (payload) {
    pairing = { qrDataUrl: await pairingQrDataUrl(payload), code, expiresAt }
    lastPairingEnd = null
  }
  emit()
  return getPhoneSyncState()
}

export function cancelPairing(): PhoneSyncState {
  server?.cancelPairingCode()
  pairing = null
  emit()
  return getPhoneSyncState()
}

export function revokePhone(phoneId: string): boolean {
  const revoked = getLocalSyncPhoneStore().revoke(phoneId, Date.now())
  emit()
  return revoked
}

// Empty resets to the hostname. A live QR is redrawn with the same code so
// it carries the new name.
export async function setDesktopName(input: string): Promise<PhoneSyncState> {
  setSetting(DESKTOP_NAME_SETTING, normalizeDesktopName(input) ?? '')
  // TODO(sync-discovery): the mDNS instance name keeps the old name until
  // the server restarts; nothing on the phone browses mDNS yet.
  const payload = server?.pairingPayload()
  if (pairing && payload && payload.pairingCode === pairing.code) {
    pairing = { ...pairing, qrDataUrl: await pairingQrDataUrl(payload) }
  }
  emit()
  return getPhoneSyncState()
}

export function getPhoneSyncState(): PhoneSyncState {
  return buildPhoneSyncState({
    enabled: isLocalSyncEnabled(),
    status,
    desktopName: getDesktopName(),
    defaultDesktopName: getDefaultDesktopName(),
    pairing: livePairing(),
    lastPairingEnd,
    phones: getLocalSyncPhoneStore().list()
  })
}
