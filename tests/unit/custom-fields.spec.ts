import { test, expect } from '@playwright/test'
import {
  applyFieldMappings,
  keyForLabel,
  mergeValues,
  parseCustomFields,
  sanitizeCustomFields,
  stripMappedValues,
  type CustomField
} from '../../src/main/customFields'
import { normalizeTagValue } from '../../src/main/tagFields'

// Custom fields (Mood, Vibe...) and their "Show in Serato as" target. The
// format was settled 2026-11-04: mapped values go AFTER the field's own
// values, plain, joined with " | " — "GOTOS | DARK" — and never replace them.

const MOOD: CustomField = { key: 'cf_mood', label: 'Mood', color: '#c46ad8', writeTo: 'comment' }
const VIBE: CustomField = { key: 'cf_vibe', label: 'Vibe', color: '#d8a33a', writeTo: 'comment' }
const VENUE: CustomField = { key: 'cf_venue', label: 'Venue', color: '#3ab0a3', writeTo: null }

function values(map: Record<string, string[]>) {
  return (key: string) => map[key] ?? []
}

test('a label becomes a stable cf_ key', () => {
  expect(keyForLabel('Mood')).toBe('cf_mood')
  expect(keyForLabel('  Set Time! ')).toBe('cf_set_time')
  expect(keyForLabel('!!!')).toBeNull()
})

test('custom field values are uppercased like other badge fields', () => {
  expect(normalizeTagValue('cf_mood', ' dark ')).toBe('DARK')
})

test('sanitize drops junk, duplicates and unknown targets', () => {
  const out = sanitizeCustomFields([
    { label: 'Mood', writeTo: 'comment' },
    { label: 'mood', writeTo: 'grouping' }, // same key
    { label: '', writeTo: 'comment' },
    { label: 'Vibe', writeTo: 'title' }, // not an allowed target
    { label: 'Venue', color: 'red' },
    'nonsense',
    null
  ])
  expect(out).toEqual([
    { key: 'cf_mood', label: 'Mood', color: '#7f77dd', writeTo: 'comment' },
    { key: 'cf_vibe', label: 'Vibe', color: '#7f77dd', writeTo: null },
    { key: 'cf_venue', label: 'Venue', color: '#7f77dd', writeTo: null }
  ])
  expect(parseCustomFields('{not json')).toEqual([])
  expect(parseCustomFields(null)).toEqual([])
})

test('mapped values go after the field’s own values', () => {
  expect(mergeValues('GOTOS', 'comment', ['DARK'])).toBe('GOTOS | DARK')
  expect(mergeValues('', 'comment', ['DARK', 'PEAK'])).toBe('DARK | PEAK')
  // Already there (any case): written once.
  expect(mergeValues('GOTOS | dark', 'comment', ['DARK'])).toBe('GOTOS | dark')
})

test('with nothing to add the value is returned untouched', () => {
  // Legacy " / " stays as it was rather than being rewritten to " | ".
  expect(mergeValues('CLASSIC / CURRENT', 'grouping', [])).toBe('CLASSIC / CURRENT')
})

test('writing the comment folds in the Mood', () => {
  const out = applyFieldMappings(
    { comment: 'GOTOS', title: 'One' },
    [MOOD],
    () => null,
    values({ cf_mood: ['DARK'] })
  )
  expect(out).toEqual({ comment: 'GOTOS | DARK', title: 'One' })
})

test('changing only the Mood rewrites the comment from the track’s own value', () => {
  const out = applyFieldMappings(
    { cf_mood: 'DARK', cratecloud_id: 'abc' },
    [MOOD],
    (t) => (t === 'comment' ? 'GOTOS | HEADZ' : null),
    values({ cf_mood: ['DARK'] })
  )
  // The custom key itself never reaches edit_tags.py.
  expect(out).toEqual({ comment: 'GOTOS | HEADZ | DARK', cratecloud_id: 'abc' })
})

test('two fields mapped to one target both land, in field order', () => {
  const out = applyFieldMappings(
    { comment: 'GOTOS' },
    [MOOD, VIBE],
    () => null,
    values({ cf_mood: ['DARK'], cf_vibe: ['WARM'] })
  )
  expect(out.comment).toBe('GOTOS | DARK | WARM')
})

test('an unmapped custom field never touches the file', () => {
  const out = applyFieldMappings(
    { cf_venue: 'CLUB', cratecloud_id: 'abc' },
    [VENUE],
    () => 'GOTOS',
    values({ cf_venue: ['CLUB'] })
  )
  expect(out).toEqual({ cratecloud_id: 'abc' })
})

test('removing the last Mood value clears it from the comment', () => {
  const out = applyFieldMappings(
    { cf_mood: '' },
    [MOOD],
    () => 'GOTOS',
    values({ cf_mood: [] })
  )
  expect(out).toEqual({ comment: 'GOTOS' })
})

test('reading back takes mapped values out, and only those', () => {
  expect(stripMappedValues('GOTOS | DARK', 'comment', ['DARK'])).toBe('GOTOS')
  expect(stripMappedValues('DARK', 'comment', ['dark'])).toBeNull()
  expect(stripMappedValues('GOTOS / HEADZ', 'comment', ['DARK'])).toBe('GOTOS / HEADZ')
  expect(stripMappedValues('House | DARK', 'genre', [])).toBe('House | DARK')
  expect(stripMappedValues(null, 'genre', ['DARK'])).toBeNull()
})
