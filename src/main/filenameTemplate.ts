// ── Filename templates ────────────────────────────────────────────────────
// Turns a track into a filename from a DJ-written pattern like
//
//   %artist% - %title% (%year%)
//
// Pure — no fs, no db, no electron — so the rendering rules can be tested
// without touching a library. The same split as tagFields.ts / rescan.ts.
//
// ── The rule that does the most work ─────────────────────────────────────
// A token with no value does not leave a hole. It takes its stranded
// punctuation with it, so a track with no year gets a SHORTER name rather
// than a broken one:
//
//   with a year     Foxy Brown - Big Bad Mama (1996).mp3
//   without one     Foxy Brown - Big Bad Mama.mp3
//   without artist  Big Bad Mama.mp3
//
// Settled 2026-09-25. The alternative — writing "Unknown" — produces
// hundreds of identically-named files on any library where a field is
// sparsely filled, which is most of them.

// What a token may be filled from. Deliberately a fixed list rather than
// "any Track key": a template is a string a DJ types, and letting it reach
// arbitrary columns would expose internals like artwork_hash and needs_sync.
export interface TemplateTrack {
  artist?: string | null
  title?: string | null
  album?: string | null
  year?: string | number | null
  genre?: string | null
  label?: string | null
  remixer?: string | null
  composer?: string | null
  grouping?: string | null
  bpm?: string | number | null
  key_camelot?: string | null
  filename?: string | null
}

// token -> how to read it. `key` and `original` are aliases for columns whose
// real names would be noise in a template.
const TOKENS: Record<string, (t: TemplateTrack) => string> = {
  artist: (t) => str(t.artist),
  title: (t) => str(t.title),
  album: (t) => str(t.album),
  year: (t) => str(t.year),
  genre: (t) => str(t.genre),
  label: (t) => str(t.label),
  remixer: (t) => str(t.remixer),
  composer: (t) => str(t.composer),
  grouping: (t) => str(t.grouping),
  bpm: (t) => str(t.bpm),
  key: (t) => str(t.key_camelot),
  // The current filename without its extension — lets a DJ prepend or append
  // to what is already there instead of rebuilding the whole name.
  original: (t) => stripExtension(str(t.filename))
}

export const TEMPLATE_TOKENS = Object.keys(TOKENS)

function str(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// ── Sanitising ────────────────────────────────────────────────────────────
// A tag value can contain anything; a filename cannot. "/" is a path
// separator on every platform we ship to and ":" still means one to parts of
// macOS, so both have to go before the name reaches the filesystem.
//
// Replaced with "-" rather than deleted: "AC/DC" reads as "AC-DC", where
// deleting would give "ACDC" and quietly change the name.
const ILLEGAL = /[/\\:*?"<>|]/g

// Control characters have no business in a filename and are invisible when
// they cause trouble.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g

export function sanitizeSegment(value: string): string {
  return value.replace(ILLEGAL, '-').replace(CONTROL, '').trim()
}

// ── Rendering ─────────────────────────────────────────────────────────────

// Anything between percent signs. An unknown token renders empty and is
// tidied away like any other — a typo should not put the literal "%artsit%"
// into a filename.
const TOKEN_PATTERN = /%([a-z_]+)%/gi

export function renderTemplate(template: string, track: TemplateTrack): string {
  const filled = template.replace(TOKEN_PATTERN, (_match, name: string) => {
    const read = TOKENS[name.toLowerCase()]
    return read ? sanitizeSegment(read(track)) : ''
  })

  return tidy(filled)
}

// Removes the punctuation a dropped token leaves behind. Each step is here
// because a real template produces it:
//
//   "%artist% - %title% (%year%)" with no year  ->  "Foxy Brown - Big Bad Mama ()"
//   "%artist% - %title%"          with no artist ->  " - Big Bad Mama"
//   "%artist% - %remixer% - %title%" no remixer  ->  "Foxy Brown -  - Big Bad Mama"
export function tidy(value: string): string {
  let out = value

  // Bracket groups left holding nothing, including ones holding only a
  // separator: "( - )".
  out = out.replace(/\(\s*[-–—_,]*\s*\)/g, '')
  out = out.replace(/\[\s*[-–—_,]*\s*\]/g, '')
  out = out.replace(/\{\s*[-–—_,]*\s*\}/g, '')

  // A run of separators collapses to one. Runs appear when a token between
  // two of them disappears.
  out = out.replace(/\s*([-–—_])\s*(?:\1\s*)+/g, ' $1 ')

  // Repeated whitespace, then separators stranded at either end.
  out = out.replace(/\s{2,}/g, ' ')
  out = out.replace(/^[\s\-–—_,.]+/, '')
  out = out.replace(/[\s\-–—_,.]+$/, '')

  return out.trim()
}

// The whole job: render, and say whether the result is usable. An empty
// result means every token in the template was empty for this track, which
// is a skip rather than a file called "".
export function buildFilename(
  template: string,
  track: TemplateTrack
): { ok: true; name: string } | { ok: false; reason: string } {
  if (!template.trim()) return { ok: false, reason: 'The filename template is empty.' }

  const name = renderTemplate(template, track)
  if (!name) {
    return { ok: false, reason: 'Every field in the template is empty for this track.' }
  }

  // 255 bytes is the per-component limit on APFS and ext4. Truncating on
  // characters rather than bytes would still overflow on non-ASCII, so the
  // check is done in bytes and trimmed back to a whole character.
  //
  // TextEncoder, not Buffer: this module is imported by the RENDERER too —
  // Settings previews the template live — and Buffer does not exist there
  // under context isolation. TextEncoder is in both.
  const MAX_BYTES = 200 // leaves room for an extension and a " (2)" suffix
  const byteLength = (value: string): number => new TextEncoder().encode(value).length

  if (byteLength(name) > MAX_BYTES) {
    let cut = name
    while (byteLength(cut) > MAX_BYTES) cut = cut.slice(0, -1)
    return { ok: true, name: tidy(cut) }
  }

  return { ok: true, name }
}

// Offered in Settings so a DJ has somewhere to start rather than a blank box.
export const TEMPLATE_PRESETS: { label: string; template: string }[] = [
  { label: 'Artist - Title', template: '%artist% - %title%' },
  { label: 'Artist - Title (Year)', template: '%artist% - %title% (%year%)' },
  { label: 'Artist - Title [Key BPM]', template: '%artist% - %title% [%key% %bpm%]' },
  { label: 'Artist - Title (Remixer Remix)', template: '%artist% - %title% (%remixer% Remix)' },
  { label: 'Label - Artist - Title', template: '%label% - %artist% - %title%' }
]

export const DEFAULT_TEMPLATE = '%artist% - %title%'
export const FILENAME_TEMPLATE_SETTING_KEY = 'filename_template'
