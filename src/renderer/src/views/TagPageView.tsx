import React, { useMemo, useState } from 'react'
import { useLibraryStore, useFilteredTracks } from '../store/useLibraryStore'
import { TrackRow } from '../components/TrackRow'
import { TrackCard } from '../components/TrackCard'
import { TRACK_GRID_GAP, trackGridColumns } from '../lib/trackCard'
import { BulkBar } from '../components/BulkBar'
import { addTag, coOccurringTags, removeTag, tracksMatchingTags } from '../lib/tagFilter'

// ── Tag page ──────────────────────────────────────────────────────────────
// Opened by clicking any tag anywhere in the app. Starts as that one tag's
// tracks and narrows from there: every tag added has to be on the track as
// well, never instead of.
//
// Two rows above the list, in this order:
//   1. Narrow further — a horizontally scrollable row of the tags that
//      actually co-occur with the current filter, so no suggestion can lead
//      to an empty result.
//   2. Filtering by — what is currently applied, each one removable.

interface TagPageViewProps {
  tags: Tag[]
  onChange: (tags: Tag[]) => void
  onBack: () => void
}

export function TagPageView({ tags, onChange, onBack }: TagPageViewProps): React.JSX.Element {
  const { tracks, trackTags, displayMode } = useLibraryStore()
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  const tagIds = useMemo(() => tags.map((t) => t.id), [tags])

  // Every selected tag must be on the track. Recomputed from the store, so
  // a tag added or removed in the Inspector moves a track in or out of this
  // list without a refetch.
  const matching = useMemo(
    () => tracksMatchingTags(tracks, trackTags, tagIds),
    [tracks, trackTags, tagIds]
  )

  // The toolbar's search and BPM filters still apply on top.
  const visibleTracks = useFilteredTracks(matching)

  // Counted off `matching`, not the whole library — see coOccurringTags.
  const suggestions = useMemo(
    () => coOccurringTags(matching, trackTags, tagIds),
    [matching, trackTags, tagIds]
  )

  // A selection made under one filter must not survive into the next: those
  // tracks may no longer be on screen, and a bulk action would then hit a
  // set the DJ can no longer see.
  function applyTags(next: Tag[]): void {
    setSelectedIds(new Set())
    onChange(next)
  }

  function toggleSelect(id: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ── Header ───────────────────────────────────────────── */}
      <div
        style={{
          padding: '14px 20px',
          borderBottom: '0.5px solid #1e1e2a',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexShrink: 0
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: '0.5px solid #252535',
            borderRadius: '6px',
            color: '#555',
            fontSize: '12px',
            cursor: 'pointer',
            padding: '4px 10px',
            fontFamily: 'inherit'
          }}
        >
          ← All tags
        </button>

        <span style={{ fontSize: '13px', color: '#e8e8f0' }}>
          {tags.length === 1 ? tags[0].value : `${tags.length} tags`}
        </span>

        <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#555' }}>
          {visibleTracks.length} track{visibleTracks.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Row 1 — Narrow further ───────────────────────────── */}
      {suggestions.length > 0 && (
        <div style={{ padding: '10px 20px 0', flexShrink: 0 }}>
          <SectionLabel>Narrow further</SectionLabel>
          <div
            style={{
              display: 'flex',
              gap: '6px',
              overflowX: 'auto',
              paddingBottom: '8px',
              // Chips must not squeeze to fit; the row scrolls instead.
              scrollbarWidth: 'thin'
            }}
          >
            {suggestions.map(({ tag, count }) => (
              <button
                key={tag.id}
                onClick={() => applyTags(addTag(tags, tag))}
                title={`Also tagged "${tag.value}" — ${count} of these tracks`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  flexShrink: 0,
                  background: `${tag.color}1a`,
                  border: `0.5px solid ${tag.color}33`,
                  borderRadius: '999px',
                  padding: '4px 10px',
                  color: tag.color,
                  fontSize: '11px',
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background 0.12s ease, border-color 0.12s ease'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = `${tag.color}33`
                  e.currentTarget.style.borderColor = `${tag.color}77`
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = `${tag.color}1a`
                  e.currentTarget.style.borderColor = `${tag.color}33`
                }}
              >
                <span style={{ opacity: 0.7 }} aria-hidden>+</span>
                {tag.value}
                <span style={{ fontSize: '10px', opacity: 0.6 }}>{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Row 2 — Filtering by ─────────────────────────────── */}
      <div style={{ padding: '4px 20px 12px', flexShrink: 0 }}>
        <SectionLabel>Filtering by</SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {tags.map((tag) => (
            <span
              key={tag.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                background: `${tag.color}22`,
                border: `0.5px solid ${tag.color}55`,
                borderRadius: '999px',
                padding: '4px 6px 4px 11px',
                color: tag.color,
                fontSize: '11px',
                fontWeight: 500
              }}
            >
              <span style={{ opacity: 0.65, fontSize: '9px', textTransform: 'uppercase' }}>
                {tag.field}
              </span>
              {tag.value}
              <button
                onClick={() => applyTags(removeTag(tags, tag.id))}
                title={`Stop filtering by "${tag.value}"`}
                aria-label={`Remove ${tag.value} filter`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: tag.color,
                  cursor: 'pointer',
                  fontSize: '13px',
                  lineHeight: 1,
                  padding: '0 3px',
                  fontFamily: 'inherit',
                  opacity: 0.7
                }}
              >
                ×
              </button>
            </span>
          ))}

          {tags.length > 1 && (
            <button
              onClick={onBack}
              style={{
                background: 'none',
                border: 'none',
                color: '#555',
                fontSize: '11px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                padding: '4px 6px'
              }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      <BulkBar
        selectedIds={selectedIds}
        onClearSelect={() => setSelectedIds(new Set())}
        onSelectAll={() => setSelectedIds(new Set(visibleTracks.map((t) => t.id)))}
        totalCount={visibleTracks.length}
      />

      {visibleTracks.length === 0 && (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            color: '#333',
            fontSize: '13px'
          }}
        >
          <span>No tracks carry all {tags.length} of these tags</span>
          {tags.length > 1 && (
            <button
              onClick={() => applyTags(tags.slice(0, -1))}
              style={{
                background: 'none',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                color: '#7f77dd',
                fontSize: '12px',
                cursor: 'pointer',
                padding: '5px 12px',
                fontFamily: 'inherit'
              }}
            >
              Remove “{tags[tags.length - 1].value}”
            </button>
          )}
        </div>
      )}

      {displayMode === 'list' && visibleTracks.length > 0 && (
        <div data-testid="track-list" style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {visibleTracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              isSelected={selectedIds.has(track.id)}
              onSelected={toggleSelect}
            />
          ))}
        </div>
      )}

      {displayMode === 'grid' && visibleTracks.length > 0 && (
        <div
          data-testid="track-list"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            display: 'grid',
            gridTemplateColumns: trackGridColumns,
            gap: `${TRACK_GRID_GAP}px`,
            alignContent: 'start'
          }}
        >
          {visibleTracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              isSelected={selectedIds.has(track.id)}
              onSelect={toggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.8px',
        textTransform: 'uppercase',
        color: '#444',
        marginBottom: '7px'
      }}
    >
      {children}
    </div>
  )
}
