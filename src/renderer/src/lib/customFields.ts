// Renderer-side mirror of main/customFields.ts's labels and slug rule. Kept
// in step by hand, the same way lib/tagMeta.ts mirrors main/tagFields.ts.

export const MAPPING_TARGETS: MappingTarget[] = [
  'comment',
  'grouping',
  'genre',
  'composer',
  'remixer',
  'label'
]

export const MAPPING_TARGET_LABELS: Record<MappingTarget, string> = {
  comment: 'Comment',
  grouping: 'Grouping',
  genre: 'Genre',
  composer: 'Composer',
  remixer: 'Remixer',
  label: 'Label'
}

// Serato reads remixer and label from MP3, AIFF, WAV and FLAC, but not M4A.
export const TARGET_NOTES: Partial<Record<MappingTarget, string>> = {
  remixer: 'Serato does not show Remixer for M4A files.',
  label: 'Serato does not show Label for M4A files.'
}

export const MAX_CUSTOM_FIELDS = 12

export function isCustomFieldKey(field: string): boolean {
  return field.startsWith('cf_')
}

export function keyForLabel(label: string): string | null {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return slug === '' ? null : 'cf_' + slug
}

// A small rotating palette so a new field's badges don't all look alike.
const COLORS = ['#c46ad8', '#d8a33a', '#3ab0a3', '#d86a6a', '#6a8fd8', '#8fbf4a']
export function colorForIndex(i: number): string {
  return COLORS[i % COLORS.length]
}
