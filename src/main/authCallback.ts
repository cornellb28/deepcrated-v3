// ── Sign-in handoff: callback parsing, pending flow, redeem ──────────────
// Pure, and in its own module so it is reachable from a unit test: auth.ts
// imports electron (shell) and authStore (app, safeStorage), so anything
// that pulls it in only runs inside Electron. Same split as rescan.ts /
// rescanSweep.ts, and for the same reason.
//
// The round trip (see deepcrate-account-contract): the app opens the website
// with a challenge + state, the website hands back a ONE-TIME KEY on the
// cratecloud:// deep link, and the app trades { key, verifier } for a session
// over HTTPS. The link never carries a token, and the verifier never leaves
// this process, so an intercepted link is useless on its own.
//
// Nothing in here logs. Keys, verifiers, states and tokens must never reach
// a log line, so the only diagnostics are generic ones emitted by the caller.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const CALLBACK_PROTOCOL = 'cratecloud'
export const CALLBACK_URL = `${CALLBACK_PROTOCOL}://auth-callback`

// A flow older than this is dead. The website's key lives 60 seconds, but a
// DJ may take a while to log in or fetch a 2FA code before confirming.
export const PENDING_FLOW_TTL_MS = 10 * 60 * 1000
export const REDEEM_TIMEOUT_MS = 10_000

const MAX_PARAM_LENGTH = 512

export type ParsedCallback =
  | { kind: 'handoff'; key: string; state: string }
  // Ours (right scheme + authority) but malformed or carrying anything other
  // than key and state. Distinct from 'none' only so the caller can warn.
  | { kind: 'invalid' }
  // Not an auth callback at all (foreign scheme, other authority, argv noise).
  | { kind: 'none' }

// Accepts exactly cratecloud://auth-callback?key=...&state=... and nothing
// else. Fragments and every other parameter (token, code, error, ...) are
// rejected outright rather than ignored, so a link built the old way can
// never be half-honoured.
export function parseCallbackUrl(rawUrl: string): ParsedCallback {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'none' }
  }

  // Anything not on our scheme is not ours to interpret. Worth being strict:
  // on Windows every argv entry reaches this, not just deep links.
  if (url.protocol !== `${CALLBACK_PROTOCOL}:`) return { kind: 'none' }
  if (
    url.hostname !== 'auth-callback' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    return { kind: 'none' }
  }

  if (url.hash !== '') return { kind: 'invalid' }

  const names = [...url.searchParams.keys()]
  if (names.length !== 2 || !names.includes('key') || !names.includes('state')) {
    return { kind: 'invalid' }
  }
  const key = url.searchParams.getAll('key')
  const state = url.searchParams.getAll('state')
  if (key.length !== 1 || state.length !== 1) return { kind: 'invalid' }
  if (!key[0] || !state[0]) return { kind: 'invalid' }
  if (key[0].length > MAX_PARAM_LENGTH || state[0].length > MAX_PARAM_LENGTH) {
    return { kind: 'invalid' }
  }
  return { kind: 'handoff', key: key[0], state: state[0] }
}

// ── PKCE-style material ──────────────────────────────────────────────────

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ── Pending flow (main-process memory only) ──────────────────────────────

export interface PendingFlow {
  verifier: string
  state: string
  // The exact URL opened in the browser, kept so "reopen browser" does not
  // mint a second challenge/state. It carries the challenge and state, which
  // are meant to be in a URL; the verifier is not part of it.
  url: string
  createdAt: number
}

let pending: PendingFlow | null = null

export function beginFlow(
  baseUrl: string,
  mode: 'signin' | 'signup',
  now: number = Date.now()
): PendingFlow {
  const verifier = randomToken()
  const state = randomToken()
  const url = new URL(baseUrl)
  url.searchParams.set('challenge', deriveChallenge(verifier))
  url.searchParams.set('state', state)
  if (mode === 'signup') url.searchParams.set('mode', 'signup')
  pending = { verifier, state, url: url.toString(), createdAt: now }
  return pending
}

export function clearFlow(): void {
  pending = null
}

// Expiry is enforced on read, so a stale flow also stops showing as
// "awaiting browser" without needing a timer.
export function getPendingFlow(now: number = Date.now()): PendingFlow | null {
  if (pending && now - pending.createdAt > PENDING_FLOW_TTL_MS) pending = null
  return pending
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// Validates a parsed link against the pending flow and, if it is good,
// CONSUMES the flow: a second delivery of the same link finds nothing and is
// ignored. The caller gets the verifier back exactly once.
export function consumeFlow(
  key: string,
  state: string,
  now: number = Date.now()
): { key: string; verifier: string } | null {
  const flow = getPendingFlow(now)
  if (!flow) return null
  if (!constantTimeEqual(flow.state, state)) return null
  pending = null
  return { key, verifier: flow.verifier }
}

// ── Redeem ───────────────────────────────────────────────────────────────

export interface RedeemedTokens {
  access_token: string
  refresh_token: string
}

// HTTPS only. Plain http is tolerated for a localhost mock server in
// development, and only there.
export function validRedeemUrl(rawUrl: string | undefined, allowLocalHttp: boolean): string | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'https:') return parsed.toString()
    if (
      allowLocalHttp &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return parsed.toString()
    }
    return null
  } catch {
    return null
  }
}

// Returns tokens, or null on ANY failure. The reason is deliberately not
// surfaced: the user is told only that the link expired or was invalid.
export async function redeemKey(
  redeemUrl: string,
  key: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REDEEM_TIMEOUT_MS
): Promise<RedeemedTokens | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(redeemUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, verifier }),
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<RedeemedTokens> | null
    if (
      !body ||
      typeof body.access_token !== 'string' ||
      typeof body.refresh_token !== 'string' ||
      !body.access_token ||
      !body.refresh_token
    ) {
      return null
    }
    return { access_token: body.access_token, refresh_token: body.refresh_token }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Orchestration ────────────────────────────────────────────────────────

export interface HandoffDeps {
  redeemUrl: string
  // Both are supplied by auth.ts. Kept as injected callbacks so this module
  // stays free of electron and supabase-js, and so tests can fake them.
  setSession: (tokens: RedeemedTokens) => Promise<unknown | null>
  adopt: (session: unknown) => Promise<void>
  fetchImpl?: typeof fetch
  now?: number
}

// 'ignored': not a valid answer to a pending sign-in; nothing changed.
// 'failed': a flow was consumed but the redeem or session step failed.
export type HandoffOutcome = 'ignored' | 'ok' | 'failed' | 'invalid'

export async function runHandoff(rawUrl: string, deps: HandoffDeps): Promise<HandoffOutcome> {
  const parsed = parseCallbackUrl(rawUrl)
  if (parsed.kind === 'none') return 'ignored'
  if (parsed.kind === 'invalid') return 'invalid'

  const redemption = consumeFlow(parsed.key, parsed.state, deps.now)
  if (!redemption) return 'ignored'

  const tokens = await redeemKey(
    deps.redeemUrl,
    redemption.key,
    redemption.verifier,
    deps.fetchImpl
  )
  if (!tokens) return 'failed'
  try {
    const session = await deps.setSession(tokens)
    if (!session) return 'failed'
    await deps.adopt(session)
    return 'ok'
  } catch {
    return 'failed'
  }
}
