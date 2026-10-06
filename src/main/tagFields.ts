// ── Tag-backed fields: the rules ──────────────────────────────────────────
// Five fields (genre, grouping, label, remixer, composer) are moving onto the
// model artist already uses: the generic `tags` table is the source of truth
// and `tracks.<field>` becomes a derived display string. This module holds the
// part of that with no database in it, so the splitting rules can be tested
// without one — the same split as rescan.ts / rescanSweep.ts, and for the
// same reason (importing db.ts opens the SQLite file as a side effect).
//
// The database half lives in db.ts beside the other tag functions.

// What the derived column is joined with. Settled 2026-09-25: this is what
// TagInput and BulkEditModal already write, and what the existing column
// values already round-trip through.
export const DISPLAY_DELIMITER = ' / '

// Which delimiters a raw value may be SPLIT on, per field.
//
// grouping takes ' | ' as well because the files themselves use it — verified
// on disk, an MP3 whose TIT1 frame reads "90s | CLASSIC". That is the DJ's own
// convention inside the file; ' / ' is CrateCloud's. Both mean the same thing
// and both have to survive a round trip.
//
// Everything else takes ' / ' alone. Nothing here ever splits on a comma, an
// ampersand, a bare slash, ' x ' or 'feat.' — "Tyler, The Creator", "Drum &
// Bass" and "Pete Rock & C.L. Smooth" are single names, and guessing wrong
// shatters them into fragments that then have to be reassembled by hand.
export const FIELD_DELIMITERS: Record<string, readonly string[]> = {
  artist: [DISPLAY_DELIMITER],
  genre: [DISPLAY_DELIMITER],
  grouping: [DISPLAY_DELIMITER, ' | '],
  label: [DISPLAY_DELIMITER],
  remixer: [DISPLAY_DELIMITER],
  composer: [DISPLAY_DELIMITER],
  // Not part of the five being migrated, but they are TagInput fields in the
  // Inspector and so reach setTagsForField. Leaving them out would make the
  // allow-list throw on the two namespaces that already work — comment is the
  // established badge field (GOTOS, HEADZ).
  comment: [DISPLAY_DELIMITER],
  album: [DISPLAY_DELIMITER]
}

// The fields this module governs. Also the allow-list that stops a caller
// putting an arbitrary string into a SQL column name — see db.ts.
export const TAG_BACKED_FIELDS = Object.keys(FIELD_DELIMITERS)

export function isTagBackedField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_DELIMITERS, field)
}

// Splits a raw column value into the tag values it stands for. Unknown fields
// are never split: a caller asking about something outside the allow-list gets
// the value back whole rather than a guess.
export function splitValue(field: string, raw: string | null | undefined): string[] {
  const value = raw ?? ''
  if (value.trim() === '') return []

  const delimiters = FIELD_DELIMITERS[field]
  if (!delimiters) return [value.trim()]

  // Split the RAW value, then trim the parts — not the other way round. The
  // delimiter is " / ", spaces included, so trimming first turns a trailing
  // "Hip Hop / " into "Hip Hop /" and the delimiter stops matching. The
  // spaces are load-bearing: they are what distinguishes the approved
  // delimiter from the bare slash in "Afrobeat/R&B/Pop", which must NOT split.
  //
  // Split on every approved delimiter for the field, not just the first that
  // matches: "CLASSIC / CURRENT | 90s" is mixed, and both halves are real.
  let parts = [value]
  for (const delimiter of delimiters) {
    parts = parts.flatMap((part) => part.split(delimiter))
  }

  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

// The derived display string, from tag values in the order they should read.
// Returns null rather than '' for an empty set so the column matches what the
// rest of the codebase treats as "no value".
export function joinValues(values: readonly string[]): string | null {
  const cleaned = values.map((v) => v.trim()).filter((v) => v !== '')
  return cleaned.length > 0 ? cleaned.join(DISPLAY_DELIMITER) : null
}

// ── Delimiters we refuse to split on ──────────────────────────────────────
// Presence of one of these means a value may hold several things but cannot
// be split safely, so it goes to a review list rather than being guessed at.
// This is what keeps "Foxy Brown, JAŸ-Z" from becoming one tag silently AND
// from becoming two tags silently — the DJ decides.
const RISKY_DELIMITERS: readonly { name: string; re: RegExp }[] = [
  { name: 'comma', re: /,/ },
  { name: 'ampersand', re: /&/ },
  // A slash with no spaces around it: "Afrobeat/R&B/Pop". Distinct from the
  // approved " / ", which is why the spaces are load-bearing.
  { name: 'slash-no-spaces', re: /\S\/\S/ },
  { name: 'x-separator', re: /\s+x\s+/i },
  { name: 'feat', re: /\b(feat\.?|ft\.?)\b/i },
  { name: 'semicolon', re: /;/ }
]

// Named, so a review UI can say WHY a value needs looking at.
export function riskyDelimitersIn(value: string): string[] {
  return RISKY_DELIMITERS.filter(({ re }) => re.test(value)).map(({ name }) => name)
}

// True when every part a split would produce is free of risky delimiters —
// i.e. the value can be backfilled without asking.
//
// Deliberately conservative, and it costs some false alarms. "Dance / R&B /
// SOUL" splits cleanly on " / ", but the part "R&B" still carries an "&", and
// from here "R&B" and "Pete Rock & C.L. Smooth" are the same shape: one part,
// one ampersand, one or two things. Only the DJ knows which, so both go to
// review. Erring the other way would quietly shatter a duo's name.
export function isSafeToAutoSplit(field: string, raw: string | null | undefined): boolean {
  const parts = splitValue(field, raw)
  if (parts.length === 0) return true
  // A single part carrying a risky delimiter is the ambiguous case: it might
  // be one name or several, and only the DJ knows which.
  if (parts.length === 1) return riskyDelimitersIn(parts[0]).length === 0
  // Multiple parts already split on an approved delimiter. Each part is then
  // judged on its own: "Dance" and "R&B" are both fine.
  return parts.every((p) => riskyDelimitersIn(p).length === 0)
}

// ── Normalising a tag value ───────────────────────────────────────────────
// Moved here from db.ts so it can be tested without opening the database.
// db.ts re-exports it, so every existing caller is unaffected.
//
// The genre rule used to Title Case by lowercasing everything after the first
// letter of each word, which turned "R&B" into "R&b" — and the library
// already holds a seeded "R&B", so that silently created a mangled duplicate
// beside it. Settled 2026-09-25: R&B stays R&B.
//
// A word containing anything that is not a letter is left exactly as typed.
// That covers the two shapes that matter and were being destroyed:
//   "R&B"      the ampersand makes it an acronym, not two words
//   "Hip-Hop"  the hyphen is part of the name
// Plain words still fold, so "SOUL" and "soul" both reach the seeded "Soul".
//
// It errs towards preserving. A preserved value can be merged later by hand;
// a corrupted one has to be noticed first.
export function normalizeTagValue(field: string, value: string): string {
  const trimmed = value.trim()

  // label is NOT in this list. Serato has a Label column and reads it from
  // the file (TPUB on MP3, organization on Vorbis), so it holds real record
  // labels — "Def Jam", "Ninja Tune" — and force-uppercasing them would mean
  // the DJ could never enter one correctly. The schema comment in db.ts
  // originally described label as a DJ badge field; the code has always
  // written it to the publisher frame, and the code is what Serato sees.
  //
  // The existing SERATOCOLLECTION value is unaffected: it is already
  // uppercase, and nothing here rewrites values that are already stored.
  if (field === 'custom' || field === 'vibe' || field === 'venue') {
    return trimmed.toUpperCase()
  }

  if (field === 'genre') {
    return trimmed
      .split(' ')
      .map((word) =>
        /[^a-zA-Z]/.test(word)
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join(' ')
  }

  return trimmed
}
