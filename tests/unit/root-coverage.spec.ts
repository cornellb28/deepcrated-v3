import { test, expect } from '@playwright/test'
import { classifyFolder, type RootRef } from '../../src/main/rootCoverage'

// Whether a folder picked for import is already in the library
// (src/main/rootCoverage.ts).

const roots: RootRef[] = [
  { id: 1, name: 'Dj Rasta Root Edits', path: '/Volumes/MUSICLITE/Dj Rasta Root Edits' },
  { id: 6, name: '00s', path: '/Volumes/MUSICLITE/CAPITALRECORDS/00s' }
]

test('a watched folder itself', () => {
  expect(classifyFolder('/Volumes/MUSICLITE/CAPITALRECORDS/00s', roots)).toEqual({
    status: 'watched',
    root: roots[1],
    isRoot: true
  })
  // Trailing slash: still the same folder.
  expect(classifyFolder('/Volumes/MUSICLITE/CAPITALRECORDS/00s/', roots)).toMatchObject({
    status: 'watched',
    isRoot: true
  })
})

test('a folder inside a watched folder', () => {
  expect(classifyFolder('/Volumes/MUSICLITE/CAPITALRECORDS/00s/_Hip Hop', roots)).toEqual({
    status: 'watched',
    root: roots[1],
    isRoot: false
  })
})

test('a parent of watched folders', () => {
  expect(classifyFolder('/Volumes/MUSICLITE/CAPITALRECORDS', roots)).toEqual({
    status: 'contains',
    roots: [roots[1]]
  })
  expect(classifyFolder('/Volumes/MUSICLITE', roots)).toEqual({ status: 'contains', roots })
})

test('a new folder, including one that only shares a name prefix', () => {
  expect(classifyFolder('/Volumes/MUSICLITE/big 10', roots)).toEqual({ status: 'new' })
  // "00s-extra" is not inside "00s".
  expect(classifyFolder('/Volumes/MUSICLITE/CAPITALRECORDS/00s-extra', roots)).toEqual({
    status: 'new'
  })
  expect(classifyFolder('/anything', [])).toEqual({ status: 'new' })
})
