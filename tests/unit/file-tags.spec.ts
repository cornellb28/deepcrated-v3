import { test, expect } from '@playwright/test'
import {
  composeFileGrouping,
  fieldFeedsGrouping,
  fileTagDifferences,
  intendedFileTags,
  normalizeTagText
} from '../../src/main/fileTags'

// The rules for what a file's tags should say so Serato shows DeepCrated's
// values (main/fileTags.ts).

const mp3 = '/Volumes/MUSIC/a.mp3'
const m4a = '/Volumes/MUSIC/a.m4a'
const wav = '/Volumes/MUSIC/a.WAV'

// ── Grouping carries what Serato has no column for ────────────────────────

test('grouping alone is written as-is, " | " joined', () => {
  expect(composeFileGrouping({ filepath: mp3, grouping: '90s | CLASSIC' })).toBe('90s | CLASSIC')
  // The legacy " / " is read and rewritten with " | ".
  expect(composeFileGrouping({ filepath: mp3, grouping: '90s / CLASSIC' })).toBe('90s | CLASSIC')
})

test('vibe, venue and custom tags are added to grouping, after it', () => {
  expect(
    composeFileGrouping({ filepath: mp3, grouping: 'CLASSIC', extras: ['DARK', 'Warehouse'] })
  ).toBe('CLASSIC | DARK | Warehouse')
  expect(composeFileGrouping({ filepath: mp3, extras: ['DARK'] })).toBe('DARK')
})

test('on an MP3, label and remixer stay in their own frames, not grouping', () => {
  expect(
    composeFileGrouping({ filepath: mp3, grouping: 'CLASSIC', label: 'DEF JAM', remixer: 'PETE' })
  ).toBe('CLASSIC')
})

test('on M4A and WAV, label and remixer are added to grouping too', () => {
  for (const filepath of [m4a, wav]) {
    expect(
      composeFileGrouping({
        filepath,
        grouping: 'CLASSIC',
        label: 'DEF JAM | BAD BOY',
        remixer: 'PETE',
        extras: ['DARK']
      }),
      filepath
    ).toBe('CLASSIC | DARK | DEF JAM | BAD BOY | PETE')
  }
})

test('repeats are dropped case-insensitively, keeping the first spelling', () => {
  expect(
    composeFileGrouping({
      filepath: m4a,
      grouping: 'Classic',
      label: 'CLASSIC',
      extras: ['classic']
    })
  ).toBe('Classic')
})

test('nothing to put in grouping is null, never an empty string', () => {
  expect(composeFileGrouping({ filepath: mp3 })).toBeNull()
  expect(composeFileGrouping({ filepath: mp3, grouping: '  ', extras: [] })).toBeNull()
})

test('which changes mean grouping must be rewritten', () => {
  expect(fieldFeedsGrouping('grouping', mp3)).toBe(true)
  expect(fieldFeedsGrouping('vibe', mp3)).toBe(true)
  expect(fieldFeedsGrouping('venue', mp3)).toBe(true)
  expect(fieldFeedsGrouping('custom', mp3)).toBe(true)
  expect(fieldFeedsGrouping('label', mp3)).toBe(false)
  expect(fieldFeedsGrouping('label', m4a)).toBe(true)
  expect(fieldFeedsGrouping('remixer', wav)).toBe(true)
  expect(fieldFeedsGrouping('genre', m4a)).toBe(false)
})

// ── What the file should say, and what is out of step ─────────────────────

test('the intended tags cover all eight Serato columns, empty where DeepCrated is', () => {
  const intended = intendedFileTags({
    filepath: m4a,
    artist: 'ATCQ | VLVT JONES',
    genre: 'Hip-Hop',
    label: 'SERATOCOLLECTION',
    grouping: 'CLASSIC'
  })
  expect(intended).toEqual({
    artist: 'ATCQ | VLVT JONES',
    album: '',
    genre: 'Hip-Hop',
    comment: '',
    label: 'SERATOCOLLECTION',
    remixer: '',
    composer: '',
    grouping: 'CLASSIC | SERATOCOLLECTION'
  })
})

test('a different value, a new separator or a missing value is out of step', () => {
  const intended = intendedFileTags({
    filepath: mp3,
    artist: 'ATCQ | VLVT JONES',
    genre: 'Hip-Hop',
    label: 'DEF JAM'
  })
  const { differences } = fileTagDifferences(intended, {
    artist: 'ATCQ / VLVT JONES',
    genre: 'Hip Hop',
    label: ''
  })
  expect(differences).toEqual([
    { field: 'artist', inFile: 'ATCQ / VLVT JONES', deepcrated: 'ATCQ | VLVT JONES' },
    { field: 'genre', inFile: 'Hip Hop', deepcrated: 'Hip-Hop' },
    { field: 'label', inFile: '', deepcrated: 'DEF JAM' }
  ])
})

test('a value only the file has is never listed for writing, only counted', () => {
  const intended = intendedFileTags({ filepath: mp3, artist: 'A' })
  const { differences, fileOnly } = fileTagDifferences(intended, {
    artist: 'A',
    comment: 'typed in iTunes',
    genre: 'Other'
  })
  expect(differences).toEqual([])
  expect(fileOnly.sort()).toEqual(['comment', 'genre'])
})

test('spacing differences alone are not out of step', () => {
  expect(normalizeTagText('  Hip  Hop\u0000 ')).toBe('Hip Hop')
  const intended = intendedFileTags({ filepath: mp3, genre: 'Hip Hop' })
  expect(fileTagDifferences(intended, { genre: 'Hip  Hop ' }).differences).toEqual([])
})
