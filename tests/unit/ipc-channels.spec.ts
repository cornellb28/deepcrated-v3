import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../helpers/paths'

// Every channel the preload invokes must have a handler in main.
//
// The bug this exists for: the preload invoked 'fs:showInFolder' while main
// registered 'fs:show-in-folder'. Electron rejects an invoke with no handler,
// but the caller neither awaited nor caught it, so "Show in Finder" did
// nothing at all — no error, no Finder window, for months.
//
// Nothing about that is visible to the type system: both sides are strings,
// and they are in different files that are never compiled together. This is
// the only place the two halves get compared.

const mainSource = readFileSync(join(REPO_ROOT, 'src/main/index.ts'), 'utf8')
const preloadSource = readFileSync(join(REPO_ROOT, 'src/preload/index.ts'), 'utf8')

function matchAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1])
}

const handled = new Set(matchAll(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g))
const invoked = new Set(matchAll(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g))

test('the source files were actually found', () => {
  // A regex that silently matched nothing would make every assertion below
  // pass for the wrong reason.
  expect(handled.size).toBeGreaterThan(30)
  expect(invoked.size).toBeGreaterThan(30)
})

test('every channel the preload invokes has a handler in main', () => {
  const orphans = [...invoked].filter((channel) => !handled.has(channel)).sort()
  expect(orphans, `invoked from preload with no ipcMain.handle: ${orphans.join(', ')}`).toEqual([])
})

test('channel names follow the kebab-case convention', () => {
  // 'fs:showInFolder' vs 'fs:show-in-folder' is precisely how the two sides
  // drifted apart. One convention means a typo is visible on sight.
  const camel = [...handled, ...invoked].filter((c) => /[A-Z]/.test(c)).sort()
  expect(camel, `channels containing capitals: ${camel.join(', ')}`).toEqual([])
})
