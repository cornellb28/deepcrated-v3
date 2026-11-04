// ── Custom tag fields and where they show up in Serato ────────────────────
// A custom field is a tag category the DJ invents (Mood, Vibe, Venue...).
// Its values live in the generic tags table like every other field, under a
// `cf_`-prefixed field name so they can never collide with a standard field
// or with one added later. Custom fields have no tracks.<field> column: the
// tags are the only copy in the database.
//
// Serato only shows a fixed set of file tag fields, so a custom field can be
// given a "Show in Serato as" target. When a file is written, the target
// field gets its own values followed by the mapped values, joined with the
// usual " | ": a comment of GOTOS plus a Mood of DARK goes to the file as
// "GOTOS | DARK". (Settled 2026-11-04: plain values added after, no "Mood:"
// prefix, and never replacing the field's own values.) DeepCrated keeps
// knowing which values are Mood because the tags table says so; the file
// is only what Serato reads.
//
// The definitions and mappings are one JSON setting in app_settings. This
// module holds every rule about them that needs no database, so it can be
// unit-tested the way tagFields.ts is.

import { DISPLAY_DELIMITER, splitValue } from './tagFields'

export const CUSTOM_FIELDS_SETTING_KEY = 'custom_tag_fields'
export const CUSTOM_FIELD_PREFIX = 'cf_'

// The file fields a custom field may be shown as. All of them are text
// fields Serato displays and lets the DJ edit, and all of them are already
// written by edit_tags.py. Title, artist and album are left out on purpose:
// mixing badges into those would change what the track is, and artist is
// what tracks are matched and cleaned on.
export const MAPPING_TARGETS = [
  'comment',
  'grouping',
  'genre',
  'composer',
  'remixer',
  'label'
] as const
export type MappingTarget = (typeof MAPPING_TARGETS)[number]

export const MAPPING_TARGET_LABELS: Record<MappingTarget, string> = {
  comment: 'Comment',
  grouping: 'Grouping',
  genre: 'Genre',
  composer: 'Composer',
  remixer: 'Remixer',
  label: 'Label'
}

// Serato does not read remixer or label from an MP4 file (see the note on
// MP4_LABEL_KEY in sidecar/edit_tags.py). The values are still written, so
// they survive in the file, but they will not appear in Serato for these.
export const TARGETS_HIDDEN_IN_SERATO: Partial<Record<MappingTarget, readonly string[]>> = {
  remixer: ['m4a'],
  label: ['m4a']
}

export interface CustomField {
  key: string // the tags.field value, always cf_-prefixed
  label: string // what the DJ called it, e.g. "Mood"
  color: string
  writeTo: MappingTarget | null // null: kept in DeepCrated only
}

export const MAX_CUSTOM_FIELDS = 12
const MAX_LABEL_LENGTH = 32
const DEFAULT_COLOR = '#7f77dd'

export function isMappingTarget(value: unknown): value is MappingTarget {
  return typeof value === 'string' && (MAPPING_TARGETS as readonly string[]).includes(value)
}

export function isCustomFieldKey(field: string): boolean {
  return field.startsWith(CUSTOM_FIELD_PREFIX) && /^cf_[a-z0-9_]{1,40}$/.test(field)
}

// "Mood" -> "cf_mood", "Set Time!" -> "cf_set_time". Lowercase ASCII only, so
// the key is stable whatever the label is later renamed to.
export function keyForLabel(label: string): string | null {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return slug === '' ? null : CUSTOM_FIELD_PREFIX + slug
}

function cleanLabel(label: unknown): string {
  return typeof label === 'string'
    ? label.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH)
    : ''
}

function cleanColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR
}

// Validates whatever the renderer (or an old build, or a hand-edited
// database) hands over. Never throws: anything malformed is dropped, so a
// bad setting cannot stop a file write.
export function sanitizeCustomFields(input: unknown): CustomField[] {
  if (!Array.isArray(input)) return []
  const out: CustomField[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const label = cleanLabel(r.label)
    if (label === '') continue
    const key = typeof r.key === 'string' && isCustomFieldKey(r.key) ? r.key : keyForLabel(label)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      label,
      color: cleanColor(r.color),
      writeTo: isMappingTarget(r.writeTo) ? r.writeTo : null
    })
    if (out.length >= MAX_CUSTOM_FIELDS) break
  }
  return out
}

export function parseCustomFields(json: string | null | undefined): CustomField[] {
  if (!json) return []
  try {
    return sanitizeCustomFields(JSON.parse(json))
  } catch {
    return []
  }
}

export function serializeCustomFields(fields: readonly CustomField[]): string {
  return JSON.stringify(sanitizeCustomFields(fields))
}

// ── Building the file value ───────────────────────────────────────────────

function sameValue(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// The target's own values, then each mapped value not already there. A value
// the DJ put in both places (DARK as a comment AND as a Mood) goes to the
// file once.
export function mergeValues(
  own: string | null | undefined,
  field: string,
  extra: readonly string[]
): string {
  const parts = splitValue(field, own)
  let added = false
  for (const value of extra) {
    if (value.trim() === '') continue
    if (!parts.some((p) => sameValue(p, value))) {
      parts.push(value.trim())
      added = true
    }
  }
  // Nothing to add: hand the value back exactly as it came, so a field with
  // no mapping on it is written byte-for-byte as it was before this existed.
  if (!added) return own ?? ''
  return parts.join(DISPLAY_DELIMITER)
}

// Which targets a write has to (re)compute: every target already in the meta,
// plus the target of every mapped custom field the write mentions. The second
// half is what makes adding a Mood rewrite the file's Comment.
export function targetsTouched(
  meta: Record<string, unknown>,
  fields: readonly CustomField[]
): MappingTarget[] {
  const out = new Set<MappingTarget>()
  for (const field of fields) {
    if (!field.writeTo) continue
    if (field.writeTo in meta || field.key in meta) out.add(field.writeTo)
  }
  return [...out]
}

// Rewrites an edit_tags.py meta payload so mapped custom values reach the
// file. `own` gives the track's current value for a target that the meta
// does not carry (the derived tracks.<field> column); `customValues` gives
// the track's tags per custom field key. Custom field keys are removed from
// the result: edit_tags.py has nothing to write them to.
//
// Pure, so every write path (the Inspector, a tag badge, bulk edit, artist
// clean) gets the same answer from the same rule.
export function applyFieldMappings(
  meta: Record<string, unknown>,
  fields: readonly CustomField[],
  own: (target: MappingTarget) => string | null | undefined,
  customValues: (key: string) => readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!isCustomFieldKey(k)) out[k] = v
  }

  for (const target of targetsTouched(meta, fields)) {
    const mapped = fields.filter((f) => f.writeTo === target).flatMap((f) => customValues(f.key))
    const base = target in meta ? (meta[target] as string | null | undefined) : own(target)
    out[target] = mergeValues(base ?? '', target, mapped)
  }
  return out
}

// ── Reading a file back ───────────────────────────────────────────────────
// The other direction: a value read from a file (or from Serato's database)
// for a target column may carry the mapped values DeepCrated put there. They
// are already stored as custom tags, so they are taken out before the value
// lands in the column, or they would turn up a second time as, say, a
// Comment badge. Returns null for nothing left, like the rest of the
// codebase does for "no value".
export function stripMappedValues(
  raw: string | null | undefined,
  field: string,
  mapped: readonly string[]
): string | null {
  if (raw === null || raw === undefined) return raw ?? null
  if (mapped.length === 0) return raw
  const parts = splitValue(field, raw)
  const kept = parts.filter((p) => !mapped.some((m) => sameValue(p, m)))
  if (kept.length === parts.length) return raw
  return kept.length > 0 ? kept.join(DISPLAY_DELIMITER) : null
}
