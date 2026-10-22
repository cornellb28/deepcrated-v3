import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Sign out from the account menu, against the real auth module, the real
// safeStorage and a Supabase that cannot be reached (see PROBE_ENV in
// helpers/probe.ts). That is the offline-launch case: a cached session that
// restores as signed in without a network, which sign-out must still clear.

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

const STORED = {
  refresh_token: 'refresh-abc',
  user_id: 'u1',
  email: 'dj@example.com',
  displayName: 'Nova Vega'
}

test('an offline launch with a cached session restores as signed in', async () => {
  const [available] = await run<boolean>([{ fn: 'isPersistenceAvailable' }])
  test.skip(!available, 'no OS keyring: sessions are not persisted here by design')

  await run([{ fn: 'saveSession', args: [STORED] }])
  const [state] = await run<AuthState>([{ fn: 'authRestore' }])
  expect(state.status).toBe('signedIn')
  expect(state.offline).toBe(true)
  expect(state.user?.email).toBe('dj@example.com')
  // Derived state only: no token in what the renderer receives.
  expect(JSON.stringify(state)).not.toContain('refresh-abc')
})

test('sign out clears the session and entitlement, and nothing restores after relaunch', async () => {
  const [available] = await run<boolean>([{ fn: 'isPersistenceAvailable' }])
  test.skip(!available, 'no OS keyring: sessions are not persisted here by design')

  await run([{ fn: 'saveSession', args: [STORED] }])
  const [, signedOut, stored] = await run<AuthState | null>([
    { fn: 'authRestore' },
    { fn: 'authSignOut' },
    { fn: 'loadSession' }
  ])
  expect(signedOut?.status).toBe('signedOut')
  expect(signedOut?.user).toBeNull()
  expect(signedOut?.entitlement).toBeNull()
  expect(signedOut?.offline).toBe(false)
  expect(stored).toBeNull()

  // A fresh process, as after quitting and reopening.
  const [relaunched] = await run<AuthState>([{ fn: 'authRestore' }])
  expect(relaunched.status).toBe('signedOut')
  expect(relaunched.user).toBeNull()
})
