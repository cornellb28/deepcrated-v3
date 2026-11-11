import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'

// ── Tokens, constant-time compare, pairing codes ──────────────────────────
// Nothing here logs. Tokens and pairing codes must never reach a log line,
// an error message or a thrown Error.

// The device secret handed to a phone once, at pairing: 32 random bytes,
// base64url (the protocol's "at least 32 random bytes").
export function generateDeviceSecret(): string {
  return randomBytes(32).toString('base64url')
}

// What is stored instead of the secret.
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

// Constant time in the content of both strings. Hashing first gives two
// equal-length buffers, so neither the length nor the first differing byte
// leaks through timing (timingSafeEqual itself throws on unequal lengths).
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

// ── Pairing codes ─────────────────────────────────────────────────────────
// One code at a time: issuing a new one replaces the old. Single use,
// short-lived, and invalidated after a few wrong attempts, so guessing it in
// the window is hopeless (31^6 codes, 5 tries).

// No 0/O, 1/I/L: the code is read off a screen and may be typed.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const PAIRING_CODE_MAX_FAILURES = 5

function randomCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${raw.slice(0, 3)}-${raw.slice(3)}` // shown as K7Q-4MZ
}

// Case, spaces and the dash don't matter when typed.
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export type RedeemResult = 'ok' | 'invalid' | 'expired' | 'locked' | 'none'

export class PairingCodes {
  private current: {
    code: string
    normalized: string
    expiresAt: number
    failures: number
  } | null = null
  private readonly ttlMs: number
  private readonly maxFailures: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; maxFailures?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS
    this.maxFailures = options.maxFailures ?? PAIRING_CODE_MAX_FAILURES
    this.now = options.now ?? Date.now
  }

  issue(): { code: string; expiresAt: number } {
    const code = randomCode()
    const expiresAt = this.now() + this.ttlMs
    this.current = { code, normalized: normalizePairingCode(code), expiresAt, failures: 0 }
    return { code, expiresAt }
  }

  // The live code, or null once it is used, expired or locked.
  active(): { code: string; expiresAt: number } | null {
    if (!this.current || this.now() >= this.current.expiresAt) return null
    return { code: this.current.code, expiresAt: this.current.expiresAt }
  }

  cancel(): void {
    this.current = null
  }

  // 'ok' consumes the code. Every other answer maps to the same 403 on the
  // wire; the distinction is for tests and desktop-side UI only.
  redeem(candidate: string): RedeemResult {
    const current = this.current
    if (!current) return 'none'
    if (this.now() >= current.expiresAt) {
      this.current = null
      return 'expired'
    }
    if (constantTimeEqual(normalizePairingCode(candidate), current.normalized)) {
      this.current = null
      return 'ok'
    }
    current.failures += 1
    if (current.failures >= this.maxFailures) {
      this.current = null
      return 'locked'
    }
    return 'invalid'
  }
}
