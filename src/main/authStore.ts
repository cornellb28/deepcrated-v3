// ── Session persistence ──────────────────────────────────────────────────
// Keeps the Supabase refresh token across launches so reopening the app does
// not mean logging in again. Encrypted with Electron's safeStorage, which
// hands the actual key to the OS keychain (Keychain on macOS, DPAPI on
// Windows, libsecret on Linux) — the file on disk is ciphertext.
//
// Only the refresh token is worth storing. Access tokens expire in an hour,
// so a stored one is almost always stale by the next launch; the refresh
// token is what actually buys "don't make me log in again". Storing less
// also means a decrypt failure costs the DJ one login, not their data.

import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

interface StoredSession {
  refresh_token: string
  // Informational only — shown in the UI before a refresh completes, never
  // trusted for authorization. The server decides who you are.
  email?: string
}

function sessionFile(): string {
  const dir = join(app.getPath('userData'), 'cratecloud')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'session.enc')
}

// safeStorage needs the app ready, and on Linux it can report unavailable
// when no keyring is running. Rather than fall back to plaintext — which
// would quietly downgrade every Linux user's security to "refresh token in
// a readable file" — persistence is skipped and the DJ logs in each launch.
export function isPersistenceAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function saveSession(session: StoredSession): void {
  if (!isPersistenceAvailable()) return
  try {
    const blob = safeStorage.encryptString(JSON.stringify(session))
    writeFileSync(sessionFile(), blob)
  } catch (err) {
    // A failure to persist must never break a login that already succeeded.
    console.error('[auth] could not persist session:', err)
  }
}

export function loadSession(): StoredSession | null {
  if (!isPersistenceAvailable()) return null
  const file = sessionFile()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    // Guard the shape: this file survives app upgrades, and a stored blob
    // from an older layout should read as "no session", not crash at launch.
    if (typeof parsed?.refresh_token !== 'string' || parsed.refresh_token === '') return null
    return parsed as StoredSession
  } catch (err) {
    // Wrong keychain, corrupt file, or a different machine. Not recoverable
    // and not worth surfacing — clear it and show the login screen.
    console.error('[auth] could not read stored session, clearing:', err)
    clearSession()
    return null
  }
}

export function clearSession(): void {
  try {
    const file = sessionFile()
    if (existsSync(file)) unlinkSync(file)
  } catch (err) {
    console.error('[auth] could not clear session:', err)
  }
}

export type { StoredSession }
