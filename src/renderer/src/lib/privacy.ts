// The one place the privacy page URL lives. Placeholder until the real page
// exists.
export const PRIVACY_URL = 'https://deepcrate.app/privacy'

// Shown under the "Contribute anonymous stats" switch. Changing this wording
// in a way that matters means bumping CONSENT_TEXT_VERSION in
// src/main/stats/consent.ts, so consent given to the old text stops counting.
export const STATS_CONSENT_COPY =
  'Share anonymous info about how tracks are organized and played, never your files, file names, or account. Helps power suggestions and trends.'

// app_settings key for the optional online track identification. Not under
// the reserved stats_ prefix: it is a plain preference, not stats consent.
export const IDENTITY_LOOKUP_KEY = 'identity_lookup_enabled'

export const IDENTITY_LOOKUP_COPY =
  'Look up tracks on AcoustID and MusicBrainz so they can be recognized across libraries. This sends a short audio fingerprint and your IP address to those services, never file names or your account. Off by default.'
