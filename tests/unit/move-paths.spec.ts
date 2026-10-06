import { test, expect } from '@playwright/test'
import {
  PARTIAL_PREFIX,
  isSameLocation,
  partialNameFor,
  resolveCollisionName,
  splitName,
  suffixedName
} from '../../src/main/movePaths'

// Naming is where a move quietly goes wrong. The two failure modes worth
// covering: a suffix landing after the extension (which breaks isAudio and
// every other tool that routes on it), and a collision resolving to a name
// that is itself already taken.

test('the suffix goes before the extension, not after', () => {
  expect(suffixedName('Track.mp3', 2)).toBe('Track (2).mp3')
  expect(suffixedName('Track.mp3', 2).endsWith('.mp3')).toBe(true)
})

test('n of 1 or less is the original name', () => {
  expect(suffixedName('Track.mp3', 1)).toBe('Track.mp3')
  expect(suffixedName('Track.mp3', 0)).toBe('Track.mp3')
})

test('a name with dots in it keeps only the real extension', () => {
  expect(splitName('Artist - Track (Club Mix).mp3')).toEqual({
    stem: 'Artist - Track (Club Mix)',
    ext: '.mp3'
  })
  expect(suffixedName('Artist - Track (Club Mix).mp3', 3)).toBe(
    'Artist - Track (Club Mix) (3).mp3'
  )
})

test('a file with no extension still suffixes sensibly', () => {
  expect(splitName('README')).toEqual({ stem: 'README', ext: '' })
  expect(suffixedName('README', 2)).toBe('README (2)')
})

test('a free name is returned untouched', () => {
  expect(resolveCollisionName('Track.mp3', () => false)).toBe('Track.mp3')
})

test('a taken name steps to (2)', () => {
  const taken = new Set(['Track.mp3'])
  expect(resolveCollisionName('Track.mp3', (c) => taken.has(c))).toBe('Track (2).mp3')
})

test('it keeps stepping past a run of existing suffixes', () => {
  // The case that a naive "append (2)" gets wrong.
  const taken = new Set(['Track.mp3', 'Track (2).mp3', 'Track (3).mp3'])
  expect(resolveCollisionName('Track.mp3', (c) => taken.has(c))).toBe('Track (4).mp3')
})

test('an exhausted series fails rather than looping forever', () => {
  expect(resolveCollisionName('Track.mp3', () => true, 5)).toBeNull()
})

test('the partial name is hidden, so chokidar never sees it as an add', () => {
  // libraryWatcher ignores /(^|[/\\])\../ — a partial copy must fall under
  // that or a half-written file would be imported as a track.
  expect(partialNameFor('Track.mp3').startsWith('.')).toBe(true)
  expect(partialNameFor('Track.mp3')).toBe(`${PARTIAL_PREFIX}Track.mp3`)
})

test('a file already in the destination is recognised as a no-op', () => {
  expect(isSameLocation('/music/House/Track.mp3', '/music/House')).toBe(true)
  expect(isSameLocation('/music/House/Track.mp3', '/music/House/')).toBe(true)
  expect(isSameLocation('/music/House/Track.mp3', '/music/Techno')).toBe(false)
  // "/music/House" must not look like the parent of "/music/House2".
  expect(isSameLocation('/music/House2/Track.mp3', '/music/House')).toBe(false)
})
