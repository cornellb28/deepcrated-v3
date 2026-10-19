import type { TagType } from '../../../shared/trackMatch'

// Shared by the Mix Profile survey and Settings > Mixing.

export const SURVEY_STEPS = 6 // questions; the preview is step 6

export const TAG_LABELS: Record<TagType, string> = {
  genre: 'Genre',
  grouping: 'Grouping',
  label: 'Label',
  remixer: 'Remixer',
  comment: 'Comment',
  composer: 'Composer',
  vibe: 'Vibe',
  venue: 'Venue',
  custom: 'Custom'
}
