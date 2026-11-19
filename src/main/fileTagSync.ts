// ── Keeping file tags in step with DeepCrated (for Serato) ────────────────
// Three jobs, all built on the rules in fileTags.ts:
//
//   composeWriteMeta   every tag write goes through it, so the file's
//                      Grouping always carries the extras (see fileTags.ts)
//   writeItemsForField a tag renamed, merged or deleted in the Tags view
//                      rewrites that field in every file that carried it
//   planFileTagSync    the "Tags in your files" check: reads every file the
//                      way Serato does and lists where it is out of step
//
// Serato only shows a file's new tags after it re-reads them (loading the
// track, or Rescan ID3 Tags in Serato's Files panel). Nothing here can make
// Serato do that; the UI tells the DJ.

import { getAllTracks, getTrackByFilepath, getTrackById, getTrackTagsForTracks } from './db'
import {
  FILE_TAG_FIELDS,
  GROUPING_EXTRA_FIELDS,
  composeFileGrouping,
  fieldFeedsGrouping,
  fileTagDifferences,
  intendedFileTags,
  type FieldDifference,
  type FileTagField,
  type TrackTagSource
} from './fileTags'
import { readSeratoVisibleTags, type EditTagsBatchItem, type EditTagsMeta } from './sidecar'
import { writeTagsForFile } from './tagWrites'

interface TrackRow {
  id: number
  filepath: string
  title?: string | null
  client_uuid?: string | null
  missing?: number
  artist?: string | null
  album?: string | null
  genre?: string | null
  comment?: string | null
  label?: string | null
  remixer?: string | null
  composer?: string | null
  grouping?: string | null
}

const EXTRA_FIELDS: readonly string[] = GROUPING_EXTRA_FIELDS

// vibe/venue/custom tag values per track, in tag order.
function extrasFor(trackIds: number[]): Map<number, string[]> {
  const byTrack = getTrackTagsForTracks(trackIds) as Record<
    number,
    { field: string; value: string }[]
  >
  const out = new Map<number, string[]>()
  for (const id of trackIds) {
    out.set(
      id,
      (byTrack[id] ?? []).filter((t) => EXTRA_FIELDS.includes(t.field)).map((t) => t.value)
    )
  }
  return out
}

function sourceOf(track: TrackRow, extras: string[]): TrackTagSource {
  return { ...track, extras }
}

function identity(track: TrackRow): EditTagsMeta {
  return track.client_uuid ? ({ cratecloud_id: track.client_uuid } as EditTagsMeta) : {}
}

// ── 1. Every write: Grouping carries the extras ───────────────────────────

// Called on the meta of every tag write before it reaches edit_tags.py. If
// the write touches anything Grouping is built from, Grouping is rebuilt —
// from the values in this write where it has them (they may be newer than
// the row), the rest from the database. vibe/venue/custom keys are dropped:
// the file has no frame for them except through Grouping.
export function composeWriteMeta(filepath: string, meta: Record<string, unknown>): EditTagsMeta {
  const out: Record<string, unknown> = { ...meta }
  for (const field of EXTRA_FIELDS) delete out[field]
  const feedsGrouping = Object.keys(meta).some((k) => fieldFeedsGrouping(k, filepath))
  if (!feedsGrouping) return out as EditTagsMeta

  const track = getTrackByFilepath(filepath) as TrackRow | undefined
  if (!track) return out as EditTagsMeta
  const pick = (field: 'grouping' | 'label' | 'remixer'): string | null =>
    typeof meta[field] === 'string' ? (meta[field] as string) : (track[field] ?? null)
  out.grouping =
    composeFileGrouping({
      filepath,
      grouping: pick('grouping'),
      label: pick('label'),
      remixer: pick('remixer'),
      extras: extrasFor([track.id]).get(track.id)
    }) ?? ''
  return out as EditTagsMeta
}

// ── 2. Tag renamed / merged / deleted: rewrite that field everywhere ──────

// One write per affected track, carrying the field's new derived value (''
// when the last tag of that field went — the DJ removed it, so the file
// loses it too) and Grouping when the field feeds it.
export function writeItemsForField(trackIds: number[], field: string): EditTagsBatchItem[] {
  const extras = extrasFor(trackIds)
  const items: EditTagsBatchItem[] = []
  for (const id of trackIds) {
    const track = getTrackById(id) as TrackRow | undefined
    if (!track || track.missing === 1) continue
    const intended = intendedFileTags(sourceOf(track, extras.get(id) ?? []))
    const meta: Record<string, unknown> = {}
    if ((FILE_TAG_FIELDS as readonly string[]).includes(field) && field !== 'grouping') {
      meta[field] = intended[field as FileTagField]
    }
    if (fieldFeedsGrouping(field, track.filepath)) meta.grouping = intended.grouping
    if (Object.keys(meta).length === 0) continue
    items.push({ filepath: track.filepath, meta: { ...identity(track), ...meta } as EditTagsMeta })
  }
  return items
}

// ── 3. The "Tags in your files" check ─────────────────────────────────────

export interface FileTagSyncTrack {
  trackId: number
  title: string
  filepath: string
  differences: FieldDifference[]
}

export interface FileTagSyncPlan {
  checked: number
  // Files the check could not read (moved, unreadable); left alone.
  unreadable: number
  tracks: FileTagSyncTrack[]
  // How many tracks need each column written.
  byField: Record<string, number>
  // Columns only the file has (DeepCrated empty): never cleared, counted.
  fileOnly: number
}

export async function planFileTagSync(
  read: (paths: string[]) => ReturnType<typeof readSeratoVisibleTags> = readSeratoVisibleTags
): Promise<FileTagSyncPlan> {
  const tracks = (getAllTracks() as TrackRow[]).filter((t) => t.missing !== 1)
  const extras = extrasFor(tracks.map((t) => t.id))
  const lines = await read(tracks.map((t) => t.filepath))
  const inFile = new Map(lines.filter((l) => l.ok && l.tags).map((l) => [l.filepath, l.tags!]))

  const plan: FileTagSyncPlan = {
    checked: tracks.length,
    unreadable: 0,
    tracks: [],
    byField: {},
    fileOnly: 0
  }
  for (const track of tracks) {
    const fileTags = inFile.get(track.filepath)
    if (!fileTags) {
      plan.unreadable++
      continue
    }
    const intended = intendedFileTags(sourceOf(track, extras.get(track.id) ?? []))
    const { differences, fileOnly } = fileTagDifferences(intended, fileTags)
    plan.fileOnly += fileOnly.length
    if (differences.length === 0) continue
    for (const d of differences) plan.byField[d.field] = (plan.byField[d.field] ?? 0) + 1
    plan.tracks.push({
      trackId: track.id,
      title: track.title ?? track.filepath.split(/[\\/]/).pop() ?? '',
      filepath: track.filepath,
      differences
    })
  }
  return plan
}

// The writes for tracks the DJ approved: every column DeepCrated has a value
// for, freshly from the database (the plan may be minutes old). Never an
// empty value, so nothing only the file has is cleared.
export function writeItemsForSync(trackIds: number[]): EditTagsBatchItem[] {
  const extras = extrasFor(trackIds)
  const items: EditTagsBatchItem[] = []
  for (const id of trackIds) {
    const track = getTrackById(id) as TrackRow | undefined
    if (!track || track.missing === 1) continue
    const intended = intendedFileTags(sourceOf(track, extras.get(id) ?? []))
    const meta: Record<string, unknown> = {}
    for (const field of FILE_TAG_FIELDS) if (intended[field] !== '') meta[field] = intended[field]
    if (Object.keys(meta).length === 0) continue
    items.push({ filepath: track.filepath, meta: { ...identity(track), ...meta } as EditTagsMeta })
  }
  return items
}

// ── vibe/venue/custom applied or removed on one track ─────────────────────
// Those tags have no file frame of their own; their change shows up as a
// Grouping rewrite. Debounced per track, so tagging several in a row is
// one write.

const GROUPING_WRITE_DEBOUNCE_MS = 1500
const pendingGroupingWrites = new Map<number, ReturnType<typeof setTimeout>>()

export function scheduleGroupingWrite(trackId: number): void {
  const prior = pendingGroupingWrites.get(trackId)
  if (prior) clearTimeout(prior)
  pendingGroupingWrites.set(
    trackId,
    setTimeout(() => {
      pendingGroupingWrites.delete(trackId)
      const [item] = writeItemsForField([trackId], 'vibe')
      if (!item) return
      writeTagsForFile(item.filepath, item.meta).catch((err) =>
        console.warn(`[tags] could not update Grouping in ${item.filepath}:`, err)
      )
    }, GROUPING_WRITE_DEBOUNCE_MS)
  )
}

export function isGroupingExtraField(field: string): boolean {
  return EXTRA_FIELDS.includes(field)
}
