# Account menu and website links

## The account chip

The chip sits at the right end of the top bar (`App.tsx`), on every view. It
also appears on Settings > Account.

| State | What shows |
|---|---|
| Signed out / session expired | "Sign in" and "Create account" (the existing browser handoff). Expired adds "Sign in again" on Settings > Account. |
| Waiting for browser | Spinner, "Reopen browser", "Cancel" |
| Signed in | Avatar only (name in the tooltip). An orange dot means offline; a green spinner means a purchase is being confirmed. |

Signed in, the menu shows the name and plan label, then exactly:

- **Profile**: a read-only dialog with avatar, name, email and plan label.
  Editing happens on the website.
- **Settings**: opens Settings.
- **Account**: opens `https://www.deepcrated.com/account` in the system
  browser. The website asks a signed-out browser to log in and returns to
  that page.
- **Sign out**: clears the stored session and the in-memory entitlement.
  Local features are unaffected.

Avatar: the Google photo if the account has one (the CSP allows
`https://*.googleusercontent.com` only), else the first letter of the name or
email, else ♪.

## Plans

Settings > Plan shows the current plan label and status, a refresh button and
**See plans**. There are no prices in the app. See plans, `LockedView` and
`LockBadge` all call `openPlans()` (`src/renderer/src/lib/website.ts`), so
there is one path to plans: the website's `/pricing`.

## Opening website pages

The renderer cannot open a URL. It calls `window.api.openWebsite(name)` with
`account`, `plans` or `privacy`, and main maps the name to a fixed https
constant in `src/main/websiteLinks.ts`. Unknown names are refused. The URLs
carry no query string, so no token or user data can ride along. The
window-open handler only passes these same URLs to the browser and drops
everything else.

Sign in and Create account do not use this list. They go through the
existing handoff (`auth:sign-in`, `auth:create-account`), which needs the
app's verifier.

To add a page, add it to `WEBSITE_LINKS` and to the `openWebsite` name union
in the preload and `global.d.ts`.
