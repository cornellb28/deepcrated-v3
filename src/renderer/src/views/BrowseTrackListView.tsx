import React, { useMemo, useRef, useState } from 'react'
import { useLibraryStore, useFilteredTracks } from '../store/useLibraryStore'
import { useBrowseStore } from '../store/useBrowseStore'
import { TrackRow } from '../components/TrackRow'
import { BulkBar } from '../components/BulkBar'
import { VirtualizedTrackGrid } from '../components/VirtualizedTrackGrid'
import { applySelection, selectAll, type SelectModifiers } from '../lib/selection'
import type { BrowseDimension } from '../lib/browse/types'
import { BackButton, Message } from '../components/BrowseChrome'

// ── The tracks behind one browse value ───────────────────────────────────
// For values that are not tags (an artist, or a bucket such as Untagged / No
// artist / No genre). Tag-backed values open in TagPageView instead, which
// already stacks tags with AND.
//
// The list is recomputed from the store, so an edit that changes a track's
// artist or tags moves it in or out of this list live. The toolbar's search
// and BPM filters apply on top, as they do on the tag page. Tracks whose file
// is missing stay listed (and marked), as in the genre and tag views.

interface Props {
  dimension: BrowseDimension
  valueKey: string
  label: string
}

export function BrowseTrackListView({ dimension, valueKey, label }: Props): React.JSX.Element {
  const tracks = useLibraryStore((s) => s.tracks)
  const trackTags = useLibraryStore((s) => s.trackTags)
  const displayMode = useLibraryStore((s) => s.displayMode)
  const dispatch = useBrowseStore((s) => s.dispatch)

  const matching = useMemo(
    () => dimension.tracksFor({ tracks, trackTags }, valueKey),
    [dimension, tracks, trackTags, valueKey]
  )
  const visible = useFilteredTracks(matching)

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const anchorId = useRef<number | null>(null)
  const visibleIds = useMemo(() => visible.map((t) => t.id), [visible])

  function handleSelect(id: number, modifiers?: SelectModifiers): void {
    const result = applySelection(selectedIds, visibleIds, id, modifiers, anchorId.current)
    setSelectedIds(result.selected)
    anchorId.current = result.anchorId
  }

  const back = (): void => dispatch({ type: 'back' })

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0
      }}
    >
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
        <BackButton onClick={back}>← {dimension.label}</BackButton>
        <h1 style={{ fontSize: '13px', fontWeight: 500, color: '#e8e8f0', margin: 0 }}>{label}</h1>
        <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#555' }}>
          {visible.length.toLocaleString()} track{visible.length !== 1 ? 's' : ''}
        </span>
      </div>

      <BulkBar
        selectedIds={selectedIds}
        onClearSelect={() => {
          setSelectedIds(new Set())
          anchorId.current = null
        }}
        onSelectAll={() => {
          setSelectedIds(selectAll(visibleIds))
          anchorId.current = null
        }}
        totalCount={visible.length}
      />

      {visible.length === 0 ? (
        <Message
          // The value can empty out while this page is open — an edit moved
          // the last track elsewhere — as well as the toolbar filters hiding
          // everything.
          title={matching.length === 0 ? 'No tracks here any more' : 'No tracks match your filters'}
          detail={
            matching.length === 0
              ? `Nothing is under “${label}” now.`
              : 'The search or BPM filter in the toolbar is hiding every track.'
          }
          action={
            matching.length === 0 ? (
              <BackButton onClick={back}>← Back to {dimension.label}</BackButton>
            ) : undefined
          }
        />
      ) : displayMode === 'grid' ? (
        <VirtualizedTrackGrid tracks={visible} selectedIds={selectedIds} onSelect={handleSelect} />
      ) : (
        <div data-testid="track-list" style={{ flex: 1, overflowY: 'auto', padding: '8px 16px' }}>
          {visible.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              isSelected={selectedIds.has(track.id)}
              onSelected={handleSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
