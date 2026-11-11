// The tests' tsconfig does not include src/main, so the ambient types for
// `qrcode` are pulled in here rather than picked up by an include glob.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./qrcode.d.ts" />
import { toDataURL } from 'qrcode'
import { isUuidV4 } from './schema'

// ── Local sync wire constants and the pairing payload ─────────────────────
// docs/local-sync-protocol.md is the source of truth; change it first.

export const PROTOCOL_VERSION = 1
export const PROTOCOL_PREFIX = `/v${PROTOCOL_VERSION}/`

// Preferred port (the protocol doc's example). If it is taken the server
// tries the next few and reports the one it got; the QR carries the real one.
export const PREFERRED_PORT = 47823

// mDNS: _deepcrated._tcp, TXT { v, id }. See the doc's Discovery section.
export const MDNS_SERVICE_TYPE = 'deepcrated'

export const DEVICE_HEADER = 'x-deepcrated-device'

// Error codes in { "error": "<code>" } bodies.
export type ProtocolError =
  | 'bad_request'
  | 'unpaired'
  | 'pairing_code_invalid'
  | 'not_found'
  | 'method_not_allowed'
  | 'unsupported_version'
  | 'patch_id_reused'
  | 'internal'

// What the QR code (and the manual-entry text) carries.
export interface PairingPayload {
  v: number
  desktopId: string
  desktopName: string
  addresses: string[]
  pairingCode: string
  certFingerprint: string
}

// SHA-256 of the DER certificate: 64 lower-case hex characters, no colons.
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/

export function buildPairingPayload(input: {
  desktopId: string
  desktopName: string
  addresses: string[]
  pairingCode: string
  certFingerprint: string
}): PairingPayload {
  // Key order is fixed so the QR text is stable for the same inputs.
  return {
    v: PROTOCOL_VERSION,
    desktopId: input.desktopId,
    desktopName: input.desktopName,
    addresses: [...input.addresses],
    pairingCode: input.pairingCode,
    certFingerprint: input.certFingerprint
  }
}

export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload)
}

// What the phone does with a scanned QR. Lives here so the shape is checked
// in one place and the tests can prove a round trip.
export function parsePairingPayload(text: string): PairingPayload | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  if (p.v !== PROTOCOL_VERSION) return null
  if (!isUuidV4(p.desktopId)) return null
  if (typeof p.desktopName !== 'string') return null
  if (!Array.isArray(p.addresses) || !p.addresses.every((a) => typeof a === 'string')) return null
  if (typeof p.pairingCode !== 'string' || p.pairingCode.length === 0) return null
  if (typeof p.certFingerprint !== 'string' || !FINGERPRINT_RE.test(p.certFingerprint)) return null
  return buildPairingPayload({
    desktopId: p.desktopId,
    desktopName: p.desktopName,
    addresses: p.addresses as string[],
    pairingCode: p.pairingCode,
    certFingerprint: p.certFingerprint
  })
}

// A PNG data URL for the pairing screen (Phase 4). Medium error correction
// is plenty for a screen-to-camera scan and keeps the code small.
export function pairingQrDataUrl(payload: PairingPayload): Promise<string> {
  return toDataURL(encodePairingPayload(payload), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320
  })
}

// host:port, IPv6 in brackets, as the doc's addresses field requires.
export function formatAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}
