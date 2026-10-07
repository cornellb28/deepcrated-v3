// ── Anonymous stats: the allowlist ────────────────────────────────────────
// The only definition of what may ever leave this machine. An event is sent
// only if its type is listed here and every payload field matches the type
// and bound declared for it. There are deliberately no free-text fields: a
// string is only ever a member of a fixed enum, so a file path, file name,
// folder name or anything the user typed cannot be expressed in a payload.
//
// Adding an event or a field is a privacy decision. It must be added here,
// to the CHECK constraint in supabase/migrations/*_stats_events.sql (a unit
// test compares the two lists), and to the privacy page.

import { CANONICAL_ID_PATTERN } from '../identity/canonical'

// Track-scoped events also carry the track's canonical_track_id (isrc:…,
// mbid:… or fp:…, see identity/canonical.ts). It is not declared per event:
// enqueueStat attaches it from the database — callers cannot supply one —
// and validateEvent requires it to match CANONICAL_ID_PATTERN, which no path
// or name can. It is the only identifier of a track that ever leaves the
// device; local ids and paths never do.
export const CANONICAL_ID_FIELD = 'canonical_track_id'

export type FieldSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }

export interface EventSpec {
  // 'track' events must be raised with a trackId so canCollect can check the
  // track and its crates. 'global' events carry no library item at all.
  scope: 'global' | 'track'
  fields: Readonly<Record<string, FieldSpec>>
}

export const EVENT_SPECS = {
  app_session: {
    scope: 'global',
    fields: {
      library_size_bucket: { kind: 'enum', values: ['lt100', '100-1k', '1k-10k', 'gt10k'] }
    }
  },
  crate_created: {
    scope: 'global',
    fields: { nested: { kind: 'bool' } }
  },
  track_added_to_crate: {
    scope: 'track',
    fields: { crate_depth: { kind: 'int', min: 0, max: 5 } }
  },
  track_tagged: {
    scope: 'track',
    fields: {
      field: { kind: 'enum', values: ['genre', 'mood', 'vibe', 'era', 'label', 'other'] },
      source: { kind: 'enum', values: ['manual', 'bulk', 'auto'] }
    }
  },
  track_played: {
    scope: 'track',
    fields: {
      duration_bucket: { kind: 'enum', values: ['lt30s', '30s-2m', '2m-5m', 'gt5m'] },
      completed: { kind: 'bool' }
    }
  }
} as const satisfies Record<string, EventSpec>

export type StatsEventType = keyof typeof EVENT_SPECS

export const EVENT_TYPES = Object.keys(EVENT_SPECS) as StatsEventType[]

export const TRACK_EVENT_TYPES = EVENT_TYPES.filter((t) => EVENT_SPECS[t].scope === 'track')

export const MAX_PAYLOAD_BYTES = 1024

// Mirrored by the CHECK on stats_events.app_version.
export const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
export const MAX_APP_VERSION_LENGTH = 32

export type ValidationResult =
  | { ok: true; eventType: StatsEventType; payload: Record<string, string | number | boolean> }
  | { ok: false; reason: string }

function isEventType(value: unknown): value is StatsEventType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_SPECS, value)
}

function checkField(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean'
    case 'int':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= spec.min &&
        value <= spec.max
      )
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
  }
}

// Rebuilds the payload from the allowlisted fields only. A field that is not
// declared is dropped; a declared field that is missing or out of bounds
// rejects the whole event, so a half-formed event is never queued.
export function validateEvent(eventType: unknown, payload: unknown): ValidationResult {
  if (!isEventType(eventType)) return { ok: false, reason: 'unknown event type' }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' }
  }
  const spec: EventSpec = EVENT_SPECS[eventType]
  const input = payload as Record<string, unknown>
  const clean: Record<string, string | number | boolean> = {}
  for (const [name, fieldSpec] of Object.entries(spec.fields)) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) {
      return { ok: false, reason: `missing field: ${name}` }
    }
    const value = input[name]
    if (!checkField(fieldSpec, value)) return { ok: false, reason: `invalid field: ${name}` }
    clean[name] = value as string | number | boolean
  }
  if (spec.scope === 'track') {
    const id = input[CANONICAL_ID_FIELD]
    if (typeof id !== 'string' || !CANONICAL_ID_PATTERN.test(id)) {
      return { ok: false, reason: `missing or invalid field: ${CANONICAL_ID_FIELD}` }
    }
    clean[CANONICAL_ID_FIELD] = id
  }
  if (JSON.stringify(clean).length > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'payload too large' }
  }
  return { ok: true, eventType, payload: clean }
}

export function isValidAppVersion(version: unknown): version is string {
  return (
    typeof version === 'string' &&
    version.length <= MAX_APP_VERSION_LENGTH &&
    APP_VERSION_PATTERN.test(version)
  )
}

const HOUR_MS = 60 * 60 * 1000

// Exact timestamps are never stored or sent: everything is floored to the hour.
export function hourFloorIso(ms: number): string {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString()
}
