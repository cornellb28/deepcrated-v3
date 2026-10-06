import React, { useState } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { Badge } from '@renderer/components/ui/badge'
import { AccountButton } from '@renderer/components/AccountButton'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { TrackRow } from '../components/TrackRow'
import { BulkBar } from '../components/BulkBar'
import { TagBadge } from '../components/TagBadge'
import { applySelection, selectAll, type SelectModifiers } from '../lib/selection'

// ── "Needs attention" ─────────────────────────────────────────────────────
// The predicates live here, once, and are used BOTH to count and to build
// the expanded list. Defining them twice is how a box comes to say 128 and
// then show a different 130 tracks.
type NeedsKey = 'bpm' | 'key' | 'artwork' | 'genre'

interface NeedsDef {
  key: NeedsKey
  label: string
  // What the DJ actually does about it. Shown in the expanded panel, where
  // there is room for a sentence — a count alone tells you the size of the
  // problem and nothing about the fix.
  hint: string
  test: (t: Track) => boolean
}

const NEEDS: NeedsDef[] = [
  {
    key: 'bpm',
    label: 'Without BPM',
    hint: 'Analysis fills these in — select them in All Tracks and run it.',
    test: (t) => !t.bpm
  },
  {
    key: 'key',
    label: 'Without key',
    hint: 'Analysis fills these in too, in the same pass as BPM.',
    test: (t) => !t.key_camelot
  },
  {
    key: 'artwork',
    label: 'Without artwork',
    hint: 'Add art from the inspector, or re-import if the file has art embedded.',
    test: (t) => !t.artwork_hash
  },
  {
    key: 'genre',
    label: 'Without genre',
    hint: 'Set a genre in the inspector, or tag several at once with bulk edit.',
    test: (t) => !t.genre
  }
]

// How many rows the inline panel draws before it stops. This is a glance,
// not a work queue: a library with 8,000 untagged tracks would otherwise
// mount 8,000 rows and jam the dashboard on a single click. The footer says
// how many were left out.
const PANEL_LIMIT = 100

interface DashboardStats {
  total: number
  analyzed: number
  missing: number
  needs: Record<NeedsKey, number>
  totalDurationHr: number
  topTags: { tag: Tag; count: number }[]
  topGenres: { tag: Tag; count: number }[]
  genreUntagged: number
  recentTracks: Track[]
}

function computeStats(tracks: Track[], trackTags: Map<number, Tag[]>): DashboardStats {
  const analyzed = tracks.filter((t) => t.analyzed_at !== null).length
  const missing = tracks.filter((t) => t.missing === 1).length
  const needs = Object.fromEntries(
    NEEDS.map((n) => [n.key, tracks.filter(n.test).length])
  ) as Record<NeedsKey, number>
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
    .slice(0, 8)

  // Tracks carrying a genre string but no genre tag — i.e. not yet migrated
  // onto the tags model. Counted so the panel can say the distribution is
  // incomplete rather than quietly under-reporting.
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
    needs,
    totalDurationHr,
    topTags,
    topGenres,
    genreUntagged,
    recentTracks
  }
}

interface DashboardViewProps {
  // Null until main has finished restoring any stored session. The header
  // control renders nothing during that moment rather than flashing a
  // "Sign in" button at someone who is already signed in.
  auth: AuthState | null
  // Opens Settings > Account, the one place sign-in lives.
  onOpenAccount: () => void
  // Switches to All Tracks. A callback rather than a store write because
  // App owns activeView, including persisting it — see setActiveView.
  onOpenLibrary: () => void
}

export function DashboardView({ auth, onOpenAccount, onOpenLibrary }: DashboardViewProps): React.JSX.Element {
  const { tracks, trackTags, setPendingTagNav } = useLibraryStore()
  const stats = computeStats(tracks, trackTags)

  // Which "Needs attention" box is expanded, or null for none. Deliberately
  // one at a time: four open lists would push everything below off-screen
  // and the dashboard stops being a dashboard.
  const [openKey, setOpenKey] = useState<NeedsKey | null>(null)

  // Selection inside the panel, with the same range rules as every other
  // list — applySelection owns the shift-click arithmetic so the dashboard
  // cannot drift from All Tracks on what a shift-click means.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [anchorId, setAnchorId] = useState<number | null>(null)

  const openDef = NEEDS.find((n) => n.key === openKey) ?? null
  // Recomputed from `tracks` on every render rather than snapshotted when
  // the box was clicked, so a track that gets analysed while the panel is
  // open drops out of the list on its own.
  const openTracks = openDef ? tracks.filter(openDef.test) : []
  const shownTracks = openTracks.slice(0, PANEL_LIMIT)
  // The rendered slice, not the whole result: a shift-click can only span
  // rows that exist, and applySelection falls back to a plain toggle for an
  // id it cannot find.
  const shownIds = shownTracks.map((t) => t.id)

  // Switching or closing a box drops the selection with it. Carrying it over
  // would leave a bar reading "12 selected" above a list those twelve tracks
  // are no longer in — and a bulk action would then hit the wrong set.
  function openBox(next: NeedsKey | null): void {
    setOpenKey(next)
    setSelectedIds(new Set())
    setAnchorId(null)
  }

  function handleSelect(id: number, modifiers?: SelectModifiers): void {
    const result = applySelection(selectedIds, shownIds, id, modifiers, anchorId)
    setSelectedIds(result.selected)
    setAnchorId(result.anchorId)
  }

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '24px 32px',
      maxWidth: '100%',
      width: '100%',
      margin: '0 auto',
    }}>

      {/* Title left, account right — the same shape as the Settings
          header, so switching between the two views doesn't shift the
          furniture. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
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

        <AccountButton auth={auth} onOpenAccount={onOpenAccount} />
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

      {/* ── Row 2 — Needs attention ───────────────── */}
      <SectionTitle>Needs attention</SectionTitle>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '10px',
        marginBottom: openDef ? '10px' : '24px',
      }}>
        {NEEDS.map(def => {
          const value = stats.needs[def.key]
          const isOpen = openKey === def.key
          // A box at zero has nothing to show. Left as a plain div rather
          // than a disabled button so it never offers a click that would
          // open an empty panel.
          const clickable = value > 0

          const body = (
            <>
              <div style={{
                fontSize: '20px',
                fontWeight: 500,
                color: value > 0 ? '#ba7517' : '#1d9e75',
                minWidth: '40px'
              }}>
                {value > 0 ? value.toLocaleString() : '✓'}
              </div>
              <div style={{
                fontSize: '12px',
                color: isOpen ? '#c0c0d8' : '#555',
                textAlign: 'left',
                flex: 1
              }}>
                {def.label}
              </div>
              {clickable && (
                <span
                  aria-hidden
                  style={{
                    fontSize: '10px',
                    color: isOpen ? '#ba7517' : '#3a3a48',
                    transform: isOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.15s ease, color 0.15s ease',
                    flexShrink: 0
                  }}
                >
                  ▾
                </span>
              )}
            </>
          )

          const shared: React.CSSProperties = {
            background: isOpen ? '#191521' : '#13131b',
            border: isOpen
              ? '0.5px solid #ba751788'
              : value > 0
                ? '0.5px solid #ba751733'
                : '0.5px solid #1e1e2a',
            borderRadius: '10px',
            padding: '14px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%'
          }

          if (!clickable) {
            return <div key={def.key} style={shared}>{body}</div>
          }

          return (
            <button
              key={def.key}
              type="button"
              onClick={() => openBox(isOpen ? null : def.key)}
              aria-expanded={isOpen}
              aria-controls="needs-attention-panel"
              style={{
                ...shared,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'background 0.15s ease, border-color 0.15s ease'
              }}
            >
              {body}
            </button>
          )
        })}
      </div>

      {/* The expanded list. Sits directly under the row it belongs to, so
          the connection between the number and the tracks is never in
          doubt — and collapses back to nothing, so the dashboard below it
          stays where the DJ left it. */}
      {openDef && (
        <div
          id="needs-attention-panel"
          style={{
            background: '#13131b',
            border: '0.5px solid #ba751733',
            borderRadius: '10px',
            overflow: 'hidden',
            marginBottom: '24px',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '12px 14px',
            borderBottom: openTracks.length > 0 ? '0.5px solid #1e1e2a' : 'none',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: '#c0c0d8' }}>
                {openTracks.length.toLocaleString()}{' '}
                {openTracks.length === 1 ? 'track' : 'tracks'} {openDef.label.toLowerCase()}
              </div>
              <div style={{ fontSize: '11px', color: '#555', marginTop: '3px' }}>
                {openDef.hint}
              </div>
            </div>
            <button
              type="button"
              onClick={() => openBox(null)}
              style={{
                background: 'none',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                color: '#555',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '4px 10px',
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            >
              Close
            </button>
          </div>

          {/* Renders null until something is selected, so it costs no
              vertical space on the way in. "Select all" deliberately takes
              the WHOLE result rather than the rendered slice — the cap below
              is a rendering budget, not a limit on what you can act on. */}
          <BulkBar
            selectedIds={selectedIds}
            onClearSelect={() => {
              setSelectedIds(new Set())
              setAnchorId(null)
            }}
            onSelectAll={() => {
              setSelectedIds(selectAll(openTracks.map((t) => t.id)))
              setAnchorId(null)
            }}
            totalCount={openTracks.length}
          />

          {openTracks.length === 0 ? (
            // Reachable: the panel stays open while analysis runs, so the
            // last track leaving the list lands here rather than on a blank.
            <div style={{ padding: '14px', fontSize: '12px', color: '#1d9e75' }}>
              ✓ All done — nothing {openDef.label.toLowerCase()} any more.
            </div>
          ) : (
            // Bounded and scrollable. Without the cap the panel would push
            // the rest of the dashboard past the fold the moment it opened,
            // which is the opposite of what a dashboard is for.
            <div style={{ maxHeight: '420px', overflowY: 'auto', padding: '8px 10px' }}>
              {shownTracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  isSelected={selectedIds.has(track.id)}
                  onSelected={handleSelect}
                />
              ))}
            </div>
          )}

          {openTracks.length > PANEL_LIMIT && (
            <div style={{
              padding: '10px 14px',
              borderTop: '0.5px solid #1e1e2a',
              fontSize: '11px',
              color: '#444',
            }}>
              Showing the first {PANEL_LIMIT} of {openTracks.length.toLocaleString()} —
              {' '}Select all still takes every one.
            </div>
          )}
        </div>
      )}

      {/* ── Row 3 — Tags + Genres ────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
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

        {/* Genre distribution */}
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
            Genre distribution
          </div>
          {stats.topGenres.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#333' }}>
              No genres tagged yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {stats.topGenres.map(({ tag, count }) => {
                const pct = Math.round((count / stats.total) * 100)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setPendingTagNav(tag)}
                    title={`Show the ${count} track${count === 1 ? '' : 's'} tagged "${tag.value}"`}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      padding: '2px 4px',
                      margin: '0 -4px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      transition: 'background 0.12s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = '#1a1a26'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'none'
                    }}
                  >
                    <span style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '3px',
                    }}>
                      <span style={{ fontSize: '11px', color: '#c0c0d8' }}>
                        {tag.value}
                      </span>
                      <span style={{ fontSize: '11px', color: '#444' }}>
                        {count}
                      </span>
                    </span>
                    <span style={{
                      display: 'block',
                      background: '#1e1e2a',
                      borderRadius: '2px',
                      height: '3px',
                      overflow: 'hidden',
                    }}>
                      <span style={{
                        display: 'block',
                        width: `${pct}%`,
                        height: '100%',
                        background: tag.color || '#7f77dd',
                        borderRadius: '2px',
                        transition: 'width 0.3s ease',
                      }} />
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* The distribution is drawn from tags, so a track whose genre is
              still only a column string is not in it. Saying so beats a chart
              that quietly under-counts. */}
          {stats.genreUntagged > 0 && (
            <div style={{ fontSize: '10px', color: '#5a5a70', marginTop: '10px', lineHeight: 1.5 }}>
              {stats.genreUntagged} track{stats.genreUntagged === 1 ? '' : 's'} carry a genre that
              is not a tag yet, so {stats.genreUntagged === 1 ? 'it is' : 'they are'} not counted
              here.
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
