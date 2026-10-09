import { pickDisplayName, trackArtists } from './artist'
import type { BrowseContext, BrowseDimension, BrowseValue } from './types'

// ── Shared pieces ────────────────────────────────────────────────────────

const TAG_PREFIX = 'tag:'
const ARTIST_PREFIX = 'artist:'

export function tagKey(tagId: number): string {
  return `${TAG_PREFIX}${tagId}`
}

function tagIdFromKey(key: string): number | null {
  if (!key.startsWith(TAG_PREFIX)) return null
  const id = Number(key.slice(TAG_PREFIX.length))
  return Number.isInteger(id) ? id : null
}

function hasTag(ctx: BrowseContext, trackId: number, tagId: number): boolean {
  return (ctx.trackTags.get(trackId) ?? []).some((t) => t.id === tagId)
}

interface TagTally {
  tag: Tag
  count: number
}

// One pass over trackTags. A tag applied twice to one track (it cannot be —
// track_tags is keyed on both) would still count once per track.
function tallyTags(ctx: BrowseContext, include: (tag: Tag) => boolean): TagTally[] {
  const tally = new Map<number, TagTally>()
  for (const track of ctx.tracks) {
    for (const tag of ctx.trackTags.get(track.id) ?? []) {
      if (!include(tag)) continue
      const existing = tally.get(tag.id)
      if (existing) existing.count++
      else tally.set(tag.id, { tag, count: 1 })
    }
  }
  return [...tally.values()]
}

function byName(a: BrowseValue, b: BrowseValue): number {
  return a.label.localeCompare(b.label)
}

function tagValues(ctx: BrowseContext, include: (tag: Tag) => boolean): BrowseValue[] {
  return tallyTags(ctx, include)
    .map(({ tag, count }): BrowseValue => ({
      key: tagKey(tag.id),
      label: tag.value,
      count,
      kind: 'value',
      tag,
      group: tag.field
    }))
    .sort(byName)
}

function tracksWithTag(ctx: BrowseContext, key: string): Track[] {
  const id = tagIdFromKey(key)
  if (id === null) return []
  return ctx.tracks.filter((t) => hasTag(ctx, t.id, id))
}

// ── Genre ────────────────────────────────────────────────────────────────
// Counted off genre TAGS, not the tracks.genre column, exactly as the
// dashboard's Browse by genre does: the column is a derived display string,
// and counting it makes "Hip Hop / R&B" its own entry beside "Hip Hop".
// "No genre" is therefore "no genre tag" — which also holds the few tracks
// that carry a genre string the tag migration has not reached yet, the same
// ones the dashboard footnotes.

const NO_GENRE = 'bucket:no-genre'

export const genreDimension: BrowseDimension = {
  id: 'genre',
  label: 'Genre',
  icon: 'music',
  description: 'Every genre in your library, with how many tracks carry it.',
  noun: 'genres',
  emptyMessage:
    'No genres tagged yet. Set a genre in the Inspector, or tag several tracks at once with bulk edit.',
  presentation: 'cards',
  values(ctx) {
    const values = tagValues(ctx, (t) => t.field === 'genre')
    const none = ctx.tracks.filter(
      (t) => !(ctx.trackTags.get(t.id) ?? []).some((tag) => tag.field === 'genre')
    ).length
    return none > 0
      ? [...values, { key: NO_GENRE, label: 'No genre', count: none, kind: 'bucket' }]
      : values
  },
  tracksFor(ctx, key) {
    if (key === NO_GENRE) {
      return ctx.tracks.filter(
        (t) => !(ctx.trackTags.get(t.id) ?? []).some((tag) => tag.field === 'genre')
      )
    }
    return tracksWithTag(ctx, key)
  }
}

// ── Tags ─────────────────────────────────────────────────────────────────
// Every tag that is on at least one track, across all fields. A tag with no
// tracks is not listed: it would open an empty page. (Tags Cloud still shows
// them, because that is where they are renamed and deleted.)
//
// TODO(browse): merge with Tags Cloud once its rename/delete actions can live
// on these cards.

const UNTAGGED = 'bucket:untagged'

export const tagsDimension: BrowseDimension = {
  id: 'tags',
  label: 'Tags',
  icon: 'tag',
  description: 'Every tag across genre, artist, comment, label and the rest.',
  noun: 'tags',
  emptyMessage:
    'No tags yet. Add tags in the Inspector, or tag several tracks at once with bulk edit.',
  presentation: 'cards',
  values(ctx) {
    const values = tagValues(ctx, () => true)
    const none = ctx.tracks.filter((t) => (ctx.trackTags.get(t.id) ?? []).length === 0).length
    return none > 0
      ? [...values, { key: UNTAGGED, label: 'Untagged', count: none, kind: 'bucket' }]
      : values
  },
  tracksFor(ctx, key) {
    if (key === UNTAGGED) {
      return ctx.tracks.filter((t) => (ctx.trackTags.get(t.id) ?? []).length === 0)
    }
    return tracksWithTag(ctx, key)
  }
}

// ── Artist ───────────────────────────────────────────────────────────────
// From the tracks.artist column, NOT artist tags: the column is the only
// complete source today (in the real library 64 of 77 tracks with an artist
// string have no artist tag yet). Names are grouped case-, whitespace- and
// Unicode-normalisation-insensitively and split on " | " (and legacy " / ") only — see
// artist.ts. A track with "A | B" counts under both, so counts do not sum to
// the track total.

const NO_ARTIST = 'bucket:no-artist'

export const artistDimension: BrowseDimension = {
  id: 'artist',
  label: 'Artist',
  icon: 'user',
  description: 'Every artist, case and spacing variants merged into one.',
  noun: 'artists',
  emptyMessage: 'No artists yet. Tracks show up here once they have an artist.',
  presentation: 'list',
  values(ctx) {
    interface Group {
      count: number
      variants: Map<string, number>
    }
    const groups = new Map<string, Group>()
    let none = 0

    for (const track of ctx.tracks) {
      const artists = trackArtists(track)
      if (artists.length === 0) {
        none++
        continue
      }
      for (const { key, name } of artists) {
        const group = groups.get(key) ?? { count: 0, variants: new Map<string, number>() }
        group.count++
        group.variants.set(name, (group.variants.get(name) ?? 0) + 1)
        groups.set(key, group)
      }
    }

    const values = [...groups.entries()]
      .map(([key, g]): BrowseValue => ({
        key: `${ARTIST_PREFIX}${key}`,
        label: pickDisplayName(g.variants),
        count: g.count,
        kind: 'value'
      }))
      .sort(byName)

    return none > 0
      ? [...values, { key: NO_ARTIST, label: 'No artist', count: none, kind: 'bucket' }]
      : values
  },
  tracksFor(ctx, key) {
    if (key === NO_ARTIST) return ctx.tracks.filter((t) => trackArtists(t).length === 0)
    if (!key.startsWith(ARTIST_PREFIX)) return []
    const wanted = key.slice(ARTIST_PREFIX.length)
    return ctx.tracks.filter((t) => trackArtists(t).some((a) => a.key === wanted))
  }
}
