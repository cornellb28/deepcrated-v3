// ── Between boot.ts and the app ───────────────────────────────────────────
// boot.ts registers the OS-level listeners before Electron is ready (they
// must exist that early) but loads the app — index.ts and the database with
// it — only after the launch screen is up. Anything those listeners receive
// in between is held here and handed over once the app registers.
//
// Must not import db.ts or anything that does.

type DeepLinkHandler = (url: string) => void

let deepLinkHandler: DeepLinkHandler | null = null
const pendingDeepLinks: string[] = []
let secondInstanceHandler: (() => void) | null = null

// A deepcrated:// link from 'open-url' (macOS) or a second instance's argv
// (Windows/Linux). A cold start from a sign-in link delivers it before the
// app exists, so it waits.
export function receiveDeepLink(url: string): void {
  if (deepLinkHandler) deepLinkHandler(url)
  else pendingDeepLinks.push(url)
}

export function setDeepLinkHandler(handler: DeepLinkHandler): void {
  deepLinkHandler = handler
  for (const url of pendingDeepLinks.splice(0)) handler(url)
}

// The DJ launched the app again while it was running. Returns false when
// the app has not registered yet, so the caller can surface the launch
// screen instead.
export function receiveSecondInstance(): boolean {
  if (!secondInstanceHandler) return false
  secondInstanceHandler()
  return true
}

export function setSecondInstanceHandler(handler: () => void): void {
  secondInstanceHandler = handler
}
