import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import {
  parseCallbackUrl,
  CALLBACK_PROTOCOL,
  LEGACY_CALLBACK_PROTOCOL,
  PENDING_FLOW_TTL_MS,
  beginFlow,
  clearFlow,
  consumeFlow,
  deriveChallenge,
  getPendingFlow,
  redeemKey,
  runHandoff,
  validRedeemUrl
} from '../../src/main/authCallback'

// The sign-in handoff, tested without a browser, a website or a live Supabase
// project: how the deep link is read, when a pending flow accepts it, and what
// happens after the key is redeemed (against a local mock endpoint).

const BASE = `${CALLBACK_PROTOCOL}://auth-callback`
const TOKENS = { access_token: 'access-abc', refresh_token: 'refresh-abc' }

test.beforeEach(() => clearFlow())

// ── Challenge derivation ────────────────────────────────────────────────

test('challenge is base64url(SHA-256(verifier))', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const expected = createHash('sha256').update(verifier).digest('base64url')
  expect(deriveChallenge(verifier)).toBe(expected)
  // RFC 7636 appendix B vector.
  expect(deriveChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('beginFlow puts challenge and state in the URL, never the verifier', () => {
  const flow = beginFlow('https://example.com/desktop/connect', 'signin')
  const url = new URL(flow.url)
  expect(url.searchParams.get('challenge')).toBe(deriveChallenge(flow.verifier))
  expect(url.searchParams.get('state')).toBe(flow.state)
  expect(url.searchParams.has('mode')).toBe(false)
  expect(flow.url).not.toContain(flow.verifier)
  expect(flow.verifier).not.toBe(flow.state)
})

test('create account adds mode=signup', () => {
  const flow = beginFlow('https://example.com/desktop/connect', 'signup')
  expect(new URL(flow.url).searchParams.get('mode')).toBe('signup')
})

// ── Parser ──────────────────────────────────────────────────────────────

test('a key and state are read from the query string', () => {
  expect(parseCallbackUrl(`${BASE}?key=k1&state=s1`)).toEqual({
    kind: 'handoff',
    key: 'k1',
    state: 's1'
  })
})

test('a wrong authority, path or credentials is not ours', () => {
  const q = '?key=k&state=s'
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://other-host${q}`).kind).toBe('none')
  expect(parseCallbackUrl(`${BASE}/other${q}`).kind).toBe('none')
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback.evil${q}`).kind).toBe('none')
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://user@auth-callback${q}`).kind).toBe('none')
  expect(parseCallbackUrl(`${CALLBACK_PROTOCOL}://auth-callback:443${q}`).kind).toBe('none')
})

test('the primary scheme is deepcrated and the old cratecloud scheme is still accepted', () => {
  expect(CALLBACK_PROTOCOL).toBe('deepcrated')
  expect(LEGACY_CALLBACK_PROTOCOL).toBe('cratecloud')
  for (const scheme of ['deepcrated', 'cratecloud']) {
    expect(parseCallbackUrl(`${scheme}://auth-callback?key=k1&state=s1`)).toEqual({
      kind: 'handoff',
      key: 'k1',
      state: 's1'
    })
  }
})

test('the legacy scheme is held to the same strict rules', () => {
  const legacy = `${LEGACY_CALLBACK_PROTOCOL}://auth-callback`
  expect(parseCallbackUrl(`${legacy}?key=k&state=s#access_token=a`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${legacy}?key=k&state=s&code=c`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${LEGACY_CALLBACK_PROTOCOL}://other-host?key=k&state=s`).kind).toBe(
    'none'
  )
})

test('a foreign scheme or non-URL argument is ignored', () => {
  expect(parseCallbackUrl('https://example.com/?key=k&state=s').kind).toBe('none')
  expect(parseCallbackUrl('cratecloudx://auth-callback?key=k&state=s').kind).toBe('none')
  expect(parseCallbackUrl('deepcratedx://auth-callback?key=k&state=s').kind).toBe('none')
  expect(parseCallbackUrl('deepcrate://auth-callback?key=k&state=s').kind).toBe('none')
  expect(parseCallbackUrl('--enable-logging').kind).toBe('none')
  expect(parseCallbackUrl('/Users/dj/Music/track.mp3').kind).toBe('none')
  expect(parseCallbackUrl('').kind).toBe('none')
})

test('missing key or state is rejected', () => {
  expect(parseCallbackUrl(BASE).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?key=k`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?state=s`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?key=&state=s`).kind).toBe('invalid')
})

test('fragments and token, code or error params are rejected', () => {
  expect(parseCallbackUrl(`${BASE}?key=k&state=s#access_token=a`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}#access_token=a&refresh_token=b`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}#code=xyz`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?code=xyz`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?key=k&state=s&access_token=a`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?key=k&state=s&refresh_token=b`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?key=k&state=s&code=c`).kind).toBe('invalid')
  expect(parseCallbackUrl(`${BASE}?error=access_denied`).kind).toBe('invalid')
})

test('duplicate key or state params are rejected', () => {
  expect(parseCallbackUrl(`${BASE}?key=a&key=b&state=s`).kind).toBe('invalid')
})

// ── Pending flow ────────────────────────────────────────────────────────

test('no pending flow rejects the link', () => {
  expect(consumeFlow('k', 's')).toBeNull()
})

test('a mismatched state rejects the link and keeps the flow', () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  expect(consumeFlow('k', 'wrong')).toBeNull()
  expect(consumeFlow('k', flow.state + 'x')).toBeNull()
  expect(getPendingFlow()).not.toBeNull()
})

test('an expired flow rejects the link and clears itself', () => {
  const flow = beginFlow('https://example.com/c', 'signin', 1_000)
  expect(consumeFlow('k', flow.state, 1_000 + PENDING_FLOW_TTL_MS + 1)).toBeNull()
  expect(getPendingFlow()).toBeNull()
})

test('a flow within the window is accepted once, then a replay is rejected', () => {
  const flow = beginFlow('https://example.com/c', 'signin', 1_000)
  const first = consumeFlow('k', flow.state, 1_000 + PENDING_FLOW_TTL_MS - 1)
  expect(first).toEqual({ key: 'k', verifier: flow.verifier })
  expect(consumeFlow('k', flow.state)).toBeNull()
})

test('cancel clears the pending flow', () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  clearFlow()
  expect(consumeFlow('k', flow.state)).toBeNull()
})

// ── Redeem URL policy ───────────────────────────────────────────────────

test('redeem URL must be https, or localhost http in dev only', () => {
  expect(validRedeemUrl('https://example.com/r', false)).not.toBeNull()
  expect(validRedeemUrl('http://example.com/r', true)).toBeNull()
  expect(validRedeemUrl('http://localhost:3000/r', false)).toBeNull()
  expect(validRedeemUrl('http://localhost:3000/r', true)).not.toBeNull()
  expect(validRedeemUrl('', true)).toBeNull()
  expect(validRedeemUrl(undefined, true)).toBeNull()
  expect(validRedeemUrl('not a url', true)).toBeNull()
})

// ── Redeem + session adoption against a mock endpoint ───────────────────

let server: Server
let redeemUrl: string
let received: { key?: string; verifier?: string; method?: string; type?: string } | null
let respond: (res: import('node:http').ServerResponse) => void

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        received = { ...JSON.parse(body), method: req.method, type: req.headers['content-type'] }
      } catch {
        received = null
      }
      respond(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  redeemUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/redeem`
})

test.afterAll(() => {
  server.close()
})

test.beforeEach(() => {
  received = null
  respond = (res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(TOKENS))
  }
})

type Deps = Parameters<typeof runHandoff>[1]

function deps(overrides: Partial<Deps> = {}): { adopted: unknown[]; deps: Deps } {
  const adopted: unknown[] = []
  return {
    adopted,
    deps: {
      redeemUrl,
      setSession: async () => ({ user: 'u' }),
      adopt: async (s: unknown) => void adopted.push(s),
      ...overrides
    }
  }
}

test('a successful redeem posts key + verifier and adopts the session', async () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  const { adopted, deps: d } = deps()
  const outcome = await runHandoff(`${BASE}?key=the-key&state=${flow.state}`, d)

  expect(outcome).toBe('ok')
  expect(received).toMatchObject({
    key: 'the-key',
    verifier: flow.verifier,
    method: 'POST',
    type: 'application/json'
  })
  expect(adopted).toHaveLength(1)
  expect(getPendingFlow()).toBeNull()
})

test('setSession receives exactly the tokens the endpoint returned', async () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  let seen: unknown
  const { deps: d } = deps({
    setSession: async (t) => {
      seen = t
      return { user: 'u' }
    }
  })
  await runHandoff(`${BASE}?key=k&state=${flow.state}`, d)
  expect(seen).toEqual(TOKENS)
})

test('replaying the same link after success is ignored and redeems nothing', async () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  const link = `${BASE}?key=k&state=${flow.state}`
  const { adopted, deps: d } = deps()
  expect(await runHandoff(link, d)).toBe('ok')
  received = null
  expect(await runHandoff(link, d)).toBe('ignored')
  expect(received).toBeNull()
  expect(adopted).toHaveLength(1)
})

test('a failed redeem returns failed, adopts nothing and clears the flow', async () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  respond = (res) => {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'expired' }))
  }
  const { adopted, deps: d } = deps()
  const outcome = await runHandoff(`${BASE}?key=k&state=${flow.state}`, d)

  expect(outcome).toBe('failed')
  expect(adopted).toHaveLength(0)
  // Flow consumed: the app is no longer awaiting the browser (signedOut).
  expect(getPendingFlow()).toBeNull()
})

test('a malformed redeem body, or a rejected setSession, is a failure', async () => {
  let flow = beginFlow('https://example.com/c', 'signin')
  respond = (res) => res.end(JSON.stringify({ access_token: 'only-one' }))
  const first = deps()
  expect(await runHandoff(`${BASE}?key=k&state=${flow.state}`, first.deps)).toBe('failed')

  flow = beginFlow('https://example.com/c', 'signin')
  respond = (res) => res.end(JSON.stringify(TOKENS))
  const second = deps({ setSession: async () => null })
  expect(await runHandoff(`${BASE}?key=k&state=${flow.state}`, second.deps)).toBe('failed')
  expect(second.adopted).toHaveLength(0)
})

test('an unreachable endpoint fails rather than throwing', async () => {
  const tokens = await redeemKey('http://127.0.0.1:1/redeem', 'k', 'v')
  expect(tokens).toBeNull()
})

test('a hung endpoint is abandoned after the timeout', async () => {
  respond = () => {} // never answers
  expect(await redeemKey(redeemUrl, 'k', 'v', fetch, 100)).toBeNull()
})

test('a forged or wrong-state link changes nothing and redeems nothing', async () => {
  const flow = beginFlow('https://example.com/c', 'signin')
  const { adopted, deps: d } = deps()

  expect(await runHandoff(`${BASE}?key=fake&state=wrong`, d)).toBe('ignored')
  expect(await runHandoff(`${BASE}?key=fake&state=${flow.state}&access_token=x`, d)).toBe('invalid')
  expect(await runHandoff(`${BASE}?key=fake&state=${flow.state}#access_token=x`, d)).toBe('invalid')
  expect(await runHandoff(`${CALLBACK_PROTOCOL}://elsewhere?key=fake&state=${flow.state}`, d)).toBe(
    'ignored'
  )

  expect(received).toBeNull()
  expect(adopted).toHaveLength(0)
  // The real flow is untouched and still usable.
  expect(getPendingFlow()?.state).toBe(flow.state)
})
