import React, { useRef } from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { usePlayerStore } from '../store/usePlayerStore'
import { Badge } from '@renderer/components/ui/badge'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { TrackRowMenu } from './TrackRowMenu'
import { StagePill } from './StagePill'
import { TagBadge } from './TagBadge'
import type { SelectModifiers } from '../lib/selection'

interface TrackRowProps {
  track: Track
  isSelected?: boolean
  // `modifiers` is optional on purpose: views that do not implement range
  // selection (crates, folders, tags) keep passing a one-argument handler
  // and are unaffected.
  onSelected?: (id: number, modifiers?: SelectModifiers) => void
  // Set when this row is rendered inside that crate's own track list — adds
  // a "Remove from crate" action to the row's "…" menu.
  crateId?: number
}

export function TrackRow({
  track,
  isSelected,
  onSelected,
  crateId
}: TrackRowProps): React.JSX.Element {
  const { activeTrackId, setActiveTrack, trackTags } = useLibraryStore()
  const { currentTrack, isPlaying, playTrack, togglePlayPause } = usePlayerStore()

  const isActive = activeTrackId === track.id
  const appliedTags = trackTags.get(track.id) ?? []
  const artworkUrl = useArtworkUrl(track.artwork_hash, 'thumb')

  const isCurrentTrack = currentTrack?.id === track.id
  const isMissing = !!track.missing


  // Radix turns a click on the checkbox into onCheckedChange, which carries
  // no mouse event — so the modifier keys are read in the capture phase on
  // the way down, before that happens. By the time the click bubbles back
  // out to the wrapper below, the selection has already been made.
  const modifiersRef = useRef<SelectModifiers>({ shift: false })

  function handlePlayToggle(e: React.MouseEvent): void {
    e.stopPropagation()
    if (isMissing || !track.filepath) return
    if (isCurrentTrack) togglePlayPause()
    else playTrack(track)
  }

  function handleRowClick(): void {
    setActiveTrack(isActive ? null : track.id)
    if (!isActive && !isMissing) playTrack(track)
  }

  //const borderColor = isActive ? '#7f77dd' : 'transparent'
  const bgColor = isActive ? '#1a1830' : isSelected ? '#1e1b3a' : '#1a1a26'

  return (
    <div
      data-testid={`track-row-${track.id}`}
      onClick={handleRowClick}
      style={{
        position: 'relative',
        padding: '6px 10px 6px 6px',
        marginBottom: '2px',
        background: bgColor,
        borderRadius: '6px',
        cursor: 'pointer',
        border: '0.5px solid ${borderColor}',
        transition: 'all 0.1s',
        display: 'flex',
        opacity: isMissing ? 0.6 : 1,
        gap: '10px',
        alignItems: 'center'
      }}
    >
      {/* Checkbox — the wrapper only stops the click reaching the row (which
          would open the inspector). It must NOT also call onSelected: the
          click bubbles up from the Checkbox, so doing both toggled the
          selection twice and left it exactly as it was. */}
      <div
        onClickCapture={(e) => {
          modifiersRef.current = { shift: e.shiftKey }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ flexShrink: 0 }}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelected?.(track.id, modifiersRef.current)}
          className="border-[#333] data-[state=checked]:bg-[#7f77dd] data-[state=checked]:border-[#7f77dd]"
        />
      </div>
      {/* Artwork + play overlay */}
      <div
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '4px',
          flexShrink: 0,
          overflow: 'hidden',
          background: '#1e1e2a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative'
        }}
      >
        {artworkUrl ? (
          <img
            src={artworkUrl}
            loading="lazy"
            decoding="async"
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: '18px', color: '#333' }}>♪</span>
        )}

        {!isMissing && track.filepath && (
          <button
            data-testid={`track-play-${track.id}`}
            onClick={handlePlayToggle}
            title={isCurrentTrack && isPlaying ? 'Pause' : 'Play'}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              border: 'none',
              background: isCurrentTrack ? 'rgba(127,119,221,0.55)' : 'rgba(0,0,0,0.35)',
              color: '#fff',
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isCurrentTrack ? 1 : 0,
              transition: 'opacity 0.1s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => {
              if (!isCurrentTrack) e.currentTarget.style.opacity = '0'
            }}
          >
            {isCurrentTrack && isPlaying ? '⏸' : '▶'}
          </button>
        )}
      </div>
      {/* Title + artist */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 500,
          color: '#e0e0f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: '2px',
        }}>
          {track.title ?? track.filename ?? 'Untitled'}
          {isMissing && (
            <span style={{
              marginLeft: '6px',
              fontSize: '9px',
              background: '#e08a8022',
              color: '#e08a80',
              border: '0.5px solid #e08a8044',
              borderRadius: '3px',
              padding: '1px 5px',
              fontWeight: 500,
            }}>
              ⚠ Missing
            </span>
          )}
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
      {/* Badges — BPM, key, energy, genre, tags */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        flexWrap: 'nowrap',
        flexShrink: 0,
      }}>
        {track.bpm && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 bg-[#1a2535] text-[#5d9fd8] border-[#1a2535] font-mono">
            {track.bpm}
          </Badge>
        )}
        {track.key_camelot && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 bg-[#1a2830] text-[#3db88a] border-[#1a2830] font-mono">
            {track.key_camelot}
          </Badge>
        )}
        {track.energy && (
          <Badge variant="outline" style={{
            fontSize: '10px', height: '20px', padding: '0 6px',
            background: '#261a1a', color: '#d4537e', borderColor: '#261a1a',
          }}>
            E{track.energy}
          </Badge>
        )}
        {appliedTags.slice(0, 3).map(tag => (
          <TagBadge key={tag.id} tag={tag} />
        ))}
      </div>

      {/* Stage pill — click cycles Untagged → Tagged → Crate ready → Gig
          ready and wraps. It stops the click itself, so the row still plays
          and opens the Inspector when clicked anywhere else. */}
      <StagePill track={track} variant="pill" />

      {/* Duration + format */}
      <div style={{
        flexShrink: 0,
        textAlign: 'right',
        minWidth: '60px',
      }}>
        {track.duration_str && (
          <div style={{ fontSize: '11px', color: '#555', fontVariantNumeric: 'tabular-nums' }}>
            {track.duration_str}
          </div>
        )}
        {track.format && (
          <div style={{ fontSize: '9px', color: '#333', textTransform: 'uppercase', marginTop: '1px' }}>
            {track.format}
          </div>
        )}
      </div>

      {/* ⋯ Menu */}
      <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
        <TrackRowMenu track={track} crateId={crateId} />
      </div>

    </div>
  )
}
