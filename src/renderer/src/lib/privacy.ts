// The one place the privacy page URL lives. Placeholder until the real page
// exists.
export const PRIVACY_URL = 'https://deepcrated.com/privacy'

// Shown under the "Contribute anonymous stats" switch. Changing this wording
// in a way that matters means bumping CONSENT_TEXT_VERSION in
// src/main/stats/consent.ts, so consent given to the old text stops counting.
export const STATS_CONSENT_COPY =
  'Share anonymous info about how tracks are organized and played, never your files, file names, or account. Helps power suggestions and trends.'

// app_settings key for the optional online track identification. Not under
// the reserved stats_ prefix: it is a plain preference, not stats consent.
export const IDENTITY_LOOKUP_KEY = 'identity_lookup_enabled'

export const IDENTITY_LOOKUP_COPY =
  "Match tracks that have no ID tags against AcoustID and MusicBrainz. This sends each track's audio fingerprint and length, plus your IP address, to those services. It never sends file names, paths or your account, and never changes your files. Matches already found stay after you turn this off. Off by default."
