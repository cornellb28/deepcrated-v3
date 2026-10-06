import { test, expect } from '@playwright/test'
import { sep } from 'path'
import { isUnchanged, normalizeMtime, withTrailingSep, folderInScope } from '../../src/main/rescan'

// The pure decisions a rescan makes before it touches the database: which
// walked files can skip the expensive tag read, and which folder rows a
// given scan is entitled to judge.

type Known = Parameters<typeof isUnchanged>[0]

function known(overrides: Partial<NonNullable<Known>> = {}): NonNullable<Known> {
  return {
    id: 1,
    filepath: '/music/Track.mp3',
    file_size_bytes: 1000,
    last_modified: 1_700_000_000_000,
    missing: 0,
    ...overrides
  }
}

test('an identical size and mtime means the file can be skipped', () => {
  expect(isUnchanged(known(), { size: 1000, mtimeMs: 1_700_000_000_000 })).toBe(true)
})

test('a changed size means the file is re-read', () => {
  expect(isUnchanged(known(), { size: 1001, mtimeMs: 1_700_000_000_000 })).toBe(false)
})

test('a changed mtime means the file is re-read', () => {
  expect(isUnchanged(known(), { size: 1000, mtimeMs: 1_700_000_000_001 })).toBe(false)
})

// The realistic case: a DJ edits tags in Serato, which rewrites the file in
// place. Size may or may not move, mtime always does.
test('an in-place tag edit is not mistaken for an unchanged file', () => {
  expect(isUnchanged(known(), { size: 1000, mtimeMs: Date.now() })).toBe(false)
})

test('a row with no recorded mtime is always re-read', () => {
  expect(isUnchanged(known({ last_modified: null }), { size: 1000, mtimeMs: 1 })).toBe(false)
})

test('a row with no recorded size is always re-read', () => {
  expect(isUnchanged(known({ file_size_bytes: null }), { size: 1000, mtimeMs: 1 })).toBe(false)
})

test('a file with no row at all is never skipped', () => {
  expect(isUnchanged(undefined, { size: 1000, mtimeMs: 1 })).toBe(false)
})

test('a file that could not be stat-ed is never skipped', () => {
  expect(isUnchanged(known(), null)).toBe(false)
})

// mtimeMs arrives fractional on some filesystems; the column is an INTEGER.
// Both sides must floor through the same function or every scan looks like
// a change.
test('a fractional mtime compares equal to its stored whole-millisecond form', () => {
  expect(normalizeMtime(1_700_000_000_000.7)).toBe(1_700_000_000_000)
  expect(isUnchanged(known(), { size: 1000, mtimeMs: 1_700_000_000_000.7 })).toBe(true)
})

test('a prefix always ends in a separator so sibling paths cannot collide', () => {
  expect(withTrailingSep('/music')).toBe(`/music${sep}`)
  expect(withTrailingSep(`/music${sep}`)).toBe(`/music${sep}`)
  // The reason it matters: "/music" must not prefix-match "/music-archive".
  expect(`/music-archive${sep}x.mp3`.startsWith(withTrailingSep('/music'))).toBe(false)
})

test('a scan of the root itself may judge every folder under it', () => {
  expect(folderInScope('', '')).toBe(true)
  expect(folderInScope('House', '')).toBe(true)
  expect(folderInScope(`House${sep}Deep`, '')).toBe(true)
})

test('a scan of one subfolder may judge only that subtree', () => {
  expect(folderInScope('House', 'House')).toBe(true)
  expect(folderInScope(`House${sep}Deep`, 'House')).toBe(true)
  expect(folderInScope('Techno', 'House')).toBe(false)
})

// The same sibling-prefix trap as withTrailingSep, one level down: a rescan
// of "House" must not sweep "House Classics".
test('a sibling folder sharing a name prefix is out of scope', () => {
  expect(folderInScope('House Classics', 'House')).toBe(false)
})
