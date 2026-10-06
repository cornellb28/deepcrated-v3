import { test, expect } from '@playwright/test'
import { parseCallbackUrl, CALLBACK_PROTOCOL } from '../../src/main/authCallback'

// The one part of the Google OAuth round trip that can be tested without a
// browser, a Google account or a live Supabase project: what comes back on
// the cratecloud:// deep link, and how it is read.
//
// Worth pinning tightly. On Windows every argv entry of a second instance
// reaches this function, not just deep links, and a fragment misread as a
// query silently produces "no session" on a sign-in that actually worked.

test('implicit-flow tokens are read from the URL fragment', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback#access_token=abc&refresh_token=def&token_type=bearer`
  )
  expect(parsed.kind).toBe('tokens')
  expect(parsed.accessToken).toBe('abc')
  expect(parsed.refreshToken).toBe('def')
})

test('a PKCE code is read from the query string', () => {
  const parsed = parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback?code=xyz123`)
  expect(parsed.kind).toBe('code')
  expect(parsed.code).toBe('xyz123')
})

// Supabase's own docs show both placements depending on project config, so
// neither is assumed.
test('tokens are still found when they arrive in the query instead', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback?access_token=abc&refresh_token=def`
  )
  expect(parsed.kind).toBe('tokens')
  expect(parsed.accessToken).toBe('abc')
})

// What a DJ who clicks "Cancel" on Google's consent screen actually sends
// back. Reporting this as 'none' would show "Not an auth callback" instead
// of the real reason.
test('a denied consent screen reports the error, not a missing token', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback#error=access_denied&error_description=User%20denied%20access`
  )
  expect(parsed.kind).toBe('error')
  expect(parsed.error).toBe('User denied access')
})

test('the human-readable description wins over the bare error code', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback?error=server_error&error_description=Something%20broke`
  )
  expect(parsed.error).toBe('Something broke')
})

// An error with tokens somehow also present must still be treated as an
// error — adopting a session off a failed callback is the worse outcome.
test('an error takes precedence over any tokens in the same URL', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback#error=access_denied&access_token=abc&refresh_token=def`
  )
  expect(parsed.kind).toBe('error')
})

// setSession needs the pair; a lone access token buys a session that cannot
// outlive its hour, which is worse than reporting nothing.
test('an access token with no refresh token is not accepted', () => {
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback#access_token=abc`).kind).toBe(
    'none'
  )
})

test('a refresh token with no access token is not accepted', () => {
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback#refresh_token=def`).kind).toBe(
    'none'
  )
})

// The Windows argv case: ordinary flags and file paths go through here.
test('a foreign scheme is ignored', () => {
  expect(parseCallbackUrl('https://example.com/?code=xyz').kind).toBe('none')
  expect(parseCallbackUrl('cratecloudx://auth-callback?code=xyz').kind).toBe('none')
})

test('a non-URL argument is ignored rather than throwing', () => {
  expect(parseCallbackUrl('--enable-logging').kind).toBe('none')
  expect(parseCallbackUrl('/Users/dj/Music/track.mp3').kind).toBe('none')
  expect(parseCallbackUrl('').kind).toBe('none')
})

test('our scheme with nothing useful on it reports none', () => {
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback`).kind).toBe('none')
})

// A JWT is full of characters that need URL-encoding; a parser that split on
// '&' by hand rather than using URLSearchParams would mangle these.
test('a realistic JWT survives parsing intact', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback#access_token=${jwt}&refresh_token=r-${jwt}`
  )
  expect(parsed.accessToken).toBe(jwt)
  expect(parsed.refreshToken).toBe(`r-${jwt}`)
})

// ── Password recovery ───────────────────────────────────────────────────
// A reset link carries tokens exactly like a sign-in does; type=recovery is
// the only thing that tells them apart. Getting this wrong would sign the DJ
// in with the password they had just told us they forgot, and never show the
// set-a-new-one screen.

test('a recovery link is distinguished from an ordinary sign-in', () => {
  const parsed = parseCallbackUrl(
    `${CALLBACK_PROTOCOL}://auth-callback#access_token=abc&refresh_token=def&type=recovery`
  )
  expect(parsed.kind).toBe('recovery')
  expect(parsed.accessToken).toBe('abc')
  expect(parsed.refreshToken).toBe('def')
})

test('tokens with no type are an ordinary sign-in, not a recovery', () => {
  expect(
    parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback#access_token=abc&refresh_token=def`).kind
  ).toBe('tokens')
})

// Supabase uses the same parameter for invite and email-change links. Those
// are not handled in-app yet, and must not be mistaken for a recovery.
test('a non-recovery link type is treated as an ordinary sign-in', () => {
  for (const type of ['signup', 'invite', 'email_change', 'magiclink']) {
    expect(
      parseCallbackUrl(
        `${CALLBACK_PROTOCOL}://auth-callback#access_token=abc&refresh_token=def&type=${type}`
      ).kind
    ).toBe('tokens')
  }
})

test('a recovery link that failed still reports the error', () => {
  expect(
    parseCallbackUrl(
      `${CALLBACK_PROTOCOL}://auth-callback#error=access_denied&error_description=Email%20link%20is%20invalid%20or%20has%20expired&type=recovery`
    ).kind
  ).toBe('error')
})
