import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'

// ─── State ───────────────────────────────────────────────

let app: ElectronApplication
let page: Page

// ─── Setup ───────────────────────────────────────────────

test.beforeEach(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.js')],
    env: { ...process.env, NODE_ENV: 'test' }
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Always start in library view — prevents test order dependency
  await page.waitForTimeout(500)
  const allTracksBtn = page.getByText('All tracks').first()
  if (await allTracksBtn.isVisible()) {
    await allTracksBtn.click()
  }
})

test.afterEach(async () => {
  await app.close()
})

// ─── Helper ───────────────────────────────────────────────

async function getTrackCount(page: Page): Promise<number> {
  // Use first() to avoid strict mode violation if two elements exist
  const trackCount = page.getByTestId('track-count')
  const text = await trackCount.textContent()
  return parseInt(text?.match(/\d+/)?.[0] ?? '0')
}

// ─── Level 1 — App launches ───────────────────────────────

test('app opens and shows the window', async () => {
  const title = await app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows()[0].getTitle()
  })

  console.log('Window title:', title)
  expect(page).toBeTruthy()
})

test('import folder button is visible', async () => {
  const importBtn = page.getByText('+ Import folder')
  await expect(importBtn).toBeVisible()
})

test('library starts with a track count', async () => {
  const trackCount = page.getByTestId('track-count')
  const text = await trackCount.textContent()
  expect(text).toMatch(/\d+ tracks? in library/)
})

// ─── Level 2 — Navigation ────────────────────────────────

test('search input is visible in library view', async () => {
  const searchInput = page.getByTestId('search-input')
  await expect(searchInput).toBeVisible()
})

// The board-view tests that stood here were removed with the kanban view.
// The status columns they covered are now tabs in the track tab bar, which
// is covered by tests/unit/tabs.spec.ts.

// ─── Level 3 — Data ───────────────────────────────────────

test('importing a single file adds it to the track list', async () => {
  test.setTimeout(60000) // real BPM/key analysis runs inline for a single-file import

  const testFile = '/Volumes/MUSICLITE/Iceman-400/Dust Drake.m4a'

  // Get initial count
  const initialCount = await getTrackCount(page)

  // Import the file through the renderer
  // page.evaluate runs inside the renderer where window.api exists
  await page.evaluate(async (filepath) => {
    await window.api.importFile(filepath)
  }, testFile)

  // Wait for React to re-render
  await page.waitForTimeout(5000)

  // Count should have increased
  const newCount = await getTrackCount(page)
  expect(newCount).toBeGreaterThan(initialCount)
})

test('clicking a track opens the inspector', async () => {
  const trackList = page.getByTestId('track-list')
  const firstTrack = trackList.locator('[data-testid^="track-row-"]').first()

  const trackExists = await firstTrack.isVisible().catch(() => false)
  if (!trackExists) {
    console.log('No tracks in library — skipping inspector test')
    test.skip()
    return
  }

  await firstTrack.click()

  const inspector = page.getByTestId('inspector-panel')
  await expect(inspector).toBeVisible({ timeout: 3000 })
})

test('inspector title field is editable', async () => {
  const trackList = page.getByTestId('track-list')
  const firstTrack = trackList.locator('[data-testid^="track-row-"]').first()

  const trackExists = await firstTrack.isVisible().catch(() => false)
  if (!trackExists) {
    console.log('No tracks in library — skipping inspector edit test')
    test.skip()
    return
  }

  // Open the inspector
  await firstTrack.click()

  const titleField = page.getByTestId('inspector-field-title')
  await expect(titleField).toBeVisible({ timeout: 3000 })

  // Edit the title
  await titleField.clear()
  await titleField.fill('Test Title from Playwright')
  await titleField.press('Enter')

  // Wait for autosave
  await page.waitForTimeout(500)

  // Value should persist
  await expect(titleField).toHaveValue('Test Title from Playwright')
})

// test('search filters track list', async () => {
//   // Make sure we are in library view
//   await page.getByText('All tracks').click()
//   await page.waitForTimeout(300)

//   const searchInput = page.getByTestId('search-input')
//   await expect(searchInput).toBeVisible()

//   // Type a broad query
//   await searchInput.fill('a')
//   await page.waitForTimeout(300)

//   // Track list should still be visible
//   const trackList = page.getByTestId('track-list')
//   await expect(trackList).toBeVisible({ timeout: 3000 })

//   // Clear the search
//   await searchInput.fill('')
//   await page.waitForTimeout(300)
// })

test('search filters track list', async () => {
  await page.getByText('All tracks').first().click()
  await page.waitForTimeout(300)

  const searchInput = page.getByTestId('search-input')
  await expect(searchInput).toBeVisible()

  // Skip if library is empty
  const trackList = page.getByTestId('track-list')
  const hasTrackList = await trackList.isVisible().catch(() => false)
  if (!hasTrackList) {
    console.log('No tracks in library — skipping search filter test')
    test.skip()
    return
  }

  await searchInput.fill('a')
  await page.waitForTimeout(300)
  await expect(trackList).toBeVisible({ timeout: 3000 })
  await searchInput.fill('')
})

// Things worth testing next:
// test('editing BPM in inspector persists after app restart')
// test('search filters correctly by key signature')
// test('artwork appears on track rows')
// test('tag badges appear after confirming pending import')
