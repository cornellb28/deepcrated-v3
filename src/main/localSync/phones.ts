import type Database from 'better-sqlite3'
import { constantTimeEqual, hashSecret } from './security'

// ── Paired phones (paired_phones) ─────────────────────────────────────────
// Bare connection, like schema.ts. db.ts hands out a store bound to the
// library (getLocalSyncPhoneStore).

export interface PairedPhone {
  phoneId: string
  displayName: string
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface PhoneStore {
  // Pairing the same phone again replaces its secret, takes its new name and
  // un-revokes it. Only the hash of the secret is stored.
  savePairing(phoneId: string, displayName: string, deviceSecret: string, now: number): void
  // The phone if the secret matches and it is not revoked; null otherwise.
  // Updates last_seen_at on success.
  authenticate(phoneId: string, deviceSecret: string, now: number): PairedPhone | null
  revoke(phoneId: string, now: number): boolean
  list(): PairedPhone[]
}

interface Row {
  phone_id: string
  display_name: string
  token_hash: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

const toPhone = (r: Row): PairedPhone => ({
  phoneId: r.phone_id,
  displayName: r.display_name,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at
})

export function createPhoneStore(db: Database.Database): PhoneStore {
  const upsert = db.prepare(`
    INSERT INTO paired_phones (phone_id, display_name, token_hash, created_at, last_seen_at, revoked_at)
    VALUES (@phoneId, @displayName, @tokenHash, @now, @now, NULL)
    ON CONFLICT (phone_id) DO UPDATE SET
      display_name = excluded.display_name,
      token_hash   = excluded.token_hash,
      last_seen_at = excluded.last_seen_at,
      revoked_at   = NULL
  `)
  const byId = db.prepare('SELECT * FROM paired_phones WHERE phone_id = ?')
  const touch = db.prepare('UPDATE paired_phones SET last_seen_at = ? WHERE phone_id = ?')
  const revoke = db.prepare(
    'UPDATE paired_phones SET revoked_at = ? WHERE phone_id = ? AND revoked_at IS NULL'
  )
  const all = db.prepare('SELECT * FROM paired_phones ORDER BY created_at')

  return {
    savePairing(phoneId, displayName, deviceSecret, now) {
      upsert.run({ phoneId, displayName, tokenHash: hashSecret(deviceSecret), now })
    },
    authenticate(phoneId, deviceSecret, now) {
      const row = byId.get(phoneId) as Row | undefined
      // Hash and compare even when there is no row, so an unknown device and
      // a wrong secret take the same path.
      const matches = constantTimeEqual(hashSecret(deviceSecret), row?.token_hash ?? '')
      if (!row || !matches || row.revoked_at !== null) return null
      touch.run(now, phoneId)
      return toPhone({ ...row, last_seen_at: now })
    },
    revoke(phoneId, now) {
      return revoke.run(now, phoneId).changes > 0
    },
    list() {
      return (all.all() as Row[]).map(toPhone)
    }
  }
}
