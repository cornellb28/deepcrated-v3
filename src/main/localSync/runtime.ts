import { app } from 'electron'
import { hostname } from 'os'
import { join } from 'path'
import { getDesktopId, getLocalSyncPhoneStore, getSetting, setSetting } from '../db'
import { loadOrCreateCertificate } from './cert'
import { createBonjourAdvertiser } from './discovery'
import { pairingQrDataUrl } from './protocol'
import { createLocalSyncServer, LocalSyncError, type LocalSyncServer, type Routes } from './server'

// ── Local sync in the running app ─────────────────────────────────────────
// Off by default: the server starts only when the local_sync_enabled
// setting is on. Phase 3 passes its endpoints in via registerLocalSyncRoutes
// before start; Phase 4 (Settings) calls setLocalSyncEnabled, the pairing
// functions and getLocalSyncStatus. Nothing here is wired to IPC yet.

export const LOCAL_SYNC_ENABLED_SETTING = 'local_sync_enabled'

// Entitlement hook. Account contract v4.3: local wifi sync is free, on every
// plan, signed in or not. Kept as a function so a future change has one
// place to land. TODO(entitlements): only if the contract changes.
export function canUseLocalSync(): boolean {
  return true
}

export type LocalSyncStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'running'; port: number; addresses: string[] }
  | { state: 'error'; code: string; message: string }

let server: LocalSyncServer | null = null
let status: LocalSyncStatus = { state: 'off' }
let routes: Routes = {}
let starting: Promise<LocalSyncStatus> | null = null

// Same folder as the library and the encrypted session (db.ts explains the
// cratecloud name).
const secretsDir = (): string => join(app.getPath('userData'), 'cratecloud')

function desktopName(): string {
  return hostname().replace(/\.local$/i, '') || 'DeepCrated desktop'
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
  try {
    const tls = await loadOrCreateCertificate(secretsDir())
    const next = createLocalSyncServer({
      phones: getLocalSyncPhoneStore(),
      desktopId: getDesktopId(),
      desktopName: desktopName(),
      tls,
      routes,
      advertiser: createBonjourAdvertiser()
    })
    const info = await next.start()
    server = next
    status = { state: 'running', port: info.port, addresses: info.addresses }
    console.log(
      `[local-sync] listening on port ${info.port} (${info.addresses.length} address(es))`
    )
  } catch (err) {
    const code = err instanceof LocalSyncError ? err.code : 'start_failed'
    status = { state: 'error', code, message: (err as Error).message }
    console.error(`[local-sync] could not start: ${(err as Error).message}`)
  }
  return status
}

export async function stopLocalSync(): Promise<void> {
  if (starting) await starting
  const current = server
  server = null
  status = { state: 'off' }
  if (current) await current.stop()
}

// ── Pairing (for the Settings screen, Phase 4) ────────────────────────────

export async function startPairing(): Promise<{
  qrDataUrl: string
  pairingCode: string
  expiresAt: number
} | null> {
  if (!server) return null
  const { code, expiresAt } = server.issuePairingCode()
  const payload = server.pairingPayload()
  if (!payload) return null
  return { qrDataUrl: await pairingQrDataUrl(payload), pairingCode: code, expiresAt }
}

export function cancelPairing(): void {
  server?.cancelPairingCode()
}

export function listPairedPhones(): ReturnType<ReturnType<typeof getLocalSyncPhoneStore>['list']> {
  return getLocalSyncPhoneStore().list()
}

export function revokePhone(phoneId: string): boolean {
  return getLocalSyncPhoneStore().revoke(phoneId, Date.now())
}
