import { test, expect } from '@playwright/test'
import {
  restoreView,
  isRestorable,
  DEFAULT_VIEW,
  LAST_VIEW_KEY
} from '../../src/renderer/src/lib/lastView'

// Which view comes back after a reload. The failure modes here are all
// "the DJ reloads and lands somewhere useless", so the fallbacks matter
// more than the happy path.

test('a view that stands on its own is restored', () => {
  for (const view of ['dashboard', 'library', 'folders', 'settings']) {
    expect(restoreView(view)).toBe(view)
  }
})

// These only mean anything alongside a selected tag or crate, which is
// component state a reload throws away. Restoring them would drop the DJ
// onto empty chrome.
test('a view that needs a selection is not restored', () => {
  expect(restoreView('tags')).toBe(DEFAULT_VIEW)
  expect(restoreView('crates')).toBe(DEFAULT_VIEW)
})

test('nothing stored means the default', () => {
  expect(restoreView(null)).toBe(DEFAULT_VIEW)
  expect(restoreView(undefined)).toBe(DEFAULT_VIEW)
  expect(restoreView('')).toBe(DEFAULT_VIEW)
})

// The value outlives the build that wrote it: a renamed or removed view has
// to fall back rather than leave the app on a blank screen.
test('a stale or unknown value falls back instead of breaking', () => {
  // 'board' is the real case: the kanban view was removed, so an existing
  // install still has it stored in app_settings.
  expect(restoreView('board')).toBe(DEFAULT_VIEW)
  expect(isRestorable('board')).toBe(false)
  expect(restoreView('genre')).toBe(DEFAULT_VIEW)
  expect(restoreView('artist')).toBe(DEFAULT_VIEW)
  expect(restoreView('{"not":"a view"}')).toBe(DEFAULT_VIEW)
  expect(restoreView('Dashboard')).toBe(DEFAULT_VIEW)
})

// The write side and the read side have to agree. If a view were persisted
// but not restorable, the DJ would be sent back to the dashboard with no
// explanation — so anything isRestorable lets through must survive a round
// trip, and anything it rejects must never have been written.
test('what gets persisted is exactly what can be restored', () => {
  for (const view of ['dashboard', 'library', 'tags', 'folders', 'crates', 'settings']) {
    if (isRestorable(view)) expect(restoreView(view)).toBe(view)
    else expect(restoreView(view)).toBe(DEFAULT_VIEW)
  }
})

test('the default is itself restorable, so the fallback is stable', () => {
  expect(isRestorable(DEFAULT_VIEW)).toBe(true)
  expect(restoreView(DEFAULT_VIEW)).toBe(DEFAULT_VIEW)
})

// Shared with App.tsx's effect; a rename on one side only would silently
// stop restoring anything.
test('the storage key is stable', () => {
  expect(LAST_VIEW_KEY).toBe('last_view')
})
