// ── Browser-first account auth ──────────────────────────────────────────
// Supabase sessions and entitlement reads stay in main. The renderer receives
// only derived profile/plan state; tokens never cross the preload boundary.

import { shell } from 'electron'
import { getClient, isConfigured, type Session } from './supabase'
import { saveSession, loadSession, clearSession, isPersistenceAvailable } from './authStore'
import {
  CALLBACK_PROTOCOL,
  CALLBACK_PROTOCOLS,
  parseCallbackUrl,
  beginFlow,
  clearFlow,
  getPendingFlow,
  runHandoff,
  validRedeemUrl
} from './authCallback'
import { refreshDelayMs, NETWORK_RETRY_DELAY_MS } from './sessionRefresh'

export { CALLBACK_PROTOCOL, CALLBACK_PROTOCOLS, parseCallbackUrl }
export type { ParsedCallback } from './authCallback'

export interface AuthUser {
  id: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  provider: string | null
  created_at: string | null
}

export type AuthStatus = 'signedOut' | 'awaitingBrowser' | 'signedIn' | 'expired'
export type AuthDestination = 'signIn' | 'createAccount' | 'passwordReset' | 'account' | 'portal'

export interface Entitlement {
  plan: 'free' | 'sync' | 'library' | 'touring'
  status:
    | 'active'
    | 'trialing'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'incomplete'
    | 'incomplete_expired'
    | 'paused'
    | 'revoked'
  current_period_end: string | null
  cancel_at_period_end: boolean
  seats: number
}

export interface AuthState {
  configured: boolean
  status: AuthStatus
  user: AuthUser | null
  entitlement: Entitlement | null
  persistent: boolean
  offline: boolean
  confirmingPurchase: boolean
  links: Record<AuthDestination, boolean>
}

// Plain http is only honoured for a localhost mock server in development.
const REDEEM_URL = validRedeemUrl(import.meta.env.MAIN_VITE_DESKTOP_REDEEM_URL, import.meta.env.DEV)

const AUTH_URLS: Record<AuthDestination, string | undefined> = {
  signIn: import.meta.env.MAIN_VITE_AUTH_URL,
  createAccount: import.meta.env.MAIN_VITE_AUTH_URL,
  passwordReset: import.meta.env.MAIN_VITE_AUTH_PASSWORD_RESET_URL,
  account: import.meta.env.MAIN_VITE_ACCOUNT_MANAGEMENT_URL,
  portal: import.meta.env.MAIN_VITE_CUSTOMER_PORTAL_URL
}

// TODO(auth-handoff): Verify the full round trip against the real website
// endpoints (create + redeem) on a PACKAGED build, for email and Google.
// The scheme is deepcrated://; cratecloud:// is still accepted until the website
// and Supabase allowlist are switched — see TODO(deepcrated) in authCallback.ts.

let currentSession: Session | null = null
let currentEntitlement: Entitlement | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let offline = false
let expired = false
let confirmingPurchase = false
let cachedUser: AuthUser | null = null
let refreshInFlight: Promise<AuthState> | null = null
let restoreInFlight: Promise<AuthState> | null = null
let onAuthStateChange: ((state: AuthState) => void) | null = null

export function setAuthStateListener(listener: (state: AuthState) => void): void {
  onAuthStateChange = listener
}

function safeHttpsUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function isHandoffDestination(destination: AuthDestination): boolean {
  return destination === 'signIn' || destination === 'createAccount'
}

function userFrom(session: Session | null): AuthUser | null {
  if (!session?.user) return null
  const metadata = session.user.user_metadata ?? {}
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    displayName:
      (typeof metadata.full_name === 'string' && metadata.full_name) ||
      (typeof metadata.name === 'string' && metadata.name) ||
      null,
    avatarUrl:
      typeof metadata.avatar_url === 'string'
        ? metadata.avatar_url
        : typeof metadata.picture === 'string'
          ? metadata.picture
          : null,
    provider: session.user.app_metadata?.provider ?? null,
    created_at: session.user.created_at ?? null
  }
}

function cachedUserFromStoredSession(): AuthUser | null {
  const stored = loadSession()
  if (!stored) return null
  return {
    id: stored.user_id ?? 'offline-session',
    email: stored.email ?? null,
    displayName: stored.displayName ?? null,
    avatarUrl: stored.avatarUrl ?? null,
    provider: stored.provider ?? null,
    created_at: stored.created_at ?? null
  }
}

export function getAuthState(): AuthState {
  const user = userFrom(currentSession) ?? (offline || expired ? cachedUser : null)
  return {
    configured: isConfigured(),
    status: getPendingFlow()
      ? 'awaitingBrowser'
      : currentSession || (offline && user)
        ? 'signedIn'
        : expired
          ? 'expired'
          : 'signedOut',
    user,
    entitlement: currentEntitlement,
    persistent: isPersistenceAvailable(),
    offline,
    confirmingPurchase,
    links: Object.fromEntries(
      (Object.keys(AUTH_URLS) as AuthDestination[]).map((key) => [
        key,
        safeHttpsUrl(AUTH_URLS[key]) !== null &&
          // Browser sign-in is useless without somewhere to redeem the key.
          (!isHandoffDestination(key) || REDEEM_URL !== null)
      ])
    ) as Record<AuthDestination, boolean>
  }
}

function isRetryable(error: { name?: string; message?: string; status?: number }): boolean {
  const name = error.name?.toLowerCase() ?? ''
  const message = error.message?.toLowerCase() ?? ''
  return (
    name.includes('retryable') ||
    /fetch|network|timeout|connection|offline/.test(message) ||
    (error.status !== undefined && error.status >= 500)
  )
}

// RLS limits this query to the current user's own entitlement row. This app
// never writes entitlement state and deliberately does not persist a cache.
export async function fetchEntitlement(): Promise<Entitlement | null> {
  if (!currentSession) return null
  try {
    const { data, error } = await getClient()
      .from('entitlements')
      .select('plan, status, current_period_end, cancel_at_period_end, seats')
      .maybeSingle()
    if (error) {
      if (isRetryable(error)) offline = true
      return null
    }
    return (data as Entitlement | null) ?? null
  } catch {
    offline = true
    return null
  }
}

export function stopSessionRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleRefresh(session: Session): void {
  stopSessionRefresh()
  refreshTimer = setTimeout(() => void runScheduledRefresh(), refreshDelayMs(session.expires_at))
  refreshTimer.unref?.()
}

async function adoptSession(session: Session): Promise<AuthState> {
  currentSession = session
  cachedUser = userFrom(session)
  offline = false
  expired = false
  if (session.refresh_token) {
    saveSession({
      refresh_token: session.refresh_token,
      user_id: cachedUser?.id,
      email: cachedUser?.email ?? undefined,
      displayName: cachedUser?.displayName ?? undefined,
      avatarUrl: cachedUser?.avatarUrl ?? undefined,
      provider: cachedUser?.provider ?? undefined,
      created_at: cachedUser?.created_at ?? undefined
    })
  }
  scheduleRefresh(session)
  currentEntitlement = await fetchEntitlement()
  return getAuthState()
}

async function runScheduledRefresh(): Promise<void> {
  const token = currentSession?.refresh_token
  if (!token) return
  try {
    const { data, error } = await getClient().auth.refreshSession({ refresh_token: token })
    if (error || !data.session) {
      if (error && isRetryable(error)) throw error
      cachedUser = userFrom(currentSession) ?? cachedUser
      clearSession()
      currentSession = null
      currentEntitlement = null
      expired = true
      offline = false
      stopSessionRefresh()
      onAuthStateChange?.(getAuthState())
      return
    }
    onAuthStateChange?.(await adoptSession(data.session))
  } catch (error) {
    offline = true
    onAuthStateChange?.(getAuthState())
    console.error('[auth] scheduled refresh failed; preserving session:', error)
    stopSessionRefresh()
    refreshTimer = setTimeout(() => void runScheduledRefresh(), NETWORK_RETRY_DELAY_MS)
    refreshTimer.unref?.()
  }
}

export async function openAuthDestination(
  destination: AuthDestination
): Promise<{ ok: boolean; error?: string }> {
  const url = safeHttpsUrl(AUTH_URLS[destination])
  if (!url) return { ok: false, error: `The ${destination} website page is not configured yet.` }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

async function beginBrowserAuth(
  destination: 'signIn' | 'createAccount'
): Promise<{ ok: boolean; state: AuthState; error?: string }> {
  const baseUrl = safeHttpsUrl(AUTH_URLS[destination])
  if (!baseUrl || !REDEEM_URL) {
    return {
      ok: false,
      state: getAuthState(),
      error: `The ${destination} website page is not configured yet.`
    }
  }
  const flow = beginFlow(baseUrl, destination === 'createAccount' ? 'signup' : 'signin')
  expired = false
  onAuthStateChange?.(getAuthState())
  try {
    await shell.openExternal(flow.url)
    return { ok: true, state: getAuthState() }
  } catch (error) {
    clearFlow()
    onAuthStateChange?.(getAuthState())
    return { ok: false, state: getAuthState(), error: (error as Error).message }
  }
}

export function signInInBrowser(): Promise<{ ok: boolean; state: AuthState; error?: string }> {
  return beginBrowserAuth('signIn')
}

export function createAccountInBrowser(): Promise<{
  ok: boolean
  state: AuthState
  error?: string
}> {
  return beginBrowserAuth('createAccount')
}

export async function reopenAuthBrowser(): Promise<{ ok: boolean; error?: string }> {
  const flow = getPendingFlow()
  if (!flow) return { ok: false, error: 'There is no browser sign-in to reopen.' }
  try {
    await shell.openExternal(flow.url)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function cancelBrowserAuth(): AuthState {
  clearFlow()
  onAuthStateChange?.(getAuthState())
  return getAuthState()
}

// `ignored` means the link was not a valid answer to a pending sign-in: the
// app state is untouched and the user is told nothing, so a stray or forged
// link cannot be used to probe or disrupt anything.
export type CallbackResult =
  | { ok: true; state: AuthState }
  | { ok: false; ignored: true }
  | { ok: false; ignored: false; error: string }

export const HANDOFF_FAILURE_MESSAGE = 'Sign-in link expired or invalid. Please try again.'

export async function completeHandoffCallback(rawUrl: string): Promise<CallbackResult> {
  // Not-ours links and links with no matching pending flow short-circuit
  // inside runHandoff before anything is redeemed.
  if (!REDEEM_URL || !isConfigured()) return { ok: false, ignored: true }

  confirmingPurchase = true
  onAuthStateChange?.(getAuthState())
  try {
    const outcome = await runHandoff(rawUrl, {
      redeemUrl: REDEEM_URL,
      setSession: async (tokens) => {
        const { data, error } = await getClient().auth.setSession(tokens)
        return error || !data.session ? null : data.session
      },
      adopt: async (session) => {
        await adoptSession(session as Session)
      }
    })
    if (outcome === 'invalid') {
      // No values: the link may carry a key, token or code.
      console.warn('[auth] ignored a malformed sign-in link')
    }
    if (outcome === 'ok') return { ok: true, state: getAuthState() }
    if (outcome === 'failed') return { ok: false, ignored: false, error: HANDOFF_FAILURE_MESSAGE }
    return { ok: false, ignored: true }
  } finally {
    confirmingPurchase = false
    onAuthStateChange?.(getAuthState())
  }
}

async function restoreWithToken(refreshToken: string): Promise<AuthState> {
  try {
    const { data, error } = await getClient().auth.refreshSession({ refresh_token: refreshToken })
    if (error || !data.session) {
      if (error && isRetryable(error)) throw error
      clearSession()
      currentSession = null
      currentEntitlement = null
      expired = true
      offline = false
      return getAuthState()
    }
    return adoptSession(data.session)
  } catch (error) {
    offline = true
    console.error('[auth] session restore failed; keeping encrypted session:', error)
    return getAuthState()
  }
}

export function restoreSession(): Promise<AuthState> {
  if (refreshInFlight) return refreshInFlight
  if (restoreInFlight) return restoreInFlight
  restoreInFlight = (async (): Promise<AuthState> => {
    if (!isConfigured()) return getAuthState()
    const stored = loadSession()
    if (!stored) return getAuthState()
    cachedUser = cachedUserFromStoredSession()
    return restoreWithToken(stored.refresh_token)
  })().finally(() => {
    restoreInFlight = null
  })
  return restoreInFlight
}

export async function signOut(): Promise<AuthState> {
  try {
    if (isConfigured()) await getClient().auth.signOut()
  } catch (error) {
    console.error('[auth] remote sign-out failed; clearing local session:', error)
  }
  stopSessionRefresh()
  clearSession()
  currentSession = null
  currentEntitlement = null
  cachedUser = null
  offline = false
  expired = false
  clearFlow()
  return getAuthState()
}

// Reuse one in-flight refresh across focus events and the Settings button so
// Supabase's rotating refresh token is never submitted concurrently.
export function refreshAccountState(): Promise<AuthState> {
  if (restoreInFlight) return restoreInFlight
  if (refreshInFlight) return refreshInFlight
  if (!currentSession?.refresh_token) return restoreSession()
  refreshInFlight = (async (): Promise<AuthState> => {
    const currentToken = currentSession!.refresh_token
    try {
      const { data, error } = await getClient().auth.refreshSession({ refresh_token: currentToken })
      if (error || !data.session) {
        if (error && isRetryable(error)) throw error
        cachedUser = userFrom(currentSession) ?? cachedUser
        clearSession()
        currentSession = null
        currentEntitlement = null
        expired = true
        offline = false
        stopSessionRefresh()
        const state = getAuthState()
        onAuthStateChange?.(state)
        return state
      }
      const state = await adoptSession(data.session)
      onAuthStateChange?.(state)
      return state
    } catch (error) {
      offline = true
      const state = getAuthState()
      onAuthStateChange?.(state)
      console.error('[auth] focus refresh failed; preserving session:', error)
      return state
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}
