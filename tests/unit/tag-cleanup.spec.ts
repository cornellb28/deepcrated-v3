import { test, expect } from '@playwright/test'
import {
  findExactProposals,
  pickCanary,
  findSpellingGroups,
  findTypos,
  groupChanges,
  isAllowedDelimiter,
  mergeRules,
  NO_RULES,
  planTrackField,
  rulesFromChoices,
  splitOnDelimiters,
  type CleanupRules,
  type TrackFieldInput
} from '../../src/shared/tagCleanup'
import { splitValue } from '../../src/main/tagFields'

// Metadata Cleanup planning (src/shared/tagCleanup.ts), with values taken
// from a real library.

const X: CleanupRules = { delimiters: { genre: [' x '] }, rewrites: {} }

function col(trackId: number, field: string, column: string | null): TrackFieldInput {
  return { trackId, field, column, linked: [] }
}

test('" x " splits in either case and with loose spacing; nothing else does', () => {
  expect(splitOnDelimiters('genre', 'Hip Hop x Twerk', [' x '])).toEqual(['Hip Hop', 'Twerk'])
  expect(splitOnDelimiters('genre', 'Blends X Mash Ups X Party Breaks', [' x '])).toEqual([
    'Blends',
    'Mash Ups',
    'Party Breaks'
  ])
  expect(splitOnDelimiters('genre', 'House  x Dance', [' x '])).toEqual(['House', 'Dance'])
  // A word ending in x, or an x inside a word, is not a delimiter.
  expect(splitOnDelimiters('genre', 'Malcolm X', [' x '])).toEqual(['Malcolm X'])
  expect(splitOnDelimiters('genre', 'Xtreme Bass', [' x '])).toEqual(['Xtreme Bass'])
  // Never & or commas.
  expect(splitOnDelimiters('genre', 'Drum & Bass', [' x '])).toEqual(['Drum & Bass'])
})

test('artist and label are never split on " x ", whatever the rules say', () => {
  expect(isAllowedDelimiter('genre', ' x ')).toBe(true)
  expect(isAllowedDelimiter('label', ' x ')).toBe(false)
  expect(isAllowedDelimiter('artist', ' x ')).toBe(false)
  expect(isAllowedDelimiter('artist', ';')).toBe(false) // not a cleanup field at all
  expect(isAllowedDelimiter('genre', ',')).toBe(false)
  expect(splitOnDelimiters('label', 'Def Jam x Roc', [' x '])).toEqual(['Def Jam x Roc'])
  const rules = rulesFromChoices({
    delimiters: [
      { field: 'label', delimiter: ' x ' },
      { field: 'genre', delimiter: ' x ' }
    ],
    spellings: [],
    typos: [],
    exact: []
  })
  expect(rules.delimiters).toEqual({ genre: [' x '] })
})

test('a column-only combined genre becomes separate tags; clean tracks are left alone', () => {
  const c = planTrackField(col(1, 'genre', 'Hip Hop x Twerk'), X, splitValue)
  expect(c).toMatchObject({
    prevColumn: 'Hip Hop x Twerk',
    prevTags: [],
    newTags: ['Hip Hop', 'Twerk'],
    kind: 'split'
  })
  expect(planTrackField(col(2, 'genre', 'Hip-Hop | Soul'), X, splitValue)).toBeNull()
  expect(planTrackField(col(3, 'genre', null), X, splitValue)).toBeNull()
  // The DJ's own " | " scheme in grouping is untouched.
  expect(
    planTrackField(col(4, 'grouping', '00s | DANCE | PTY | PF | CLEANPTY'), X, splitValue)
  ).toBeNull()
})

test('linked tags are the source when a track has them', () => {
  const c = planTrackField(
    { trackId: 1, field: 'genre', column: 'stale', linked: ['Soul x Boogie x Jazz'] },
    X,
    splitValue
  )
  expect(c?.newTags).toEqual(['Soul', 'Boogie', 'Jazz'])
  expect(c?.prevTags).toEqual(['Soul x Boogie x Jazz'])
})

test('chosen spellings apply inside splits and to values that were never combined', () => {
  const rules = rulesFromChoices({
    delimiters: [{ field: 'genre', delimiter: ' x ' }],
    spellings: [
      { field: 'genre', canonical: 'RnB', variants: ['R&B', 'r&b'] },
      { field: 'genre', canonical: 'Hip Hop', variants: ['hip hop', 'HIp Hop', 'Hip-Hop'] }
    ],
    typos: [],
    exact: []
  })
  expect(planTrackField(col(1, 'genre', 'hip hop x r&b'), rules, splitValue)?.newTags).toEqual([
    'Hip Hop',
    'RnB'
  ])
  const standalone = planTrackField(col(2, 'genre', 'Hip-Hop | R&B'), rules, splitValue)
  expect(standalone).toMatchObject({ newTags: ['Hip Hop', 'RnB'], kind: 'spelling' })
  expect(planTrackField(col(3, 'genre', 'R&B'), rules, splitValue)?.newTags).toEqual(['RnB'])
  // Exactly as chosen: no title-casing to "Rnb".
  expect(planTrackField(col(4, 'genre', 'Soul'), rules, splitValue)).toBeNull()
})

test('a value repeated after splitting appears once', () => {
  const rules = rulesFromChoices({
    delimiters: [{ field: 'genre', delimiter: ' x ' }],
    spellings: [{ field: 'genre', canonical: 'Hip Hop', variants: ['Hip-Hop'] }],
    typos: [],
    exact: []
  })
  expect(planTrackField(col(1, 'genre', 'Hip Hop x Hip-Hop'), rules, splitValue)?.newTags).toEqual([
    'Hip Hop'
  ])
})

test('exact-value rules split space-joined comment badges', () => {
  const rules = rulesFromChoices({
    delimiters: [],
    spellings: [],
    typos: [],
    exact: [
      { field: 'comment', value: 'GOTOS HEADZ', result: ['GOTOS', 'HEADZ'] },
      {
        field: 'comment',
        value: 'GOTOS HEADZ SENDOFF INTRO',
        result: ['GOTOS', 'HEADZ', 'SENDOFF INTRO']
      }
    ]
  })
  expect(planTrackField(col(1, 'comment', 'GOTOS HEADZ '), rules, splitValue)).toMatchObject({
    newTags: ['GOTOS', 'HEADZ'],
    kind: 'exact'
  })
  expect(
    planTrackField(col(2, 'comment', 'GOTOS HEADZ SENDOFF INTRO'), rules, splitValue)?.newTags
  ).toEqual(['GOTOS', 'HEADZ', 'SENDOFF INTRO'])
  expect(planTrackField(col(3, 'comment', 'GOTOS'), rules, splitValue)).toBeNull()
})

test('exact proposals: preselected only when every word is a known badge', () => {
  const values = [
    ...Array(324).fill('GOTOS'),
    ...Array(39).fill('HEADZ'),
    ...Array(2).fill('SENDOFF'),
    ...Array(16).fill('GOTOS HEADZ'),
    'GOTOS HEADZ SENDOFF INTRO',
    'FUNKY HOUSE',
    'www.beatjunkies.com',
    'What U Think All The Gunz Is'
  ]
  const p = findExactProposals('comment', values)
  expect(p.map((x) => [x.value, x.preselected])).toEqual([
    ['GOTOS HEADZ', true],
    ['GOTOS HEADZ SENDOFF INTRO', false] // INTRO is not a badge on its own
  ])
  expect(p[1].result).toEqual(['GOTOS', 'HEADZ', 'SENDOFF', 'INTRO'])
})

test('spelling groups: case, hyphens, spaces and the ways of writing R&B', () => {
  const groups = findSpellingGroups('genre', [
    ...Array(155).fill('Hip Hop'),
    ...Array(7).fill('hip hop'),
    'HIp Hop',
    'HIp Hop',
    'Hip-Hop',
    ...Array(115).fill('R&B'),
    'r&b',
    'RnB',
    'Mash Ups',
    'Mashups',
    'Soul'
  ])
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.spellings.map((s) => s.value)]))
  expect(byKey['hiphop']).toEqual(['Hip Hop', 'hip hop', 'HIp Hop', 'Hip-Hop'])
  expect(byKey['r&b']).toEqual(['R&B', 'RnB', 'r&b'])
  expect(byKey['mashups']).toEqual(['Mash Ups', 'Mashups'])
  expect(byKey['soul']).toBeUndefined()
})

test('typos: a rare value one letter from a common one', () => {
  const t = findTypos('genre', [
    ...Array(44).fill('House'),
    'Hpuse',
    ...Array(167).fill('Hip Hop'),
    'Hip Hip',
    ...Array(2).fill('Line'),
    ...Array(7).fill('Rock'),
    'Edit'
  ])
  expect(t.map((x) => `${x.from}→${x.to}`)).toEqual(['Hip Hip→Hip Hop', 'Hpuse→House'])
})

test('a typo fix follows the chosen spelling of its target', () => {
  const rules = rulesFromChoices({
    delimiters: [],
    spellings: [{ field: 'genre', canonical: 'House', variants: ['house'] }],
    typos: [{ field: 'genre', from: 'Hpuse', to: 'house' }],
    exact: []
  })
  expect(rules.rewrites.genre?.['hpuse']).toEqual(['House'])
})

test('groups: same original value and result together, biggest first', () => {
  const changes = [
    ...[1, 2, 3].map((id) => col(id, 'genre', 'Hip Hop x Twerk')),
    col(4, 'genre', 'Hip Hop x R&B'),
    col(5, 'genre', 'hip hop x r&b')
  ]
    .map((c) => planTrackField(c, X, splitValue)!)
    .filter(Boolean)
  const groups = groupChanges(changes, (c) => c.prevColumn ?? '')
  expect(groups.map((g) => [g.label, g.trackIds.length, g.result.join(',')])).toEqual([
    ['Hip Hop x Twerk', 3, 'Hip Hop,Twerk'],
    // Different results until a spelling is chosen.
    ['Hip Hop x R&B', 1, 'Hip Hop,R&B'],
    ['hip hop x r&b', 1, 'hip hop,r&b']
  ])
})

test('saved rules merge with new ones; the new spelling wins', () => {
  const saved: CleanupRules = {
    delimiters: { genre: [' x '] },
    rewrites: { genre: { 'r&b': ['R&B'] } }
  }
  const next: CleanupRules = { delimiters: {}, rewrites: { genre: { 'r&b': ['RnB'] } } }
  expect(mergeRules(saved, next)).toEqual({
    delimiters: { genre: [' x '] },
    rewrites: { genre: { 'r&b': ['RnB'] } }
  })
  expect(mergeRules(NO_RULES, NO_RULES)).toEqual(NO_RULES)
})

test('values no rule touches are kept exactly, even beside ones that change', () => {
  const stamp = 'www.BEATJUNKIES.com\n@thebeatjunkies (IG)'
  const rules = rulesFromChoices({
    delimiters: [],
    spellings: [],
    typos: [],
    exact: [{ field: 'comment', value: 'GOTOS HEADZ', result: ['GOTOS', 'HEADZ'] }]
  })
  // Nothing to change: not even whitespace is tidied.
  expect(planTrackField(col(1, 'comment', stamp), rules, splitValue)).toBeNull()
  expect(
    planTrackField(col(2, 'comment', 'www.directmusicservice.com  3A'), rules, splitValue)
  ).toBeNull()
  expect(planTrackField(col(3, 'genre', 'Hip Hop | Hip-Hop'), X, splitValue)).toBeNull()
  // Changed beside an untouched stamp: the stamp survives verbatim.
  expect(
    planTrackField(col(4, 'comment', `GOTOS HEADZ | ${stamp}`), rules, splitValue)?.newTags
  ).toEqual(['GOTOS', 'HEADZ', stamp])
})

test('the canary takes one mp3, one m4a and one wav, then tops up', () => {
  const items = ['/a/1.mp3', '/a/2.mp3', '/a/3.MP3', '/a/4.M4A', '/a/5.wav', '/a/6.m4a'].map(
    (filepath) => ({ filepath })
  )
  expect(pickCanary(items).map((i) => i.filepath)).toEqual(['/a/1.mp3', '/a/4.M4A', '/a/5.wav'])
  // A batch with no wav: still three files.
  expect(pickCanary(items.slice(0, 4)).map((i) => i.filepath)).toEqual([
    '/a/1.mp3',
    '/a/4.M4A',
    '/a/2.mp3'
  ])
  expect(pickCanary([])).toEqual([])
})
