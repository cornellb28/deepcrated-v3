// ── Artist names ──────────────────────────────────────────────────────────
// tracks.artist is one string. The app's own convention for several artists
// is " / " (main/tagFields.ts DISPLAY_DELIMITER), and that is the ONLY thing
// split here — the same rule main applies, for the same reason: "Tyler, The
// Creator" and "Pete Rock & C.L. Smooth" are single names, and guessing at
// commas, ampersands, "x", "vs" or "feat." shatters them into fragments.
//
// TODO(browse): "A feat. B", "A & B", "A, B" and "A x B" stay whole. Splitting
// them safely needs a reviewed list of names that contain those separators,
// the way main's riskyDelimitersIn routes them to a review step.

export const ARTIST_DELIMITER = ' / '

// Case-, whitespace- and Unicode-normalisation-insensitive, nothing more:
// accents are NOT stripped ("Beyoncé" and "Beyonce" stay different artists)
// and a leading "The" is not dropped. NFC because a tag written on another
// system can arrive decomposed and would otherwise look like a second artist.
export function normalizeArtistKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

// Mirrors main/tagFields.ts splitValue('artist', ...): split the RAW value on
// the spaced delimiter, then trim — trimming first would turn "A / " into
// "A /" and stop the delimiter matching. A bare slash ("AC/DC") never splits.
// tests/unit/browse.spec.ts checks this against the real splitValue so the
// two cannot drift apart.
export function splitArtists(raw: string | null | undefined): string[] {
  const value = raw ?? ''
  if (value.trim() === '') return []
  return value
    .split(ARTIST_DELIMITER)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

export interface TrackArtist {
  key: string
  // The spelling as written on this track.
  name: string
}

// The distinct artists on one track, in the order written. "A / a" is one
// artist, not two, so a track counts once toward each artist it carries.
export function trackArtists(track: Pick<Track, 'artist'>): TrackArtist[] {
  const seen = new Set<string>()
  const result: TrackArtist[] = []
  for (const name of splitArtists(track.artist)) {
    const key = normalizeArtistKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ key, name })
  }
  return result
}

// Which spelling to show for a group of case variants: the most common one.
// A tie prefers a mixed-case spelling ("Aaliyah" over "AALIYAH" or "aaliyah",
// which are more likely a tagging accident), then sorts, so the label is
// stable and never flickers as the library changes.
export function pickDisplayName(variants: ReadonlyMap<string, number>): string {
  const mixedCase = (name: string): boolean =>
    name !== name.toLowerCase() && name !== name.toUpperCase()
  let best: string | null = null
  let bestCount = -1
  for (const [name, count] of variants) {
    const better =
      best === null ||
      count > bestCount ||
      (count === bestCount &&
        (mixedCase(name) && !mixedCase(best)
          ? true
          : mixedCase(name) === mixedCase(best) && name < best))
    if (better) {
      best = name
      bestCount = count
    }
  }
  return best ?? ''
}
