// ── What a file's tags should say, for Serato ─────────────────────────────
// DeepCrated's database is the source; the audio file's tags are what Serato
// (and every other app) reads. These are the rules for turning one into the
// other, with no database in them so they can be tested on their own — same
// split as tagFields.ts.
//
// Grouping carries more than DeepCrated's grouping tags, because it is the
// one free-text column Serato shows for everything:
//   - vibe, venue and custom tags, which have no Serato column at all;
//   - label and remixer on .m4a and .wav files, where Serato does not read
//     the label/remixer frames (checked against a real Serato database:
//     M4A never, WAV's TPUB not either).
// Values are de-duplicated (case-insensitively) and joined with " | ".
//
// TODO(tags): a file written this way and imported fresh elsewhere brings
// those extra values in as grouping tags; nothing marks them as vibe/label.

import { joinValues, splitValue } from './tagFields'

// The columns Serato shows that DeepCrated writes, in display order.
export const FILE_TAG_FIELDS = [
  'artist',
  'album',
  'genre',
  'comment',
  'label',
  'remixer',
  'composer',
  'grouping'
] as const
export type FileTagField = (typeof FILE_TAG_FIELDS)[number]

// DeepCrated tag fields with no Serato column: they ride in Grouping.
export const GROUPING_EXTRA_FIELDS = ['vibe', 'venue', 'custom'] as const

// Formats whose label/remixer Serato does not read: those ride in Grouping.
const LABEL_REMIXER_IN_GROUPING = new Set(['.m4a', '.wav'])

export function extOf(filepath: string): string {
  const dot = filepath.lastIndexOf('.')
  return dot === -1 ? '' : filepath.slice(dot).toLowerCase()
}

export function labelAndRemixerGoInGrouping(filepath: string): boolean {
  return LABEL_REMIXER_IN_GROUPING.has(extOf(filepath))
}

// True when a change to this field means the file's Grouping must be
// rewritten too.
export function fieldFeedsGrouping(field: string, filepath: string): boolean {
  if (field === 'grouping') return true
  if ((GROUPING_EXTRA_FIELDS as readonly string[]).includes(field)) return true
  return (field === 'label' || field === 'remixer') && labelAndRemixerGoInGrouping(filepath)
}

export interface TrackTagSource {
  filepath: string
  artist?: string | null
  album?: string | null
  genre?: string | null
  comment?: string | null
  label?: string | null
  remixer?: string | null
  composer?: string | null
  grouping?: string | null
  // Values of the track's vibe/venue/custom tags, in order.
  extras?: readonly string[]
}

export function composeFileGrouping(track: TrackTagSource): string | null {
  const parts = [
    ...splitValue('grouping', track.grouping),
    ...(track.extras ?? []),
    ...(labelAndRemixerGoInGrouping(track.filepath)
      ? [...splitValue('label', track.label), ...splitValue('remixer', track.remixer)]
      : [])
  ]
  const seen = new Set<string>()
  const unique = parts.filter((p) => {
    const key = p.trim().toLowerCase()
    if (key === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return joinValues(unique, 'grouping')
}

// What the file should carry for each column: '' where DeepCrated has
// nothing.
export function intendedFileTags(track: TrackTagSource): Record<FileTagField, string> {
  const out = {} as Record<FileTagField, string>
  for (const field of FILE_TAG_FIELDS) {
    const value = field === 'grouping' ? composeFileGrouping(track) : track[field]
    out[field] = normalizeTagText(value)
  }
  return out
}

// Whitespace-insensitive, as Serato displays it.
export function normalizeTagText(value: string | null | undefined): string {
  // NUL separates multiple values in ID3v2.4 frames; treat it as a space.
  return (value ?? '').split('\u0000').join(' ').split(/\s+/).filter(Boolean).join(' ')
}

export interface FieldDifference {
  field: FileTagField
  inFile: string
  deepcrated: string
}

// The columns where the file is out of step with DeepCrated. A column that
// DeepCrated leaves empty is never on this list: the check only ever adds
// or corrects, it never clears something only the file has (a comment typed
// in another app, a genre DeepCrated never imported).
export function fileTagDifferences(
  intended: Record<FileTagField, string>,
  inFile: Partial<Record<FileTagField, string>>
): { differences: FieldDifference[]; fileOnly: FileTagField[] } {
  const differences: FieldDifference[] = []
  const fileOnly: FileTagField[] = []
  for (const field of FILE_TAG_FIELDS) {
    const want = intended[field]
    const have = normalizeTagText(inFile[field])
    if (want === have) continue
    if (want === '') {
      fileOnly.push(field)
      continue
    }
    differences.push({ field, inFile: have, deepcrated: want })
  }
  return { differences, fileOnly }
}
