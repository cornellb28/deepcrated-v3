import { createHash, X509Certificate } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { generate } from 'selfsigned'

// ── The local sync server's TLS identity ──────────────────────────────────
// A self-signed certificate, generated once and kept in the user-data
// directory. Phones pin its fingerprint (carried in the pairing QR), so a
// new certificate means every phone must pair again: generation happens
// only when no certificate exists, never to "repair" one. A missing half or
// an unreadable file is an error for the DJ to see, not a reason to mint a
// new identity. regenerateCertificate is the deliberate path.

export const CERT_FILE = 'local-sync-cert.pem'
export const KEY_FILE = 'local-sync-key.pem'
export const CERT_VALIDITY_DAYS = 3650 // ~10 years

export interface TlsIdentity {
  cert: string
  key: string
  // SHA-256 of the DER certificate, 64 lower-case hex characters.
  fingerprint: string
  created: boolean
}

export class CertificateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertificateError'
  }
}

export function certFingerprint(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

export async function loadOrCreateCertificate(
  dir: string,
  options: { now?: Date } = {}
): Promise<TlsIdentity> {
  const certPath = join(dir, CERT_FILE)
  const keyPath = join(dir, KEY_FILE)
  const haveCert = existsSync(certPath)
  const haveKey = existsSync(keyPath)

  if (haveCert && haveKey) {
    const cert = readFileSync(certPath, 'utf8')
    const key = readFileSync(keyPath, 'utf8')
    let fingerprint: string
    try {
      fingerprint = certFingerprint(cert)
    } catch {
      throw new CertificateError(
        'The local sync certificate could not be read. Reset it to pair your phone again.'
      )
    }
    return { cert, key, fingerprint, created: false }
  }
  if (haveCert || haveKey) {
    throw new CertificateError(
      'Part of the local sync certificate is missing. Reset it to pair your phone again.'
    )
  }
  return writeNewCertificate(dir, options.now ?? new Date())
}

// Deliberate only (a future "Reset" in Settings). Every paired phone stops
// trusting the desktop until it pairs again.
export async function regenerateCertificate(
  dir: string,
  options: { now?: Date } = {}
): Promise<TlsIdentity> {
  return writeNewCertificate(dir, options.now ?? new Date())
}

async function writeNewCertificate(dir: string, now: Date): Promise<TlsIdentity> {
  mkdirSync(dir, { recursive: true })
  const notAfter = new Date(now.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
  const pems = await generate([{ name: 'commonName', value: 'DeepCrated local sync' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: notAfter
  })
  // The key is a secret: owner read/write only.
  writeFileSync(join(dir, KEY_FILE), pems.private, { mode: 0o600 })
  writeFileSync(join(dir, CERT_FILE), pems.cert, { mode: 0o644 })
  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint: certFingerprint(pems.cert),
    created: true
  }
}
