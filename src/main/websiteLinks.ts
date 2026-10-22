// ── Website pages the app may open ──────────────────────────────────────
// The renderer asks for a page by name over IPC and never hands main a URL.
// Main maps the name to one of these fixed https constants and opens it in
// the system browser; anything else is refused. That keeps "open whatever
// the renderer says" off the table, and keeps tokens and user data out of
// every link: these URLs are constants with no query string.
//
// Account and billing live on the website. /account sends a signed-out
// browser through /login?next=/account and back, so no desktop-to-web
// sign-in is needed here.
//
// Pure on purpose (no electron import): index.ts passes shell.openExternal
// in, and the unit tests pass a fake.

// Canonical host, per deepcrated-web's app/layout.tsx.
const SITE = 'https://www.deepcrated.com'

export const WEBSITE_LINKS = {
  account: `${SITE}/account`,
  plans: `${SITE}/pricing`,
  privacy: `${SITE}/privacy`
} as const

export type WebsiteLink = keyof typeof WEBSITE_LINKS

export function isWebsiteLink(name: unknown): name is WebsiteLink {
  // Own keys only, not `in`: '__proto__' and 'toString' are not pages.
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(WEBSITE_LINKS, name)
}

export async function openWebsiteLink(
  name: unknown,
  open: (url: string) => Promise<void>
): Promise<{ ok: boolean; error?: string }> {
  if (!isWebsiteLink(name)) return { ok: false, error: 'Unknown website page.' }
  try {
    await open(WEBSITE_LINKS[name])
    return { ok: true }
  } catch {
    // The OS error can echo the URL back; the renderer only needs to know
    // it failed.
    return { ok: false, error: 'Could not open your browser.' }
  }
}
