import { test, expect } from '@playwright/test'
import {
  createTagKeyCache,
  isNoiseTagValue,
  tagKeysFor,
  tagValueKey
} from '../../src/shared/tagKeys'

// The one normalization Track Match uses for roles, overlap and
// co-occurrence (src/shared/tagKeys.ts). Spellings are real ones from a DJ
// library.

test('the three spellings of hip hop in a real library are one tag', () => {
  expect(tagValueKey('hip hop')).toBe('hip hop')
  expect(tagValueKey('Hip-Hop')).toBe('hip hop')
  expect(tagValueKey('[hip hop]')).toBe('hip hop')
  expect(tagValueKey('[Hip Hop]')).toBe('hip hop')
  expect(tagValueKey('HIP_HOP')).toBe('hip hop')
})

test('case folds, wrapping brackets go (repeatedly), spaces trim and collapse', () => {
  expect(tagValueKey('  00s   CURRENT ')).toBe('00s current')
  expect(tagValueKey('[house]')).toBe('house')
  expect(tagValueKey('(Afro-House)')).toBe('afro house')
  expect(tagValueKey('[(Deep House)]')).toBe('deep house')
  expect(tagValueKey('{90s}')).toBe('90s')
  expect(tagValueKey('[hip hop 2000]')).toBe('hip hop 2000')
})

test('nothing fancier: inner brackets, & and punctuation are kept', () => {
  expect(tagValueKey('R&B')).toBe('r&b')
  expect(tagValueKey('Hip Hop (Clean)')).toBe('hip hop (clean)')
  expect(tagValueKey('Drum & Bass')).toBe('drum & bass')
  expect(tagValueKey('Free Style')).toBe('free style')
  expect(tagValueKey('')).toBe('')
})

test('noise: SERATOCOLLECTION exactly (any case) and URL-shaped values', () => {
  for (const v of [
    'SERATOCOLLECTION',
    'seratocollection',
    ' SeratoCollection ',
    'vk.com/xclusives_zone',
    'www.franchiserecordpool.com',
    'www.audiocastle.net',
    'www.directmusicservice.com',
    'www.beatjunkies.com',
    'http://erdal-keskin.blogspot.com/',
    'https://example.org/track'
  ]) {
    expect(isNoiseTagValue(v), v).toBe(true)
  }
})

test('real tags are not noise, even ones that mention Serato or look odd', () => {
  for (const v of [
    'GOTOS',
    'HEADZ',
    'Hip Hop',
    'CURRENT',
    'Other',
    'SERATO COLLECTION',
    'Serato Picks',
    '90s CLASSIC',
    'Mr.Fingers'
  ]) {
    expect(isNoiseTagValue(v), v).toBe(false)
  }
})

test("a track's values become distinct keys with noise removed, in order", () => {
  expect(
    tagKeysFor(['Hip Hop', 'hip-hop', 'SERATOCOLLECTION', '[R&B]', 'www.beatjunkies.com'])
  ).toEqual(['hip hop', 'r&b'])
})

test('the key cache returns the same keys as uncached normalization, once per string', () => {
  let splits = 0
  const split = (_f: string, raw: string | null | undefined): string[] => {
    splits++
    return (raw ?? '').split(' | ')
  }
  const keysOf = createTagKeyCache(split)
  expect(keysOf('genre', 'Hip-Hop | [R&B]')).toEqual(tagKeysFor(['Hip-Hop', '[R&B]']))
  expect(keysOf('genre', 'Hip-Hop | [R&B]')).toEqual(['hip hop', 'r&b'])
  expect(splits).toBe(1)
  expect(keysOf('genre', null)).toEqual([])
})
