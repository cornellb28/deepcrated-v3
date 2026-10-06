import { test, expect } from '@playwright/test'
import { hasElectron } from '../helpers/paths'
import { createProbeSession, unwrap, type ProbeOp, type ProbeSession } from '../helpers/probe'

// Covers the app_settings key/value store behind window.api.settings —
// the mechanism per-tab view modes and custom tab definitions persist
// through. Run against the real SQLite schema rather than a stand-in,
// because the upsert and the delete are both pure SQL.

test.skip(!hasElectron(), 'electron/esbuild not installed')

let probe: ProbeSession

test.beforeEach(() => {
  probe = createProbeSession()
})

test.afterEach(() => {
  probe.cleanup()
})

async function run<T = unknown>(ops: ProbeOp[]): Promise<T[]> {
  return unwrap<T>(await probe.run(ops), ops)
}

test('a value written comes back, and an absent key reads as null', async () => {
  const [, stored, missing] = await run([
    { fn: 'setSetting', args: ['view_mode:tab:all', 'grid'] },
    { fn: 'getSetting', args: ['view_mode:tab:all'] },
    { fn: 'getSetting', args: ['never-written'] }
  ])
  expect(stored).toBe('grid')
  expect(missing).toBeNull()
})

test('writing the same key twice replaces the value rather than duplicating the row', async () => {
  const [, , value] = await run([
    { fn: 'setSetting', args: ['view_mode:tab:all', 'list'] },
    { fn: 'setSetting', args: ['view_mode:tab:all', 'grid'] },
    { fn: 'getSetting', args: ['view_mode:tab:all'] }
  ])
  // key is the PRIMARY KEY, so a second insert has to upsert or throw.
  expect(value).toBe('grid')
})

test('a deleted key reads as absent, not as an empty string', async () => {
  // The distinction matters: useViewMode and parseCustomTabs both treat ''
  // as "nothing stored", but a blanked row still occupies the table. Delete
  // is what actually removes it.
  const [, , afterDelete] = await run([
    { fn: 'setSetting', args: ['track_tabs:custom', '[]'] },
    { fn: 'deleteSetting', args: ['track_tabs:custom'] },
    { fn: 'getSetting', args: ['track_tabs:custom'] }
  ])
  expect(afterDelete).toBeNull()
})

test('deleting a key that was never written is a no-op, not an error', async () => {
  const [result, value] = await run<{ changes: number }>([
    { fn: 'deleteSetting', args: ['never-written'] },
    { fn: 'getSetting', args: ['never-written'] }
  ])
  expect(result.changes).toBe(0)
  expect(value).toBeNull()
})

test('deleting one key leaves its neighbours alone', async () => {
  const [, , , , kept, removed] = await run([
    { fn: 'setSetting', args: ['view_mode:tab:all', 'grid'] },
    { fn: 'setSetting', args: ['view_mode:tab:custom:mine', 'list'] },
    { fn: 'setSetting', args: ['track_tabs:custom', '[]'] },
    { fn: 'deleteSetting', args: ['view_mode:tab:custom:mine'] },
    { fn: 'getSetting', args: ['view_mode:tab:all'] },
    { fn: 'getSetting', args: ['view_mode:tab:custom:mine'] }
  ])
  expect(kept).toBe('grid')
  expect(removed).toBeNull()
})

test('a key can be written again after being deleted', async () => {
  const [, , , value] = await run([
    { fn: 'setSetting', args: ['track_tabs:custom', '[]'] },
    { fn: 'deleteSetting', args: ['track_tabs:custom'] },
    { fn: 'setSetting', args: ['track_tabs:custom', '[{"id":"x"}]'] },
    { fn: 'getSetting', args: ['track_tabs:custom'] }
  ])
  expect(value).toBe('[{"id":"x"}]')
})

test('settings survive a restart — they are on disk, not in memory', async () => {
  await run([{ fn: 'setSetting', args: ['view_mode:tab:all', 'grid'] }])
  // Each probe.run() is a fresh Electron process against the same SQLite
  // file, so this genuinely crosses a restart.
  const [value] = await run([{ fn: 'getSetting', args: ['view_mode:tab:all'] }])
  expect(value).toBe('grid')
})

test('a delete survives a restart too', async () => {
  await run([
    { fn: 'setSetting', args: ['track_tabs:custom', '[]'] },
    { fn: 'deleteSetting', args: ['track_tabs:custom'] }
  ])
  const [value] = await run([{ fn: 'getSetting', args: ['track_tabs:custom'] }])
  expect(value).toBeNull()
})
