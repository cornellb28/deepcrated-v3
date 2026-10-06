import { test, expect } from '@playwright/test'
import {
  addTag,
  coOccurringTags,
  removeTag,
  tracksMatchingTags
} from '../../src/renderer/src/lib/tagFilter'

// The Tags page's stacking filter. The risk this covers is a suggestion row
// that offers a tag leading to zero tracks, and an AND that quietly behaves
// like an OR — both of which look like "the filter is broken" to a DJ.

function tag(id: number, value: string, field = 'comment'): Tag {
  return { id, value, field, color: '#7f77dd' } as Tag
}

function track(id: number): Track {
  return { id } as Track
}

const PEAK = tag(1, 'peak time')
const HOUSE = tag(2, 'house', 'genre')
const VOCAL = tag(3, 'vocal')

// 1: peak + house   2: peak only   3: house + vocal   4: nothing
const tracks = [track(1), track(2), track(3), track(4)]
const trackTags = new Map<number, Tag[]>([
  [1, [PEAK, HOUSE]],
  [2, [PEAK]],
  [3, [HOUSE, VOCAL]]
])

test('one tag returns every track carrying it', () => {
  const result = tracksMatchingTags(tracks, trackTags, [PEAK.id])
  expect(result.map((t) => t.id)).toEqual([1, 2])
})

test('two tags mean BOTH, not either', () => {
  // The whole point of "narrow further". An OR here would widen the result
  // as the DJ adds tags, which is the opposite of what the row promises.
  const result = tracksMatchingTags(tracks, trackTags, [PEAK.id, HOUSE.id])
  expect(result.map((t) => t.id)).toEqual([1])
})

test('a combination nothing carries returns empty rather than everything', () => {
  expect(tracksMatchingTags(tracks, trackTags, [PEAK.id, VOCAL.id])).toEqual([])
})

test('an untagged track never matches', () => {
  const result = tracksMatchingTags(tracks, trackTags, [PEAK.id])
  expect(result.some((t) => t.id === 4)).toBe(false)
})

test('no tags at all passes everything through', () => {
  expect(tracksMatchingTags(tracks, trackTags, []).length).toBe(4)
})

test('suggestions come from the current result, never the whole library', () => {
  // Filtering by "peak time" leaves tracks 1 and 2. "vocal" is only on track
  // 3, so offering it would hand the DJ a button that leads to nothing.
  const matching = tracksMatchingTags(tracks, trackTags, [PEAK.id])
  const suggestions = coOccurringTags(matching, trackTags, [PEAK.id])

  expect(suggestions.map((s) => s.tag.value)).toEqual(['house'])
  expect(suggestions.map((s) => s.tag.value)).not.toContain('vocal')
})

test('every suggestion leaves at least one track behind', () => {
  const matching = tracksMatchingTags(tracks, trackTags, [HOUSE.id])
  for (const { tag: next } of coOccurringTags(matching, trackTags, [HOUSE.id])) {
    const narrowed = tracksMatchingTags(tracks, trackTags, [HOUSE.id, next.id])
    expect(narrowed.length).toBeGreaterThan(0)
  }
})

test('suggestions exclude what is already applied', () => {
  const matching = tracksMatchingTags(tracks, trackTags, [PEAK.id, HOUSE.id])
  const ids = coOccurringTags(matching, trackTags, [PEAK.id, HOUSE.id]).map((s) => s.tag.id)
  expect(ids).not.toContain(PEAK.id)
  expect(ids).not.toContain(HOUSE.id)
})

test('suggestions are ordered by count, ties alphabetical', () => {
  // A stable order matters: a row that reshuffles between renders makes the
  // chip under the cursor move as you reach for it.
  const many = [track(1), track(2), track(3)]
  const applied = new Map<number, Tag[]>([
    [1, [PEAK, HOUSE, VOCAL]],
    [2, [PEAK, HOUSE]],
    [3, [PEAK, tag(4, 'aaa')]]
  ])
  const result = coOccurringTags(many, applied, [PEAK.id])
  expect(result.map((s) => `${s.tag.value}:${s.count}`)).toEqual(['house:2', 'aaa:1', 'vocal:1'])
})

test('adding a tag already applied does not stack it twice', () => {
  // The same tag is reachable from a badge, the cloud and the suggestion row.
  expect(addTag([PEAK], PEAK).length).toBe(1)
  expect(addTag([PEAK], HOUSE).map((t) => t.id)).toEqual([1, 2])
})

test('removing a tag leaves the rest in order', () => {
  expect(removeTag([PEAK, HOUSE, VOCAL], HOUSE.id).map((t) => t.id)).toEqual([1, 3])
  expect(removeTag([PEAK], 99).map((t) => t.id)).toEqual([1])
})
