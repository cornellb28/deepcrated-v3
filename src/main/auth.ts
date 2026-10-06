// ── Auth ─────────────────────────────────────────────────────────────────
// Email/password and Google OAuth against Supabase, plus the entitlement
// lookup the renderer reads.
//
// Google in Electron is deliberately NOT an embedded webview: Google blocks
// OAuth from embedded browser frames (disallowed_useragent), and a frame
// that could read the credentials would defeat the point anyway. So the flow
// is system browser -> Supabase -> cratecloud:// deep link back into the
// app. index.ts owns the protocol registration and hands the URL here.
//
// The pure URL parsing lives in authCallback.ts so it can be unit-tested;
// this module imports electron and cannot be.

import { shell } from 'electron'
import { getClient, isConfigured, MISSING_CONFIG_MESSAGE, type Session } from './supabase'
import { saveSession, loadSession, clearSession, isPersistenceAvailable } from './authStore'
import { CALLBACK_PROTOCOL, CALLBACK_URL, parseCallbackUrl } from './authCallback'
import { refreshDelayMs, NETWORK_RETRY_DELAY_MS } from './sessionRefresh'

export { CALLBACK_PROTOCOL, parseCallbackUrl }
export type { ParsedCallback } from './authCallback'

export interface AuthUser {
  id: string
  email: string | null
  // Both are for the Account page to show a profile rather than a bare
  // email address. 'email' when the DJ signed up with a password, 'google'
  // after the OAuth round trip.
  provider: string | null
  created_at: string | null
}

// Mirrors public.entitlements. The paid values are the cloud/mobile
// subscription sold from the payments website; the retired desktop tiers
// are deliberately absent.
export interface Entitlement {
  // PROVISIONAL names (2026-09-23) — the tier lineup is not finalised and
  // these will change. Nothing may branch on a specific paid value; "not
  // 'free'" is the only durable test, and the name is for display.
  plan: 'free' | 'cloud_mobile' | 'cloud_mobile_plus'
  // Every status Stripe can set, plus 'revoked' for a manual revocation.
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
  // Null on a free row. Read together with `status` to decide entitlement —
  // see the rule in the migration; a 'past_due' row inside its paid period
  // is still entitled.
  current_period_end: string | null
  cancel_at_period_end: boolean
  // Unused until a one-time desktop purchase exists.
  seats: number
}

// What the renderer sees. Never includes a token: the renderer has no use
// for one (main makes every authenticated call) and handing it across the
// bridge would put it somewhere a renderer-side script could read.
export interface AuthState {
  configured: boolean
  user: AuthUser | null
  entitlement: Entitlement | null
  // False when safeStorage is unavailable, so the login screen can warn
  // that this session will not survive a quit rather than silently failing.
  persistent: boolean
}

export type AuthResult = { ok: true; state: AuthState } | { ok: false; error: string }

// Signup has a third outcome that is neither success-with-session nor
// failure: the project has email confirmation on, so the account exists but
// cannot be used until the link is clicked. Modelling that as an error (as
// this did before) makes a success wear a failure's clothes and leaves the
// UI with nowhere to put a Resend button.
export type SignUpResult =
  | { ok: true; needsConfirmation: false; state: AuthState }
  | { ok: true; needsConfirmation: true; email: string }
  | { ok: false; error: string }

// The row every account is guaranteed to have by the DB trigger. Used only
// when the row genuinely cannot be read — offline, or a brand-new signup
// racing its own trigger — so the app never has to render a null plan.
const FALLBACK_ENTITLEMENT: Entitlement = {
  plan: 'free',
  status: 'active',
  current_period_end: null,
  cancel_at_period_end: false,
  seats: 1
}

let currentSession: Session | null = null
let currentEntitlement: Entitlement | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

// index.ts registers a listener that forwards to the renderer over
// 'auth:changed'. auth.ts has no window to push to and should not acquire
// one — a refresh can complete at any moment, including while no window
// exists, and this keeps that a wiring concern rather than an auth concern.
let onAuthStateChange: ((state: AuthState) => void) | null = null

export function setAuthStateListener(listener: (state: AuthState) => void): void {
  onAuthStateChange = listener
}

function userFrom(session: Session | null): AuthUser | null {
  if (!session?.user) return null
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    provider: session.user.app_metadata?.provider ?? null,
    created_at: session.user.created_at ?? null
  }
}

export function getAuthState(): AuthState {
  return {
    configured: isConfigured(),
    user: userFrom(currentSession),
    entitlement: currentEntitlement,
    persistent: isPersistenceAvailable()
  }
}

// ── Entitlement ──────────────────────────────────────────────────────────
// RLS restricts this to the caller's own row, so no user_id filter is
// needed for correctness. maybeSingle() because "no row" is a legitimate
// answer in the moments before the signup trigger has committed, and
// .single() would turn that into an error.
//
// TODO(stripe-webhook): plan, status, current_period_end,
// cancel_at_period_end and the stripe_* columns are written only by the
// payments website's Stripe webhook, running under the service role. Until
// that exists every account reads plan 'free', which is correct — the
// desktop app is free, and the paid tiers are the cloud/mobile subscription
// sold on the web.
export async function fetchEntitlement(): Promise<Entitlement> {
  if (!currentSession) return FALLBACK_ENTITLEMENT
  try {
    const { data, error } = await getClient()
      .from('entitlements')
      .select('plan, status, current_period_end, cancel_at_period_end, seats')
      .maybeSingle()

    if (error || !data) return FALLBACK_ENTITLEMENT
    return data as Entitlement
  } catch {
    // Offline is not a reason to lock a DJ out of a free, local app.
    return FALLBACK_ENTITLEMENT
  }
}

export async function refreshEntitlement(): Promise<Entitlement | null> {
  if (!currentSession) return null
  currentEntitlement = await fetchEntitlement()
  return currentEntitlement
}

// ── Keeping the session alive ────────────────────────────────────────────
// Cancels any pending refresh. Safe to call when none is scheduled, and
// called on sign-out and before every reschedule so two timers can never
// race each other into a double refresh (which would spend the rotated
// token twice and invalidate the session).
export function stopSessionRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleRefresh(session: Session): void {
  stopSessionRefresh()
  refreshTimer = setTimeout(() => void runScheduledRefresh(), refreshDelayMs(session.expires_at))
  // Do not let a pending refresh hold the event loop open at quit time.
  refreshTimer.unref?.()
}

async function runScheduledRefresh(): Promise<void> {
  const token = currentSession?.refresh_token
  if (!token) return

  try {
    const { data, error } = await getClient().auth.refreshSession({ refresh_token: token })

    if (error || !data.session) {
      // A returned error is a DEFINITE rejection — revoked, or the token
      // was already spent elsewhere. Nothing to retry: drop the session and
      // let the renderer show the login screen.
      console.log('[auth] scheduled refresh rejected, signing out locally')
      stopSessionRefresh()
      clearSession()
      currentSession = null
      currentEntitlement = null
      onAuthStateChange?.(getAuthState())
      return
    }

    // adoptSession persists the rotated token and schedules the next run.
    onAuthStateChange?.(await adoptSession(data.session))
  } catch (err) {
    // A THROWN error is the network, not the token. Keep the session and
    // try again shortly — a DJ whose wifi dropped mid-set should not be
    // logged out for it.
    console.error('[auth] scheduled refresh failed (will retry):', err)
    stopSessionRefresh()
    refreshTimer = setTimeout(() => void runScheduledRefresh(), NETWORK_RETRY_DELAY_MS)
    refreshTimer.unref?.()
  }
}

// Called after every successful authentication, from whichever path got
// there. Persisting, scheduling the refresh and fetching the entitlement in
// one place is what keeps the email/password, Google, launch-restore and
// scheduled-refresh paths from drifting apart.
async function adoptSession(session: Session): Promise<AuthState> {
  currentSession = session
  if (session.refresh_token) {
    saveSession({ refresh_token: session.refresh_token, email: session.user?.email ?? undefined })
  }
  scheduleRefresh(session)
  currentEntitlement = await fetchEntitlement()
  return getAuthState()
}

// ── Email + password ─────────────────────────────────────────────────────

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  try {
    const { data, error } = await getClient().auth.signUp({ email, password })
    if (error) return { ok: false, error: error.message }

    // No session means the project has email confirmation on: the account
    // exists but cannot be used until the link is clicked. A real outcome,
    // not an error — the UI shows a "check your inbox" state with a resend.
    if (!data.session) return { ok: true, needsConfirmation: true, email }

    return { ok: true, needsConfirmation: false, state: await adoptSession(data.session) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// Supabase rate-limits this server-side (default once per 60s), and the
// error says so plainly, so it is passed straight through rather than
// second-guessed with a client-side cooldown that could disagree.
export async function resendConfirmation(email: string): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  try {
    const { error } = await getClient().auth.resend({ type: 'signup', email })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  try {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password })
    if (error) return { ok: false, error: error.message }
    if (!data.session) return { ok: false, error: 'No session returned.' }
    return { ok: true, state: await adoptSession(data.session) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// redirectTo sends the email's link back into the app as a cratecloud://
// deep link carrying type=recovery, rather than to Supabase's hosted page.
// That deep link is what completeOAuthCallback routes to the set-a-new-
// password screen.
//
// Requires cratecloud://auth-callback in Supabase's Redirect URLs — the same
// entry Google sign-in already needs, so no extra dashboard config.
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  try {
    const { error } = await getClient().auth.resetPasswordForEmail(email, {
      redirectTo: CALLBACK_URL
    })
    if (error) return { ok: false, error: error.message }
    return { ok: true, state: getAuthState() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// Called from the set-a-new-password screen. The recovery link's session is
// already adopted by then (that is what authorises this call), so updateUser
// needs only the new password.
//
// Supabase rejects a password matching the current one, and rejects one
// shorter than the project minimum; both come back as plain messages the
// renderer maps to readable wording.
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  if (!currentSession) {
    return { ok: false, error: 'That reset link has expired. Request a new one.' }
  }
  try {
    const { data, error } = await getClient().auth.updateUser({ password: newPassword })
    if (error) return { ok: false, error: error.message }
    if (!data.user) return { ok: false, error: 'Password was not updated.' }
    return { ok: true, state: getAuthState() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Google OAuth ─────────────────────────────────────────────────────────
// skipBrowserRedirect because there is no browser here to redirect: we want
// the URL back so it can be handed to the system browser instead.
export async function startGoogleSignIn(): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }
  try {
    const { data, error } = await getClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: CALLBACK_URL, skipBrowserRedirect: true }
    })
    if (error) return { ok: false, error: error.message }
    if (!data?.url) return { ok: false, error: 'Supabase returned no OAuth URL.' }

    await shell.openExternal(data.url)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// Called by index.ts's open-url (macOS) and second-instance (Windows/Linux)
// handlers.
export type CallbackResult =
  { ok: true; state: AuthState; recovery: boolean } | { ok: false; error: string }

export async function completeOAuthCallback(rawUrl: string): Promise<CallbackResult> {
  if (!isConfigured()) return { ok: false, error: MISSING_CONFIG_MESSAGE }

  const parsed = parseCallbackUrl(rawUrl)
  if (parsed.kind === 'none') return { ok: false, error: 'Not an auth callback.' }
  if (parsed.kind === 'error') return { ok: false, error: parsed.error ?? 'Sign-in was cancelled.' }

  try {
    // A recovery link adopts its session exactly like a sign-in — that
    // session is what authorises updateUser — but the caller is told so it
    // can show the set-a-new-password screen instead of just dropping the
    // DJ into the app with the password they had forgotten.
    if (parsed.kind === 'tokens' || parsed.kind === 'recovery') {
      const { data, error } = await getClient().auth.setSession({
        access_token: parsed.accessToken as string,
        refresh_token: parsed.refreshToken as string
      })
      if (error) return { ok: false, error: error.message }
      if (!data.session) return { ok: false, error: 'Callback produced no session.' }
      return {
        ok: true,
        state: await adoptSession(data.session),
        recovery: parsed.kind === 'recovery'
      }
    }

    const { data, error } = await getClient().auth.exchangeCodeForSession(parsed.code as string)
    if (error) return { ok: false, error: error.message }
    if (!data.session) return { ok: false, error: 'Callback produced no session.' }
    return { ok: true, state: await adoptSession(data.session), recovery: false }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Launch + sign out ────────────────────────────────────────────────────
// Trades the stored refresh token for a fresh session. Supabase rotates
// refresh tokens, so the new one must be written back — otherwise the next
// launch would present a token that has already been spent.
export async function restoreSession(): Promise<AuthState> {
  if (!isConfigured()) return getAuthState()

  const stored = loadSession()
  if (!stored) return getAuthState()

  try {
    const { data, error } = await getClient().auth.refreshSession({
      refresh_token: stored.refresh_token
    })
    if (error || !data.session) {
      // Genuinely expired or revoked — the one case the brief calls out as
      // a legitimate re-login. Drop the token so it isn't retried on every
      // launch from here on.
      console.log('[auth] stored session could not be refreshed, clearing')
      clearSession()
      return getAuthState()
    }
    return await adoptSession(data.session)
  } catch (err) {
    // A thrown error here is a network failure, NOT a rejected token: keep
    // the stored token so launching without internet doesn't cost the DJ
    // their session.
    console.error('[auth] session restore failed (keeping stored token):', err)
    return getAuthState()
  }
}

export async function signOut(): Promise<AuthState> {
  try {
    if (isConfigured()) await getClient().auth.signOut()
  } catch (err) {
    // A failed server-side sign-out must not leave the app stuck logged in:
    // clearing local state below is what the DJ actually asked for.
    console.error('[auth] remote sign-out failed:', err)
  }
  stopSessionRefresh()
  clearSession()
  currentSession = null
  currentEntitlement = null
  return getAuthState()
}
