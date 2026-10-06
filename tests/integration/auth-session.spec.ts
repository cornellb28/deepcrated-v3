import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Session persistence against the real safeStorage and the real OS keychain.
// The point of the feature is "quit and reopen without logging in again", and
// that claim rests entirely on an encrypted blob surviving a process exit —
// which a mocked keychain could not tell you.
//
// Each probe.run() is a fresh Electron process against the same userData
// directory, so a save in one run and a load in the next is exactly the
// quit-and-reopen case.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})

test.afterEach(() => {
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

async function runLast<T = unknown>(ops: ProbeOp[]): Promise<T> {
  const results = await run<T>(ops)
  return results[results.length - 1]
}

interface Stored {
  refresh_token: string
  email?: string
}

// safeStorage reports unavailable when there is no keyring to talk to —
// typical on a headless Linux CI box. There the persistence path is
// deliberately a no-op (we never fall back to plaintext), so these
// assertions would be testing the wrong thing.
async function persistenceAvailable(): Promise<boolean> {
  return runLast<boolean>([{ fn: 'isPersistenceAvailable' }])
}

test('a saved session survives a process exit', async () => {
  test.skip(!(await persistenceAvailable()), 'no OS keychain available')

  await run([
    { fn: 'saveSession', args: [{ refresh_token: 'refresh-abc', email: 'dj@example.com' }] }
  ])

  // Separate run == separate process, same userData dir.
  const loaded = await runLast<Stored | null>([{ fn: 'loadSession' }])
  expect(loaded?.refresh_token).toBe('refresh-abc')
  expect(loaded?.email).toBe('dj@example.com')
})

test('no stored session reads as null rather than throwing', async () => {
  expect(await runLast([{ fn: 'loadSession' }])).toBeNull()
})

test('signing out leaves nothing on disk to restore', async () => {
  test.skip(!(await persistenceAvailable()), 'no OS keychain available')

  const loaded = await runLast<Stored | null>([
    { fn: 'saveSession', args: [{ refresh_token: 'refresh-abc' }] },
    { fn: 'clearSession' },
    { fn: 'loadSession' }
  ])
  expect(loaded).toBeNull()
})

test('clearing a session that was never saved is harmless', async () => {
  const loaded = await runLast([{ fn: 'clearSession' }, { fn: 'loadSession' }])
  expect(loaded).toBeNull()
})

// The file outlives app upgrades, so a blob written by an older layout has
// to read as "no session" and send the DJ to the login screen — not crash
// the launch. Persisting a shape with no refresh_token stands in for that.
test('a stored blob with no refresh token reads as no session', async () => {
  test.skip(!(await persistenceAvailable()), 'no OS keychain available')

  const loaded = await runLast([
    { fn: 'saveSession', args: [{ email: 'dj@example.com' }] },
    { fn: 'loadSession' }
  ])
  expect(loaded).toBeNull()
})

test('an empty refresh token is rejected rather than used', async () => {
  test.skip(!(await persistenceAvailable()), 'no OS keychain available')

  const loaded = await runLast([
    { fn: 'saveSession', args: [{ refresh_token: '' }] },
    { fn: 'loadSession' }
  ])
  expect(loaded).toBeNull()
})

// Supabase rotates refresh tokens on every use, so the newest one has to
// overwrite the last — a save that appended or was ignored would leave the
// next launch presenting a token that has already been spent.
test('a rotated refresh token replaces the previous one', async () => {
  test.skip(!(await persistenceAvailable()), 'no OS keychain available')

  const loaded = await runLast<Stored | null>([
    { fn: 'saveSession', args: [{ refresh_token: 'first' }] },
    { fn: 'saveSession', args: [{ refresh_token: 'second' }] },
    { fn: 'loadSession' }
  ])
  expect(loaded?.refresh_token).toBe('second')
})
