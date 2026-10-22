import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../helpers/paths'

// The renderer must not be able to open an arbitrary URL. The allowlist
// itself is covered by website-links.spec.ts; this checks the wiring around
// it, the same way ipc-channels.spec.ts does: by reading both sides of the
// bridge, since nothing type-checks them together.

const mainSource = readFileSync(join(REPO_ROOT, 'src/main/index.ts'), 'utf8')
const preloadSource = readFileSync(join(REPO_ROOT, 'src/preload/index.ts'), 'utf8')

test('there is no generic "open this URL" channel', () => {
  expect(mainSource).not.toContain("'shell:open-external'")
  expect(preloadSource).not.toContain("'shell:open-external'")
  expect(preloadSource).not.toMatch(/openExternal\s*:/)
})

test('website:open hands the renderer-supplied name to the allowlist, not to the shell', () => {
  expect(preloadSource).toMatch(/openWebsite:\s*\(name[^)]*\)\s*=>\s*ipcRenderer\.invoke\('website:open', name\)/)
  expect(mainSource).toMatch(
    /ipcMain\.handle\('website:open',\s*\(_e, name: unknown\) => openWebsiteLink\(name, shell\.openExternal\)\)/
  )
})

test('shell.openExternal in main only ever receives allowlisted or auth-flow URLs', () => {
  // Two call sites: the window-open handler (guarded by WEBSITE_LINKS) and
  // nothing else. auth.ts opens its own env-configured sign-in URLs.
  const calls = [...mainSource.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1])
  expect(calls).toEqual(['details.url'])
  const handler = mainSource.slice(mainSource.indexOf('setWindowOpenHandler'))
  expect(handler.slice(0, 400)).toContain('Object.values(WEBSITE_LINKS)')
})

test('no renderer code calls the removed opener', () => {
  const dir = join(REPO_ROOT, 'src/renderer/src')
  const offenders = (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => readFileSync(join(dir, file), 'utf8').includes('api.openExternal'))
  expect(offenders).toEqual([])
})
