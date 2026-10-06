import { test, expect } from '@playwright/test'
import {
  allFolderPaths,
  displayPath,
  filterFolderTree,
  findNode,
  flattenFolderTree,
  formatBytes,
  makeNode,
  parentDirectory,
  setNodeChildren,
  type FolderNode
} from '../../src/renderer/src/lib/folderTree'

// Covers the shaping behind the "Move to…" destination picker. Folders are
// read from disk lazily, so the distinction these tests care most about is
// children === null ("not loaded") versus [] ("loaded, and empty").

function tree(): FolderNode[] {
  const boom = makeNode('Boom', '/vol/lib/Edits/Boom')
  const soul = makeNode('Soul', '/vol/lib/Edits/Soul')
  const edits: FolderNode = { ...makeNode('Edits', '/vol/lib/Edits'), children: [boom, soul] }
  const acapellas = makeNode('Acapellas', '/vol/lib/Acapellas') // children: null
  const root: FolderNode = {
    ...makeNode('lib', '/vol/lib', true),
    children: [acapellas, edits]
  }
  return [root]
}

const ROOTS = [
  { name: 'lib', path: '/vol/lib' },
  { name: 'Archive', path: '/vol/lib/Archive' }
]

function names(nodes: FolderNode[]): string[] {
  return nodes.map((n) => n.name)
}

// ── Loading children ──────────────────────────────────────────────────────

test('children are attached to the node with the matching path', () => {
  const updated = setNodeChildren(tree(), '/vol/lib/Acapellas', [
    makeNode('Vocals', '/vol/lib/Acapellas/Vocals')
  ])
  expect(findNode(updated, '/vol/lib/Acapellas')?.children?.map((c) => c.name)).toEqual(['Vocals'])
})

test('attaching children deep in the tree leaves the rest alone', () => {
  const before = tree()
  const updated = setNodeChildren(before, '/vol/lib/Edits/Boom', [])
  expect(findNode(updated, '/vol/lib/Edits/Boom')?.children).toEqual([])
  expect(findNode(updated, '/vol/lib/Edits/Soul')?.children).toBeNull()
  expect(before).toEqual(tree()) // input untouched
})

test('an unknown path returns the same array, so React can skip the render', () => {
  const before = tree()
  expect(setNodeChildren(before, '/somewhere/else', [])).toBe(before)
})

test('an empty children array means loaded and empty, not unloaded', () => {
  const updated = setNodeChildren(tree(), '/vol/lib/Acapellas', [])
  const node = findNode(updated, '/vol/lib/Acapellas')
  expect(node?.children).toEqual([])
  expect(node?.children).not.toBeNull()
})

test('findNode reaches every depth and returns null for a miss', () => {
  expect(findNode(tree(), '/vol/lib/Edits/Soul')?.name).toBe('Soul')
  expect(findNode(tree(), '/vol/nope')).toBeNull()
})

// ── Filtering ─────────────────────────────────────────────────────────────

test('a match keeps the ancestors needed to reach it', () => {
  const filtered = filterFolderTree(tree(), 'boom')
  expect(names(filtered)).toEqual(['lib'])
  expect(names(filtered[0].children ?? [])).toEqual(['Edits'])
  expect(names(filtered[0].children?.[0].children ?? [])).toEqual(['Boom'])
})

test('a folder that matches keeps all of its children', () => {
  const filtered = filterFolderTree(tree(), 'edits')
  const edits = filtered[0].children?.[0]
  expect(edits?.name).toBe('Edits')
  expect(names(edits?.children ?? [])).toEqual(['Boom', 'Soul'])
})

test('matching ignores case and surrounding whitespace', () => {
  expect(filterFolderTree(tree(), '  SOUL ')).toHaveLength(1)
})

test('an empty query returns the tree untouched', () => {
  const t = tree()
  expect(filterFolderTree(t, '  ')).toBe(t)
})

test('a folder whose children are not loaded can still match on its own name', () => {
  const filtered = filterFolderTree(tree(), 'acap')
  expect(names(filtered[0].children ?? [])).toEqual(['Acapellas'])
})

test('a query matching nothing returns nothing', () => {
  expect(filterFolderTree(tree(), 'techno')).toEqual([])
})

// ── Flattening ────────────────────────────────────────────────────────────

test('a collapsed tree flattens to its roots only', () => {
  const rows = flattenFolderTree(tree(), new Set())
  expect(rows.map((r) => r.node.name)).toEqual(['lib'])
})

test('expanding reveals children at the next depth', () => {
  const rows = flattenFolderTree(tree(), new Set(['/vol/lib', '/vol/lib/Edits']))
  expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
    ['lib', 0],
    ['Acapellas', 1],
    ['Edits', 1],
    ['Boom', 2],
    ['Soul', 2]
  ])
})

test('expanding a folder whose children are not loaded yields just that row', () => {
  const rows = flattenFolderTree(tree(), new Set(['/vol/lib', '/vol/lib/Acapellas']))
  expect(rows.map((r) => r.node.name)).toEqual(['lib', 'Acapellas', 'Edits'])
})

test('allFolderPaths reaches every loaded depth', () => {
  expect(allFolderPaths(tree()).sort()).toEqual(
    [
      '/vol/lib',
      '/vol/lib/Acapellas',
      '/vol/lib/Edits',
      '/vol/lib/Edits/Boom',
      '/vol/lib/Edits/Soul'
    ].sort()
  )
})

// ── Paths ─────────────────────────────────────────────────────────────────

test('a destination is shown relative to the root that contains it', () => {
  expect(displayPath('/vol/lib/Edits/Boom', ROOTS)).toBe('lib / Edits / Boom')
})

test('a root itself shows as just its name', () => {
  expect(displayPath('/vol/lib', ROOTS)).toBe('lib')
})

test('the most specific root wins when roots are nested', () => {
  expect(displayPath('/vol/lib/Archive/2019', ROOTS)).toBe('Archive / 2019')
})

test('a path under no known root falls back to the raw path', () => {
  expect(displayPath('/elsewhere/Music', ROOTS)).toBe('/elsewhere/Music')
})

test('a sibling root whose path is a string prefix is not mistaken for a parent', () => {
  // "/vol/library" must not match the root "/vol/lib".
  expect(displayPath('/vol/library/Thing', ROOTS)).toBe('/vol/library/Thing')
})

test('parentDirectory returns the folder a file sits in', () => {
  expect(parentDirectory('/vol/lib/GEK/track.mp3')).toBe('/vol/lib/GEK')
  expect(parentDirectory('/track.mp3')).toBe('/')
})

// ── Sizes ─────────────────────────────────────────────────────────────────

test('sizes are formatted at a useful precision', () => {
  expect(formatBytes(0)).toBe('')
  expect(formatBytes(2048)).toBe('2 KB')
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB')
  expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
})

test('a missing size formats to nothing rather than "0 MB"', () => {
  expect(formatBytes(Number.NaN)).toBe('')
  expect(formatBytes(-1)).toBe('')
})
