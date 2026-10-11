// ── Launch screen ─────────────────────────────────────────────────────────
// A small frameless window shown from the moment Electron is ready until the
// main window has both painted and loaded the library. It is a static page
// (resources/splash.html) with its own tiny preload, so it paints long
// before the React bundle could.
//
// Stages are real boot steps, pushed from main over 'splash:stage'. A
// failure switches it to an error with Retry / Quit ('splash:error'). It
// never reads the database and never shows account UI: sign-in stays in
// Settings > Account.
//
// Must not import db.ts or anything that does — boot.ts loads this before
// the database is opened, so it can be on screen while that happens.
//
// TODO(launch): a first-run welcome variant, a "what's new" note after an
// update, and a reward/badge teaser would all start from this window.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import splashPage from '../../resources/splash.html?asset'

export type LaunchStage = 'library' | 'folders' | 'tracks'

const STAGE_TEXT: Record<LaunchStage, string> = {
  library: 'Opening your library…',
  folders: 'Watching your music folders…',
  tracks: 'Loading your tracks…'
}

// Long enough that a fast start does not flash the splash on and off.
const MIN_VISIBLE_MS = 1200
// If the renderer never reports its library loaded (a renderer bug, not a
// startup failure), show the app anyway this long after it painted rather
// than leave the DJ looking at a launch screen.
const READY_FALLBACK_MS = 10_000
// How long boot waits for the splash to paint before opening the database
// regardless. The page is tiny; this only bounds a pathological case.
const PAINT_WAIT_CAP_MS = 800

let splash: BrowserWindow | null = null
let openedAt = 0
let failed = false
let lastStage: string | null = null

// Main-window handoff state.
let mainWindow: BrowserWindow | null = null
let mainPainted = false
let libraryReady = false
let revealed = false

export function openLaunchScreen(): void {
  openedAt = Date.now()
  splash = new BrowserWindow({
    width: 420,
    height: 280,
    show: false,
    center: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // The main window takes the taskbar slot when it appears; a second
    // entry that vanishes a second later is the flicker to avoid. macOS has
    // a single Dock icon either way.
    skipTaskbar: process.platform !== 'darwin',
    title: 'DeepCrated',
    backgroundColor: '#121212',
    webPreferences: {
      preload: join(__dirname, '../preload/splash.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  splash.once('ready-to-show', () => splash?.show())
  splash.on('closed', () => {
    splash = null
  })
  // Re-send the latest status after a load (and after a dev reload).
  splash.webContents.on('did-finish-load', () => {
    if (lastStage) splash?.webContents.send('splash:stage', lastStage)
  })
  void splash.loadFile(splashPage, { query: { version: app.getVersion() } })

  // Retry relaunches the whole process: a module that failed while loading
  // (the database open, most likely) cannot be loaded again in this one.
  ipcMain.handle('splash:retry', () => {
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('splash:quit', () => {
    app.quit()
  })
}

// Resolves once the splash has painted (or after a short cap), so the
// synchronous database open that follows does not block its first frame.
export function launchScreenPainted(): Promise<void> {
  return new Promise((resolve) => {
    if (!splash || splash.isVisible()) return resolve()
    const timer = setTimeout(resolve, PAINT_WAIT_CAP_MS)
    splash.once('ready-to-show', () => {
      clearTimeout(timer)
      // One more turn so the shown window actually composites.
      setTimeout(resolve, 16)
    })
  })
}

export function reportLaunchStage(stage: LaunchStage): void {
  if (failed) return
  console.log(`[boot] stage "${stage}" at ${Date.now() - openedAt} ms`)
  lastStage = STAGE_TEXT[stage]
  splash?.webContents.send('splash:stage', lastStage)
}

// Switches the launch screen to its error state. Logged here, the way the
// rest of main logs, so no caller can swallow it. If the app was already on
// screen there is no splash to switch, and the log is all there is.
export function reportLaunchFailure(title: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  console.error(`[boot] ${title}:`, err)
  if (revealed || !splash) return
  failed = true
  splash.webContents.send('splash:error', { title, detail })
  splash.show()
  splash.focus()
}

// Called by createWindow. Returns false once the launch screen is done (a
// window re-created later, e.g. from the macOS Dock), in which case the
// caller shows its window itself on ready-to-show, as before.
export function handOffToMainWindow(win: BrowserWindow): boolean {
  if (revealed || !splash) return false
  mainWindow = win
  reportLaunchStage('tracks')
  win.once('ready-to-show', () => {
    mainPainted = true
    console.log(
      `[boot] main window painted ${Date.now() - openedAt} ms after the launch screen opened`
    )
    maybeReveal()
    setTimeout(() => {
      if (revealed || failed) return
      console.warn('[boot] library did not report ready; showing the app anyway')
      reveal()
    }, READY_FALLBACK_MS).unref()
  })
  // The page itself failed to load or the renderer died before it was shown.
  win.webContents.once('did-fail-load', (_e, code, description) => {
    reportLaunchFailure("DeepCrated's window couldn't load", `${description} (${code})`)
  })
  win.webContents.once('render-process-gone', (_e, details) => {
    reportLaunchFailure("DeepCrated's window stopped", details.reason)
  })
  return true
}

// The renderer finished its first library load ('app:library-ready').
export function markLibraryReady(): void {
  if (!libraryReady && !revealed) {
    console.log(`[boot] library loaded ${Date.now() - openedAt} ms after the launch screen opened`)
  }
  libraryReady = true
  maybeReveal()
}

export function isLaunchScreenUp(): boolean {
  return splash !== null && !revealed
}

export function focusLaunchScreen(): void {
  if (splash && !splash.isDestroyed()) splash.focus()
}

function maybeReveal(): void {
  if (revealed || failed || !mainPainted || !libraryReady) return
  const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - openedAt))
  setTimeout(reveal, wait)
}

function reveal(): void {
  if (revealed || failed || !mainWindow || mainWindow.isDestroyed()) return
  revealed = true
  // Show the app first, then close the splash: closing it first would leave
  // a moment with no window, which on Windows/Linux can quit the app.
  mainWindow.show()
  splash?.close()
  console.log(`[boot] app shown ${Date.now() - openedAt} ms after the launch screen opened`)
}
