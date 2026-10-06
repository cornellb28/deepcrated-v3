import { test, expect } from '@playwright/test'
import {
  allCrateIds,
  ancestorsOfMembership,
  buildCrateTree,
  crateMembership,
  filterCrateTree,
  flattenCrateTree,
  type CrateNode
} from '../../src/renderer/src/lib/crateTree'

// Covers the shaping behind the "Add to crate" picker: which crates it
// shows, in what order, at what depth, and how a bulk selection's
// membership is summarised.

function crate(id: number, name: string, parent: number | null = null): Crate {
  return {
    id,
    name,
    color: '#7f77dd',
    parent_crate_id: parent,
    created_at: 0,
    updated_at: 0,
    last_exported_at: null,
    track_count: 0
  }
}

// Hip Hop > 90s > Boom Bap / Golden Era, House > Deep, Warmup
const LIBRARY: Crate[] = [
  crate(1, 'Hip Hop'),
  crate(2, '90s', 1),
  crate(3, 'Boom Bap', 2),
  crate(4, 'Golden Era', 2),
  crate(5, 'House'),
  crate(6, 'Deep', 5),
  crate(7, 'Warmup')
]

function names(nodes: CrateNode[]): string[] {
  return nodes.map((n) => n.name)
}

// ── Building ──────────────────────────────────────────────────────────────

test('crates nest under their parent and sort by name at every level', () => {
  const tree = buildCrateTree(LIBRARY)
  expect(names(tree)).toEqual(['Hip Hop', 'House', 'Warmup'])
  expect(names(tree[0].children)).toEqual(['90s'])
  expect(names(tree[0].children[0].children)).toEqual(['Boom Bap', 'Golden Era'])
})

test('an empty library builds an empty tree', () => {
  expect(buildCrateTree([])).toEqual([])
})

test('a crate whose parent no longer exists surfaces at the top level', () => {
  // Better visible and mis-placed than invisible and unreachable.
  const tree = buildCrateTree([crate(1, 'Orphan', 99)])
  expect(names(tree)).toEqual(['Orphan'])
})

test('building does not mutate the crates it was given', () => {
  const input = [crate(1, 'Parent'), crate(2, 'Child', 1)]
  const snapshot = JSON.parse(JSON.stringify(input))
  buildCrateTree(input)
  expect(input).toEqual(snapshot)
})

// ── Filtering ─────────────────────────────────────────────────────────────

test('a match keeps the ancestors needed to reach it', () => {
  const filtered = filterCrateTree(buildCrateTree(LIBRARY), 'boom')
  expect(names(filtered)).toEqual(['Hip Hop'])
  expect(names(filtered[0].children)).toEqual(['90s'])
  expect(names(filtered[0].children[0].children)).toEqual(['Boom Bap'])
})

test('a parent that matches keeps its children', () => {
  const filtered = filterCrateTree(buildCrateTree(LIBRARY), 'house')
  expect(names(filtered)).toEqual(['House'])
  expect(names(filtered[0].children)).toEqual(['Deep'])
})

test('matching ignores case and surrounding whitespace', () => {
  expect(names(filterCrateTree(buildCrateTree(LIBRARY), '  WARMUP  '))).toEqual(['Warmup'])
})

test('an empty query returns the tree untouched', () => {
  const tree = buildCrateTree(LIBRARY)
  expect(filterCrateTree(tree, '   ')).toBe(tree)
})

test('a query matching nothing returns nothing', () => {
  expect(filterCrateTree(buildCrateTree(LIBRARY), 'techno')).toEqual([])
})

test('filtering does not mutate the tree it was given', () => {
  const tree = buildCrateTree(LIBRARY)
  const snapshot = JSON.parse(JSON.stringify(tree))
  filterCrateTree(tree, 'boom')
  expect(JSON.parse(JSON.stringify(tree))).toEqual(snapshot)
})

// ── Flattening ────────────────────────────────────────────────────────────

test('a collapsed tree flattens to its top level only', () => {
  const rows = flattenCrateTree(buildCrateTree(LIBRARY), new Set())
  expect(rows.map((r) => r.node.name)).toEqual(['Hip Hop', 'House', 'Warmup'])
  expect(rows.every((r) => r.depth === 0)).toBe(true)
})

test('expanding a crate reveals its children at the next depth', () => {
  const rows = flattenCrateTree(buildCrateTree(LIBRARY), new Set([1, 2]))
  expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
    ['Hip Hop', 0],
    ['90s', 1],
    ['Boom Bap', 2],
    ['Golden Era', 2],
    ['House', 0],
    ['Warmup', 0]
  ])
})

test('expanding a crate whose parent is collapsed reveals nothing', () => {
  const rows = flattenCrateTree(buildCrateTree(LIBRARY), new Set([2]))
  expect(rows.map((r) => r.node.name)).toEqual(['Hip Hop', 'House', 'Warmup'])
})

test('allCrateIds reaches every depth', () => {
  expect(allCrateIds(buildCrateTree(LIBRARY)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
})

// ── Which crates to open with ─────────────────────────────────────────────

test('the ancestors of a crate holding a track start expanded, but not the crate itself', () => {
  // Opening on Boom Bap should show Hip Hop > 90s > Boom Bap, without
  // expanding Boom Bap's own children.
  const members = new Map([[3, new Set([10])]])
  expect(ancestorsOfMembership(LIBRARY, members, [10])).toEqual(new Set([1, 2]))
})

test('a crate holding none of the tracks contributes nothing', () => {
  const members = new Map([[3, new Set([99])]])
  expect(ancestorsOfMembership(LIBRARY, members, [10])).toEqual(new Set())
})

test('a top-level crate has no ancestors to expand', () => {
  const members = new Map([[7, new Set([10])]])
  expect(ancestorsOfMembership(LIBRARY, members, [10])).toEqual(new Set())
})

test('a parent cycle does not hang the walk', () => {
  const cyclic = [crate(1, 'A', 2), crate(2, 'B', 1)]
  const members = new Map([[1, new Set([10])]])
  expect(ancestorsOfMembership(cyclic, members, [10])).toEqual(new Set([1, 2]))
})

// ── Membership ────────────────────────────────────────────────────────────

test('every track present reads as all', () => {
  expect(crateMembership(new Set([1, 2, 3]), [1, 2])).toBe('all')
})

test('part of the selection present reads as some', () => {
  expect(crateMembership(new Set([1]), [1, 2])).toBe('some')
})

test('none of the selection present reads as none', () => {
  expect(crateMembership(new Set([9]), [1, 2])).toBe('none')
})

test('an empty or unknown crate reads as none', () => {
  expect(crateMembership(undefined, [1])).toBe('none')
  expect(crateMembership(new Set(), [1])).toBe('none')
})

test('an empty selection reads as none rather than vacuously all', () => {
  expect(crateMembership(new Set([1, 2]), [])).toBe('none')
})
