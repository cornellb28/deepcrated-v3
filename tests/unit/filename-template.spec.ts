import { test, expect } from '@playwright/test'
import {
  DEFAULT_TEMPLATE,
  TEMPLATE_PRESETS,
  TEMPLATE_TOKENS,
  buildFilename,
  renderTemplate,
  sanitizeSegment,
  tidy
} from '../../src/main/filenameTemplate'

// Renaming files is the one thing in this app that a DJ cannot undo from
// inside it — the old name is gone. So the rules get pinned hard, especially
// the tidying, which is where a dropped token leaves wreckage behind.

const foxy = {
  artist: 'Foxy Brown',
  title: 'Big Bad Mama',
  year: 1996,
  album: 'Ill Na Na',
  bpm: 94,
  key_camelot: '8A',
  filename: '01 - old name.mp3'
}

test('fills the tokens it knows', () => {
  expect(renderTemplate('%artist% - %title%', foxy)).toBe('Foxy Brown - Big Bad Mama')
  expect(renderTemplate('%artist% - %title% (%year%)', foxy)).toBe(
    'Foxy Brown - Big Bad Mama (1996)'
  )
  expect(renderTemplate('%title% [%key% %bpm%]', foxy)).toBe('Big Bad Mama [8A 94]')
})

test('%original% is the current name without its extension', () => {
  // Lets a DJ prepend to what is already there rather than rebuild the name.
  expect(renderTemplate('%artist% - %original%', foxy)).toBe('Foxy Brown - 01 - old name')
})

test('a missing token takes its punctuation with it', () => {
  // The rule that matters most: a shorter name, never a broken one.
  const noYear = { ...foxy, year: null }
  expect(renderTemplate('%artist% - %title% (%year%)', noYear)).toBe('Foxy Brown - Big Bad Mama')

  const noArtist = { ...foxy, artist: null }
  expect(renderTemplate('%artist% - %title%', noArtist)).toBe('Big Bad Mama')

  const noRemixer = { ...foxy, remixer: null }
  expect(renderTemplate('%artist% - %remixer% - %title%', noRemixer)).toBe(
    'Foxy Brown - Big Bad Mama'
  )
})

test('empty brackets of every kind are removed', () => {
  const bare = { title: 'Big Bad Mama' }
  expect(renderTemplate('%title% (%year%)', bare)).toBe('Big Bad Mama')
  expect(renderTemplate('%title% [%key%]', bare)).toBe('Big Bad Mama')
  expect(renderTemplate('%title% {%genre%}', bare)).toBe('Big Bad Mama')
  // A bracket left holding only a separator.
  expect(tidy('Big Bad Mama ( - )')).toBe('Big Bad Mama')
})

test('an unknown token renders empty rather than literally', () => {
  // A typo must not put "%artsit%" into a filename.
  expect(renderTemplate('%artsit% - %title%', foxy)).toBe('Big Bad Mama')
})

test('path separators are replaced, not deleted', () => {
  // "AC/DC" has to stay readable. Deleting would give "ACDC", which is a
  // different name; replacing gives "AC-DC", which is recognisable.
  expect(sanitizeSegment('AC/DC')).toBe('AC-DC')
  expect(sanitizeSegment('Hip Hop: The Greatest')).toBe('Hip Hop- The Greatest')
  expect(renderTemplate('%artist%', { artist: 'AC/DC' })).toBe('AC-DC')
})

test('every character illegal in a filename is handled', () => {
  expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
})

test('an ampersand and a comma survive — they are legal in filenames', () => {
  // "Drum & Bass" and "Tyler, The Creator" must not be mangled.
  expect(sanitizeSegment('Drum & Bass')).toBe('Drum & Bass')
  expect(sanitizeSegment('Tyler, The Creator')).toBe('Tyler, The Creator')
})

test('a template that renders to nothing is a skip, not a file called ""', () => {
  const result = buildFilename('%artist% - %title%', { artist: null, title: null })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain('empty')
})

test('an empty template is refused', () => {
  const result = buildFilename('   ', foxy)
  expect(result.ok).toBe(false)
})

test('an over-long name is truncated to fit a filesystem component', () => {
  // APFS and ext4 cap a path component at 255 bytes. Truncating on
  // characters would still overflow on non-ASCII, so this is done in bytes.
  const long = buildFilename('%title%', { title: 'ü'.repeat(400) })
  expect(long.ok).toBe(true)
  if (long.ok) {
    expect(Buffer.byteLength(long.name, 'utf8')).toBeLessThanOrEqual(200)
    // And it must still be a whole string, not a half-written character.
    expect(long.name).not.toContain('�')
  }
})

test('leading and trailing punctuation is trimmed', () => {
  expect(tidy('  - Big Bad Mama -  ')).toBe('Big Bad Mama')
  expect(tidy('...Big Bad Mama...')).toBe('Big Bad Mama')
})

test('every preset renders, and the default is among the tokens we support', () => {
  for (const preset of TEMPLATE_PRESETS) {
    const result = buildFilename(preset.template, foxy)
    expect(result.ok, `${preset.label} produced nothing`).toBe(true)
  }
  expect(buildFilename(DEFAULT_TEMPLATE, foxy)).toEqual({
    ok: true,
    name: 'Foxy Brown - Big Bad Mama'
  })
  expect(TEMPLATE_TOKENS).toContain('artist')
  expect(TEMPLATE_TOKENS).toContain('key')
  expect(TEMPLATE_TOKENS).toContain('original')
})
