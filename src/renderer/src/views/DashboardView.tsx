import React from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { Badge } from '@renderer/components/ui/badge'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { HealthSection } from '../components/HealthSection'
import { BrowseCard } from '../components/BrowseCard'
import { BROWSE_CARD_COLORS } from '../lib/browse/cardStyle'
import { TagBadge } from '../components/TagBadge'


interface DashboardStats {
  total: number
  analyzed: number
  missing: number
  totalDurationHr: number
  topTags: { tag: Tag; count: number }[]
  topGenres: { tag: Tag; count: number }[]
  genreUntagged: number
  recentTracks: Track[]
}

function computeStats(tracks: Track[], trackTags: Map<number, Tag[]>): DashboardStats {
  const analyzed = tracks.filter((t) => t.analyzed_at !== null).length
  const missing = tracks.filter((t) => t.missing === 1).length
  const totalDurationHr = Math.round(
    tracks.reduce((sum, t) => sum + (t.duration_sec ?? 0), 0) / 3600
  )

  // Top comment tags
  // The whole Tag is kept, not just its display fields: these badges are
  // clickable and navigating needs the id and the field.
  const tagCounts = new Map<number, { tag: Tag; count: number }>()
  trackTags.forEach(tags => {
    tags.filter(t => t.field === 'comment').forEach(tag => {
      const existing = tagCounts.get(tag.id)
      if (existing) existing.count++
      else tagCounts.set(tag.id, { tag, count: 1 })
    })
  })
  const topTags = Array.from(tagCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // Top genres, counted off the TAGS rather than the tracks.genre column.
  //
  // The column is a derived display string, so counting it made
  // "Hip Hop / R&B" its own bar sitting beside "Hip Hop" — three tracks
  // spread across three bars that should have been one. Counting tags gives
  // the real distribution, and carries the Tag itself so each row can open
  // that genre's tracks.
  const genreCounts = new Map<number, { tag: Tag; count: number }>()
  trackTags.forEach((tagList) => {
    tagList
      .filter((t) => t.field === 'genre')
      .forEach((tag) => {
        const existing = genreCounts.get(tag.id)
        if (existing) existing.count++
        else genreCounts.set(tag.id, { tag, count: 1 })
      })
  })
  const topGenres = Array.from(genreCounts.values())
    .sort((a, b) => b.count - a.count || a.tag.value.localeCompare(b.tag.value))
    .slice(0, 5)

  // Tracks carrying a genre string but no genre tag — i.e. not yet migrated
  // onto the tags model. Counted so the genre cards can disclose that they
  // do not include these tracks.
  const genreUntagged = tracks.filter((t) => {
    if (!t.genre) return false
    return !(trackTags.get(t.id) ?? []).some((tag) => tag.field === 'genre')
  }).length

  // Recently added
  const recentTracks = [...tracks]
    .sort((a, b) => b.added_at.localeCompare(a.added_at))
    .slice(0, 20)

  return {
    total: tracks.length,
    analyzed,
    missing,
    totalDurationHr,
    topTags,
    topGenres,
    genreUntagged,
    recentTracks
  }
}

interface DashboardViewProps {
  // Switches to All Tracks. A callback rather than a store write because
  // App owns activeView, including persisting it — see setActiveView.
  onOpenLibrary: () => void
  // Opens the Browse all hub.
  onOpenBrowse: () => void
}

export function DashboardView({ onOpenLibrary, onOpenBrowse }: DashboardViewProps): React.JSX.Element {
  const { tracks, trackTags, setPendingTagNav } = useLibraryStore()
  const stats = computeStats(tracks, trackTags)

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '24px 32px',
      maxWidth: '100%',
      width: '100%',
      margin: '0 auto',
    }}>

      {/* Dashboard title */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        marginBottom: '24px',
      }}>
        <h1 style={{
          fontSize: '20px',
          fontWeight: 500,
          color: '#e8e8f0',
          margin: 0,
        }}>
          Library Overview
        </h1>

      </div>

      {/* ── Row 1 — Overview metrics ──────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '10px',
        marginBottom: '24px',
      }}>
        {[
          {
            label: 'Total tracks',
            value: stats.total.toLocaleString(),
            color: '#7f77dd',
          },
          {
            label: 'Analyzed',
            value: stats.analyzed.toLocaleString(),
            sub: `${Math.round(stats.analyzed / stats.total * 100)}%`,
            color: '#1d9e75',
          },
          {
            label: 'Missing files',
            value: stats.missing.toLocaleString(),
            color: stats.missing > 0 ? '#d85a30' : '#555',
          },
          {
            label: 'Total duration',
            value: `${stats.totalDurationHr}h`,
            color: '#378add',
          },
        ].map(metric => (
          <div
            key={metric.label}
            style={{
              background: '#13131b',
              border: '0.5px solid #1e1e2a',
              borderRadius: '10px',
              padding: '16px',
            }}
          >
            <div style={{
              fontSize: '11px',
              color: '#444',
              marginBottom: '6px',
              fontWeight: 500,
              letterSpacing: '0.6px',
              textTransform: 'uppercase',
            }}>
              {metric.label}
            </div>
            <div style={{
              fontSize: '24px',
              fontWeight: 500,
              color: metric.color,
              lineHeight: 1,
            }}>
              {metric.value}
            </div>
            {metric.sub && (
              <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>
                {metric.sub} complete
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Browse by genre ─────────────────────── */}
      <SectionTitle
        action={
          <button
            type="button"
            onClick={onOpenBrowse}
            style={{
              background: 'none',
              border: 'none',
              color: '#7f77dd',
              fontSize: '11px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0
            }}
          >
            Browse all →
          </button>
        }
      >
        Browse by genre
      </SectionTitle>
      {stats.topGenres.length === 0 ? (
        <div style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '10px',
          padding: '16px',
          marginBottom: '24px',
          fontSize: '12px',
          color: '#555',
        }}>
          No genres tagged yet
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: '10px',
          marginBottom: '24px',
        }}>
          {stats.topGenres.map(({ tag, count }, index) => (
            <BrowseCard
              key={tag.id}
              label={tag.value}
              count={count}
              color={BROWSE_CARD_COLORS[index % BROWSE_CARD_COLORS.length]}
              onClick={() => setPendingTagNav(tag)}
              ariaLabel={`Browse ${count} tracks tagged ${tag.value}`}
              title={`Show all ${count} tracks tagged "${tag.value}"`}
            />
          ))}
        </div>
      )}
      {stats.genreUntagged > 0 && (
        <div
          style={{
            fontSize: '10px',
            color: '#5a5a70',
            marginTop: '-16px',
            marginBottom: '24px',
            lineHeight: 1.5
          }}
        >
          {stats.genreUntagged} track{stats.genreUntagged === 1 ? '' : 's'} carry a genre that is not a tag yet, so {stats.genreUntagged === 1 ? 'it is' : 'they are'} not included above.
        </div>
      )}

      {/* ── Row 2 — Crate health ─────────────────── */}
      <HealthSection />

      {/* ── Row 3 — Tags ─────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: '16px',
        marginBottom: '24px',
      }}>

        {/* Top comment tags */}
        <div style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '10px',
          padding: '16px',
        }}>
          <div style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            color: '#444',
            marginBottom: '12px',
          }}>
            Most used tags
          </div>
          {stats.topTags.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#333' }}>
              No tags applied yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {stats.topTags.map(({ tag, count }) => (
                <span
                  key={tag.id}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                >
                  <TagBadge tag={tag} />
                  <span style={{ fontSize: '10px', color: '#444' }}>{count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 4 — Recently added ────────────────── */}
      {/* The dashboard shows the newest 20. Anyone reading this list is one
          step from wanting the whole thing, so the way there sits on the
          same line rather than back in the sidebar. */}
      <SectionTitle
        action={
          <button
            type="button"
            onClick={onOpenLibrary}
            title="Open All Tracks"
            style={{
              background: 'none',
              border: '0.5px solid #252535',
              borderRadius: '5px',
              color: '#6a6a80',
              fontSize: '10px',
              letterSpacing: '0.3px',
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
              transition: 'color 0.12s ease, border-color 0.12s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#a09be8'
              e.currentTarget.style.borderColor = '#3a3060'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#6a6a80'
              e.currentTarget.style.borderColor = '#252535'
            }}
          >
            View in library →
          </button>
        }
      >
        Recently added
      </SectionTitle>
      <div style={{
        background: '#13131b',
        border: '0.5px solid #1e1e2a',
        borderRadius: '10px',
        overflow: 'hidden'
      }}>
        {stats.recentTracks.map((track, i) => (
          <RecentTrackRow
            key={track.id}
            track={track}
            index={i}
            isLast={i === stats.recentTracks.length - 1}
          />
        ))}
      </div>

    </div>
  )
}

// ─── Helper ───────────────────────────────────────────────

// `action` is an optional control pinned to the right of the title, on the
// same line. The label keeps its own baseline rather than being pushed
// around by a taller button, which is why this is a flex row with the
// margin moved off the label and onto the row.
function SectionTitle({
  children,
  action
}: {
  children: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      marginBottom: '10px',
      minHeight: '20px',
    }}>
      <span style={{
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: '#444',
      }}>
        {children}
      </span>
      {action}
    </div>
  )
}

// "Recently added" only. The "Needs attention" panel deliberately uses the
// real TrackRow instead — it needs the checkbox and the ⋮ menu that feed
// the BulkBar, and a second row component that grew those would be the
// same thing twice.
function RecentTrackRow({
  track,
  index,
  isLast,
}: {
  track: Track
  index: number
  isLast: boolean
}): React.JSX.Element {
  const artworkUrl = useArtworkUrl(track.artwork_hash, 'thumb')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderBottom: isLast ? 'none' : '0.5px solid #1e1e2a',
      }}
    >
      {/* Track number */}
      <span style={{
        fontSize: '11px',
        color: '#333',
        minWidth: '20px',
        textAlign: 'right',
      }}>
        {index + 1}
      </span>

      {/* Artwork */}
      <div style={{
        width: '36px',
        height: '36px',
        borderRadius: '4px',
        overflow: 'hidden',
        background: '#1e1e2a',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: '14px', color: '#333' }}>♪</span>
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 500,
          color: '#e0e0f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {track.title ?? track.filename ?? 'Untitled'}
        </div>
        <div style={{
          fontSize: '11px',
          color: '#555',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {track.artist ?? 'Unknown'}
        </div>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
        {track.bpm && (
          <Badge variant="outline" style={{
            fontSize: '10px',
            background: '#1a2535',
            color: '#5d9fd8',
            borderColor: '#1a2535',
          }}>
            {track.bpm}
          </Badge>
        )}
        {track.key_camelot && (
          <Badge variant="outline" style={{
            fontSize: '10px',
            background: '#1a2830',
            color: '#3db88a',
            borderColor: '#1a2830',
          }}>
            {track.key_camelot}
          </Badge>
        )}
      </div>

      {/* Added date */}
      <span style={{
        fontSize: '11px',
        color: '#333',
        flexShrink: 0
      }}>
        {new Date(track.added_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })}
      </span>
    </div>
  )
}
