import type { PairedPhone } from './phones'

// ── What the renderer may see of local sync ───────────────────────────────
// The one place the Settings > Phone sync payload is built, field by field.
// Nothing here may carry a device secret, a token hash or the certificate's
// private key: each type below lists exactly what crosses IPC, and the
// builders copy named fields rather than spreading store rows, so a column
// added to paired_phones later cannot leak through. No Electron import, so
// tests can check the payload directly.

export type LocalSyncStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'running'; port: number; addresses: string[] }
  | { state: 'error'; code: string; message: string }

export interface PhoneSyncPhone {
  phoneId: string
  displayName: string
  pairedAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface PhoneSyncPairing {
  qrDataUrl: string
  // Bare hosts and the port, for typing on the phone.
  hosts: string[]
  port: number
  pairingCode: string
  // Revision 3 short form, the value the DJ compares on the phone.
  shortFingerprint: string
  expiresAt: number
}

// Why the last pairing code ended early, for the screen to say so.
export type PhoneSyncPairingEnd =
  { reason: 'paired'; displayName: string; at: number } | { reason: 'locked'; at: number }

export interface PhoneSyncState {
  enabled: boolean
  status: LocalSyncStatus
  desktopName: string
  defaultDesktopName: string
  pairing: PhoneSyncPairing | null
  lastPairingEnd: PhoneSyncPairingEnd | null
  phones: PhoneSyncPhone[]
}

export function toPhoneSyncPhone(phone: PairedPhone): PhoneSyncPhone {
  return {
    phoneId: phone.phoneId,
    displayName: phone.displayName,
    pairedAt: phone.createdAt,
    lastSeenAt: phone.lastSeenAt,
    revokedAt: phone.revokedAt
  }
}

export function toPhoneSyncStatus(status: LocalSyncStatus): LocalSyncStatus {
  switch (status.state) {
    case 'running':
      return { state: 'running', port: status.port, addresses: [...status.addresses] }
    case 'error':
      return { state: 'error', code: status.code, message: status.message }
    default:
      return { state: status.state }
  }
}

export function buildPhoneSyncState(input: {
  enabled: boolean
  status: LocalSyncStatus
  desktopName: string
  defaultDesktopName: string
  pairing: PhoneSyncPairing | null
  lastPairingEnd: PhoneSyncPairingEnd | null
  phones: PairedPhone[]
}): PhoneSyncState {
  const p = input.pairing
  return {
    enabled: input.enabled,
    status: toPhoneSyncStatus(input.status),
    desktopName: input.desktopName,
    defaultDesktopName: input.defaultDesktopName,
    pairing: p
      ? {
          qrDataUrl: p.qrDataUrl,
          hosts: [...p.hosts],
          port: p.port,
          pairingCode: p.pairingCode,
          shortFingerprint: p.shortFingerprint,
          expiresAt: p.expiresAt
        }
      : null,
    lastPairingEnd: input.lastPairingEnd ? { ...input.lastPairingEnd } : null,
    phones: input.phones.map(toPhoneSyncPhone)
  }
}

// ── Desktop name ──────────────────────────────────────────────────────────
// Shown on the phone and used as the mDNS instance name, whose labels are
// capped at 63 bytes. Control characters are dropped and runs of whitespace
// collapsed. Empty means "use the default" (the hostname).
export const DESKTOP_NAME_MAX = 63

export function normalizeDesktopName(input: string): string | null {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  let out = ''
  for (const ch of cleaned) {
    if (Buffer.byteLength(out + ch, 'utf8') > DESKTOP_NAME_MAX) break
    out += ch
  }
  return out.trim() || null
}

export function defaultDesktopName(host: string): string {
  return normalizeDesktopName(host.replace(/\.local$/i, '')) ?? 'DeepCrated desktop'
}
