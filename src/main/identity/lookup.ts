// ── Track identity: fingerprint -> MusicBrainz recording lookup ───────────
// Optional and off by default (identity_lookup_enabled). Sends a Chromaprint
// fingerprint and a duration to AcoustID and, for a match, a recording id to
// MusicBrainz — nothing about the user, no file names or paths, and no
// account token (requests carry no credentials of any kind).
//
// Published limits that this honours: AcoustID allows 3 requests/second,
// MusicBrainz 1/second per IP and requires a User-Agent that says who to
// contact. The network and clock are injected, so tests never touch either.

import { normalizeMbid } from './canonical'
import type { LookupCandidate, LookupStatus } from './types'

export const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup'
export const MUSICBRAINZ_RECORDING_URL = 'https://musicbrainz.org/ws/2/recording'

// Slightly under the published limits.
export const ACOUSTID_MIN_INTERVAL_MS = 400 // 2.5 req/s (limit 3)
export const MUSICBRAINZ_MIN_INTERVAL_MS = 1100 // <1 req/s (limit 1)

// A match needs to be this confident to be believed.
export const MIN_MATCH_SCORE = 0.9

// How long a "no match" is remembered before it is asked again.
export const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000

export interface LookupConfig {
  acoustidKey: string
  // How MusicBrainz can reach the maintainers, as it requires — a URL or
  // email. Without one no MusicBrainz request is made.
  contact: string
  appVersion: string
}

export function isLookupConfigured(config: Partial<LookupConfig>): config is LookupConfig {
  return Boolean(config.acoustidKey && config.contact && config.appVersion)
}

// ── rate limiting ─────────────────────────────────────────────────────────

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>
}

// Serializes calls and keeps at least minIntervalMs between their starts.
export function createLimiter(
  minIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>
): Limiter {
  let chain: Promise<unknown> = Promise.resolve()
  let lastStart = Number.NEGATIVE_INFINITY
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = chain.then(async () => {
        const wait = lastStart + minIntervalMs - now()
        if (wait > 0) await sleep(wait)
        lastStart = now()
        return fn()
      })
      chain = result.catch(() => undefined)
      return result
    }
  }
}

// ── reading the AcoustID response ─────────────────────────────────────────

export type Pick =
  { status: 'match'; recordingId: string } | { status: 'none' } | { status: 'ambiguous' }

interface AcoustIdResponse {
  status?: string
  results?: { score?: number; recordings?: { id?: string }[] }[]
}

// The best result at or above MIN_MATCH_SCORE wins. If it names exactly one
// recording that is a match; several recordings (the same audio released as
// more than one recording) or a tie between top results is ambiguous, and an
// ambiguous result is never guessed at.
export function pickRecording(body: unknown): Pick {
  const response = body as AcoustIdResponse
  if (!response || response.status !== 'ok' || !Array.isArray(response.results)) {
    return { status: 'none' }
  }
  const confident = response.results.filter(
    (r) => typeof r.score === 'number' && r.score >= MIN_MATCH_SCORE
  )
  if (confident.length === 0) return { status: 'none' }

  const top = Math.max(...confident.map((r) => r.score as number))
  const best = confident.filter((r) => r.score === top)
  const ids = new Set<string>()
  for (const r of best) {
    for (const rec of r.recordings ?? []) {
      const id = normalizeMbid(rec.id)
      if (id) ids.add(id)
    }
  }
  if (ids.size === 0) return { status: 'none' }
  if (ids.size > 1) return { status: 'ambiguous' }
  return { status: 'match', recordingId: [...ids][0] }
}

// ── the two services ──────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

// Thrown for anything that says "try again later" (offline, throttled, server
// trouble). Not caching a result for these is the point: a flaky network must
// not turn into a month of "no match".
export class TransientLookupError extends Error {}

export interface LookupDeps {
  fetch: FetchLike
  now: () => number
  sleep: (ms: number) => Promise<void>
  config: LookupConfig
}

export interface Lookup {
  resolve(candidate: LookupCandidate): Promise<{ status: LookupStatus; recordingId: string | null }>
}

export function createLookup(deps: LookupDeps): Lookup {
  const acoustid = createLimiter(ACOUSTID_MIN_INTERVAL_MS, deps.now, deps.sleep)
  const musicbrainz = createLimiter(MUSICBRAINZ_MIN_INTERVAL_MS, deps.now, deps.sleep)
  const userAgent = `DeepCrated/${deps.config.appVersion} ( ${deps.config.contact} )`

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await deps.fetch(url, { ...init, credentials: 'omit' })
    } catch {
      throw new TransientLookupError('network unavailable')
    }
  }

  function throwIfTransient(res: Response): void {
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      throw new TransientLookupError(`service busy (${res.status})`)
    }
  }

  async function askAcoustId(c: LookupCandidate): Promise<Pick> {
    const body = new URLSearchParams({
      client: deps.config.acoustidKey,
      meta: 'recordingids',
      duration: String(c.fingerprint_duration),
      fingerprint: c.fingerprint
    })
    const res = await acoustid.run(() =>
      request(ACOUSTID_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
        body: body.toString()
      })
    )
    throwIfTransient(res)
    // A rejected request (bad key, bad input) will not improve by retrying
    // the same track; treat it as a miss rather than looping forever.
    if (!res.ok) return { status: 'none' }
    try {
      return pickRecording(await res.json())
    } catch {
      return { status: 'none' }
    }
  }

  // MusicBrainz redirects a merged recording to the one it was merged into,
  // and fetch follows that, so the id in the response is the current one.
  async function currentRecordingId(recordingId: string): Promise<string | null> {
    const res = await musicbrainz.run(() =>
      request(`${MUSICBRAINZ_RECORDING_URL}/${recordingId}?fmt=json`, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' }
      })
    )
    throwIfTransient(res)
    if (res.status === 404) return null // the recording no longer exists
    if (!res.ok) throw new TransientLookupError(`unexpected status ${res.status}`)
    try {
      const json = (await res.json()) as { id?: string }
      return normalizeMbid(json.id)
    } catch {
      throw new TransientLookupError('unreadable response')
    }
  }

  return {
    async resolve(candidate) {
      const picked = await askAcoustId(candidate)
      if (picked.status !== 'match') return { status: picked.status, recordingId: null }
      const current = await currentRecordingId(picked.recordingId)
      if (!current) return { status: 'none', recordingId: null }
      return { status: 'match', recordingId: current }
    }
  }
}
