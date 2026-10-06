import { test, expect } from '@playwright/test'
import {
  applySelection,
  rangeSelection,
  selectAll,
  toggleSelection
} from '../../src/renderer/src/lib/selection'

// Covers what a click on a selection checkbox does. The rules that matter
// are the ones a DJ would notice: a shift-click spans from the last plain
// click, it adds to what is already selected rather than replacing it, and
// it means the same thing in a grid as in a list because both render the
// same ordered array.

const ORDER = [10, 20, 30, 40, 50]
const NONE: ReadonlySet<number> = new Set()

function ids(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b)
}

// ── Toggle ────────────────────────────────────────────────────────────────

test('a plain click selects, and clicking the same track again deselects', () => {
  const once = toggleSelection(NONE, 30)
  expect(ids(once)).toEqual([30])
  expect(ids(toggleSelection(once, 30))).toEqual([])
})

test('toggling does not mutate the set it was given', () => {
  const prev = new Set([10])
  toggleSelection(prev, 20)
  expect(ids(prev)).toEqual([10])
})

// ── Select all ────────────────────────────────────────────────────────────

test('select all takes the whole array it is handed, not just what is on screen', () => {
  expect(ids(selectAll(ORDER))).toEqual(ORDER)
})

// ── Range ─────────────────────────────────────────────────────────────────

test('a shift-click selects the inclusive span between anchor and target', () => {
  expect(ids(rangeSelection(NONE, ORDER, 20, 40))).toEqual([20, 30, 40])
})

test('the span is the same whether the target is below the anchor or above it', () => {
  expect(ids(rangeSelection(NONE, ORDER, 40, 20))).toEqual([20, 30, 40])
})

test('a range adds to the existing selection rather than replacing it', () => {
  const prev = new Set([10])
  expect(ids(rangeSelection(prev, ORDER, 30, 40))).toEqual([10, 30, 40])
})

test('a range onto itself is just that one track', () => {
  expect(ids(rangeSelection(NONE, ORDER, 30, 30))).toEqual([30])
})

test('with no anchor yet, a shift-click behaves as a plain click', () => {
  expect(ids(rangeSelection(NONE, ORDER, null, 30))).toEqual([30])
})

test('an anchor that has been filtered out of view degrades to a plain click', () => {
  // The anchored track can vanish from orderedIds when the tab, the search
  // or the BPM filter changes under a selection.
  expect(ids(rangeSelection(NONE, ORDER, 999, 30))).toEqual([30])
})

// ── applySelection: the whole decision behind one click ───────────────────

test('a plain click becomes the anchor for the next shift-click', () => {
  const first = applySelection(NONE, ORDER, 20, undefined, null)
  expect(first.anchorId).toBe(20)

  const second = applySelection(first.selected, ORDER, 40, { shift: true }, first.anchorId)
  expect(ids(second.selected)).toEqual([20, 30, 40])
})

test('a shift-click leaves the anchor where it was, so the next one re-spans from it', () => {
  const first = applySelection(NONE, ORDER, 30, undefined, null)
  const second = applySelection(first.selected, ORDER, 50, { shift: true }, first.anchorId)
  expect(second.anchorId).toBe(30)

  // Re-spanning the other way from the same origin, not from 50.
  const third = applySelection(second.selected, ORDER, 10, { shift: true }, second.anchorId)
  expect(third.selected.has(20)).toBe(true)
  expect(third.anchorId).toBe(30)
})

test('an explicitly unshifted click is a plain toggle', () => {
  const first = applySelection(NONE, ORDER, 20, { shift: false }, null)
  const second = applySelection(first.selected, ORDER, 40, { shift: false }, first.anchorId)
  expect(ids(second.selected)).toEqual([20, 40])
  expect(second.anchorId).toBe(40)
})

test('an anchorless shift-click becomes the anchor itself', () => {
  const result = applySelection(NONE, ORDER, 30, { shift: true }, null)
  expect(ids(result.selected)).toEqual([30])
  expect(result.anchorId).toBe(30)
})

test('the same two clicks span the same tracks in grid order as in list order', () => {
  // A grid is the same ordered array laid out row-major: with three
  // columns, 10 20 30 / 40 50. Clicking 20 then shift-clicking 40 spans
  // across the row break, which is exactly the list span.
  const list = applySelection(NONE, ORDER, 20, undefined, null)
  const listRange = applySelection(list.selected, ORDER, 40, { shift: true }, list.anchorId)

  const gridOrder = [...ORDER]
  const grid = applySelection(NONE, gridOrder, 20, undefined, null)
  const gridRange = applySelection(grid.selected, gridOrder, 40, { shift: true }, grid.anchorId)

  expect(ids(gridRange.selected)).toEqual(ids(listRange.selected))
})
