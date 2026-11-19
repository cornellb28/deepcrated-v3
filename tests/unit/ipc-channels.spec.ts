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

// Main registers handlers in index.ts and, for the launch screen (which is up
// before index.ts loads), in launchScreen.ts; each preload invokes its own.
const mainSource = ['src/main/index.ts', 'src/main/launchScreen.ts']
  .map((f) => readFileSync(join(REPO_ROOT, f), 'utf8'))
  .join('\n')
const preloadSource = ['src/preload/index.ts', 'src/preload/splash.ts']
  .map((f) => readFileSync(join(REPO_ROOT, f), 'utf8'))
  .join('\n')

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
