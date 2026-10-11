// ── Main-process entry ────────────────────────────────────────────────────
// The bundle Electron runs (out/main/index.js). It does only what has to
// happen before Electron is ready, shows the launch screen, and then loads
// the app: index.ts, which opens the database (db.ts) as it loads.
//
// That order is the point. Loading index.ts directly opened the database
// before any window could exist, so a cold start showed nothing while it
// ran and a failure to open it crashed into Electron's generic error box.
// Loaded from here, both happen behind the launch screen, and a failure
// lands on it with Retry and Quit.
//
// Keep this file and what it imports free of db.ts and of anything that
// imports it, or the database opens before the launch screen again.

import { app, protocol } from 'electron'
import { tmpdir } from 'os'
import { join } from 'path'
import { CALLBACK_PROTOCOLS } from './authCallback'
import { receiveDeepLink, receiveSecondInstance } from './bootBridge'
import {
  focusLaunchScreen,
  launchScreenPainted,
  openLaunchScreen,
  reportLaunchFailure,
  reportLaunchStage
} from './launchScreen'

// ── Before ready (moved here from index.ts unchanged in behavior) ────────

// Tests run against a throwaway userData dir. db.ts sets the same path when
// it loads, but that is now after the launch screen exists; it has to be in
// place before anything else, or the single-instance lock and Chromium's
// own profile would use the developer's real one. Keep the two in step.
if (process.env.NODE_ENV === 'test') {
  app.setPath('userData', join(tmpdir(), `deepcrated-test-${process.ppid}`))
}

// Must happen before whenReady: on Windows/Linux the second launch that the
// browser triggers has to be able to hand its URL to the first instance,
// and that only works if the lock is already held.
//
// requestSingleInstanceLock also fixes a real problem beyond auth — two
// copies of the app would open two better-sqlite3 handles on the same
// library.db and two chokidar watchers per root. A second instance now
// quits before it ever loads the app, so it no longer opens the database
// at all on its way out.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // Windows/Linux deliver the deepcrated:// URL as an argv entry on the
  // second instance, not as an event — so it has to be dug out of the
  // command line. macOS uses 'open-url' instead (registered below).
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => CALLBACK_PROTOCOLS.some((s) => arg.startsWith(`${s}://`)))
    if (url) receiveDeepLink(url)
    // Whether or not it was a deep link, the DJ just tried to open the app:
    // surface the window they already have.
    if (!receiveSecondInstance()) focusLaunchScreen()
  })
}

// macOS. Registered at module scope, not inside whenReady, because a cold
// start triggered by clicking the callback link can fire this before the app
// is ready. The link waits in bootBridge until index.ts can redeem it.
app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveDeepLink(url)
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'artwork',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

// ── Ready: launch screen, then the app ────────────────────────────────────

if (gotSingleInstanceLock) {
  void app.whenReady().then(async () => {
    openLaunchScreen()
    reportLaunchStage('library')
    // Let the splash paint before the synchronous database open blocks
    // this thread.
    await launchScreenPainted()
    try {
      // Loads index.ts: db.ts opens and migrates the library as it loads,
      // then index.ts's own whenReady handler (already ready, so it runs
      // straight after) registers everything and creates the main window.
      await import('./index')
    } catch (err) {
      reportLaunchFailure("DeepCrated couldn't open your library", err)
    }
  })
}
