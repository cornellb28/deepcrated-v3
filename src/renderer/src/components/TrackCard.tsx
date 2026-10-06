import React, { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Pause, Play, Sparkles } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { usePlayerStore } from '../store/usePlayerStore'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { TrackRowMenu } from './TrackRowMenu'
import {
  ANALYSIS_STAGE_LABELS,
  TRACK_CARD_ARTWORK,
  TRACK_CARD_HEIGHT,
  TRACK_CARD_MAX_WIDTH,
  TRACK_CARD_PADDING,
  analysisPercent,
  isAnalysed,
  trackMetaParts,
  trackStats,
  type TrackStat
} from '../lib/trackCard'
import type { SelectModifiers } from '../lib/selection'
import { StagePill } from './StagePill'
import { TagBadge } from './TagBadge'

// Two fits beside the board pill and the crate count at three columns
// without any of them being squeezed to an ellipsis. The rest become "+N",
// which is still a signal that there is more.
const MAX_TAGS = 2

interface TrackCardProps {
  track: Track
  isSelected?: boolean
  // `modifiers` is optional on purpose: views that do not implement range
  // selection (crates, folders, tags) keep passing a one-argument handler
  // and are unaffected.
  onSelect?: (id: number, modifiers?: SelectModifiers) => void
}

// Landscape "index card": artwork on the left, everything a DJ reads about
// a track on the right. Replaces the square artwork tile, which had room
// for a title, an artist and two badges and left the rest of the row empty.
export function TrackCard({
  track,
  isSelected = false,
  onSelect
}: TrackCardProps): React.JSX.Element {
  const { activeTrackId, setActiveTrack, trackTags, crateTrackIds, trackAnalysis } =
    useLibraryStore()
  const { currentTrack, isPlaying, playTrack, togglePlayPause } = usePlayerStore()
  const [hovered, setHovered] = useState(false)

  const isActive = activeTrackId === track.id
  const isCurrentTrack = currentTrack?.id === track.id
  const isMissing = !!track.missing

  const appliedTags = trackTags.get(track.id) ?? []
  // Comment and grouping are the DJ's own vocabulary — the fields they
  // actually filter by. Genre and label already appear on the meta line.
  const ownTags = appliedTags.filter((t) => t.field === 'comment' || t.field === 'grouping')
  const artworkUrl = useArtworkUrl(track.artwork_hash, 'thumb')

  const stats = useMemo(() => trackStats(track), [track])
  const metaParts = useMemo(() => trackMetaParts(track), [track])
  const analysed = isAnalysed(track)

  // Undefined unless this track is being re-analysed right now — the map only
  // ever holds the handful in flight.
  const analysis = trackAnalysis.get(track.id)

  // Radix turns a click on the checkbox into onCheckedChange, which carries
  // no mouse event — so the modifier keys are read in the capture phase on
  // the way down, before that happens. The surrounding hit area gets its
  // modifiers straight off its own click.
  const modifiersRef = useRef<SelectModifiers>({ shift: false })

  // How many crates hold this track. crateTrackIds is keyed by crate, so
  // this is a scan — bounded by the crate count, which is small, and only
  // for the handful of cards actually on screen.
  const crateCount = useMemo(() => {
    let count = 0
    for (const members of crateTrackIds.values()) if (members.has(track.id)) count++
    return count
  }, [crateTrackIds, track.id])

  function handlePlayToggle(e: React.MouseEvent): void {
    e.stopPropagation()
    if (isMissing || !track.filepath) return
    if (isCurrentTrack) togglePlayPause()
    else playTrack(track)
  }

  const borderColor = isActive
    ? '#7f77dd'
    : isSelected
      ? '#3a3060'
      : hovered
        ? '#2a2a40'
        : '#1e1e2a'
  const bgColor = isSelected ? '#1e1b3a' : isActive ? '#1a1830' : hovered ? '#1b1b28' : '#13131b'

  return (
    <div
      data-testid={`track-card-${track.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => setActiveTrack(isActive ? null : track.id)}
      style={{
        height: `${TRACK_CARD_HEIGHT}px`,
        maxWidth: `${TRACK_CARD_MAX_WIDTH}px`,
        boxSizing: 'border-box',
        background: bgColor,
        border: `0.5px solid ${borderColor}`,
        borderRadius: '10px',
        display: 'flex',
        gap: '12px',
        padding: `${TRACK_CARD_PADDING}px`,
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.1s, border-color 0.1s',
        opacity: isMissing ? 0.65 : 1
      }}
    >
      {/* ── Artwork ─────────────────────────────── */}
      <div
        style={{
          width: `${TRACK_CARD_ARTWORK}px`,
          height: `${TRACK_CARD_ARTWORK}px`,
          flexShrink: 0,
          borderRadius: '6px',
          overflow: 'hidden',
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative'
        }}
      >
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span style={{ fontSize: '26px', color: '#2a2a3a' }}>♪</span>
        )}

        <div
          onClickCapture={(e) => {
            modifiersRef.current = { shift: e.shiftKey }
          }}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(track.id, { shift: e.shiftKey })
          }}
          style={{ position: 'absolute', top: '5px', left: '5px', zIndex: 3 }}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onSelect?.(track.id, modifiersRef.current)}
            onClick={(e) => e.stopPropagation()}
            className="border-[rgba(255,255,255,0.4)] bg-[rgba(0,0,0,0.5)] data-[state=checked]:bg-[#7f77dd] data-[state=checked]:border-[#7f77dd]"
          />
        </div>

        {!isMissing && track.filepath && (
          <button
            data-testid={`track-play-${track.id}`}
            onClick={handlePlayToggle}
            title={isCurrentTrack && isPlaying ? 'Pause' : 'Play'}
            style={{
              position: 'absolute',
              bottom: '5px',
              right: '5px',
              zIndex: 2,
              width: '26px',
              height: '26px',
              borderRadius: '50%',
              border: 'none',
              background: isCurrentTrack ? '#7f77dd' : 'rgba(0,0,0,0.6)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isCurrentTrack || hovered ? 1 : 0,
              transition: 'opacity 0.15s'
            }}
          >
            {isCurrentTrack && isPlaying ? <Pause size={11} /> : <Play size={11} />}
          </button>
        )}
      </div>

      {/* ── Detail ──────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Title + menu */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              title={track.title ?? track.filename ?? undefined}
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#e8e8f0',
                lineHeight: 1.3,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden'
              }}
            >
              {track.title ?? track.filename ?? 'Untitled'}
            </div>
            <div
              style={{
                fontSize: '11px',
                color: '#7a7a92',
                marginTop: '2px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {track.artist ?? 'Unknown artist'}
            </div>
          </div>

          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              flexShrink: 0,
              opacity: hovered ? 1 : 0,
              transition: 'opacity 0.1s',
              marginTop: '-4px',
              marginRight: '-6px'
            }}
          >
            <TrackRowMenu track={track} />
          </div>
        </div>

        {/* Stats */}
        <div style={{ marginTop: '7px' }}>
          {analysed ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              {stats.map((stat) => (
                <StatCell key={stat.label} stat={stat} />
              ))}
            </div>
          ) : (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '10px',
                color: '#7a6a3a',
                background: '#241f14',
                border: '0.5px solid #3a3020',
                borderRadius: '5px',
                padding: '4px 8px'
              }}
            >
              <Sparkles size={10} />
              No tempo or key yet
            </div>
          )}
        </div>

        <div style={{ flex: 1, minHeight: '2px' }} />

        {/* Album · year · genre · label — or, while the sidecar is working on
            this track, what it is doing. Borrowing this line rather than
            adding one keeps the card the same height and the same shape: it is
            the least urgent line on the card for the few seconds an analysis
            takes, and the numbers it shows are the ones about to change. */}
        {analysis ? (
          <div
            style={{
              fontSize: '10px',
              color: '#3db88a',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginBottom: '5px'
            }}
          >
            ⟳ {ANALYSIS_STAGE_LABELS[analysis.stage]} · {analysisPercent(analysis)}%
          </div>
        ) : (
          metaParts.length > 0 && (
            <div
              title={metaParts.join(' · ')}
              style={{
                fontSize: '10px',
                color: '#55556a',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginBottom: '5px'
              }}
            >
              {metaParts.join(' · ')}
            </div>
          )
        )}

        {/* Board, crates, the DJ's own tags */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minHeight: '17px',
            overflow: 'hidden'
          }}
        >
          {isMissing && (
            <span
              title="File not found on disk"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '9px',
                color: '#e08a80',
                flexShrink: 0
              }}
            >
              <AlertTriangle size={9} />
              Missing
            </span>
          )}

          {/* Stage — click cycles it, same as in list view. The inline
              variant keeps the card's quieter meta-line treatment. */}
          <StagePill track={track} variant="inline" />

          {crateCount > 0 && (
            <span
              title={`In ${crateCount} crate${crateCount === 1 ? '' : 's'}`}
              style={{ fontSize: '9px', color: '#4a4a5c', flexShrink: 0 }}
            >
              ▣ {crateCount}
            </span>
          )}

          <div
            style={{
              display: 'flex',
              gap: '4px',
              overflow: 'hidden',
              marginLeft: 'auto',
              flexShrink: 1,
              minWidth: 0
            }}
          >
            {ownTags.slice(0, MAX_TAGS).map((tag) => (
              <TagBadge key={tag.id} tag={tag} size="xs" title={tag.value} />
            ))}

            {ownTags.length > MAX_TAGS && (
              <span
                title={ownTags.map((t) => t.value).join(', ')}
                style={{ fontSize: '9px', color: '#4a4a5c', lineHeight: '15px', flexShrink: 0 }}
              >
                +{ownTags.length - MAX_TAGS}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Re-analysis progress ─────────────────────
          Pinned to the bottom edge, inside the card's overflow:hidden so the
          rounded corners clip it. Absolute rather than in the flow: appearing
          and disappearing must not move anything else on the card.
          The stages are far from equal in duration — decode is most of the
          wall clock — so the fill pulses while it sits there, which is what
          separates "still working" from "stuck" without inventing a
          smoothly-creeping number that isn't measured. */}
      {analysis && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '3px',
            background: '#1e1e2a',
            zIndex: 4
          }}
        >
          <div
            className={analysis.stage === 'done' ? undefined : 'animate-pulse'}
            style={{
              height: '100%',
              width: `${analysisPercent(analysis)}%`,
              background: '#1d9e75',
              transition: 'width 0.3s ease'
            }}
          />
        </div>
      )}
    </div>
  )
}

// A value over a tiny caption. The caption is what makes a bare "95" and a
// bare "11A" readable without the DJ having to know the column order.
function StatCell({ stat }: { stat: TrackStat }): React.JSX.Element {
  return (
    <div
      style={{
        minWidth: '44px',
        padding: '4px 7px',
        borderRadius: '5px',
        background: '#1a1a26',
        border: '0.5px solid #23232f',
        textAlign: 'center'
      }}
    >
      <div
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: stat.color,
          lineHeight: 1.1,
          fontFamily: 'monospace'
        }}
      >
        {stat.value}
      </div>
      <div
        style={{
          fontSize: '8px',
          letterSpacing: '0.6px',
          color: '#3f3f4e',
          marginTop: '2px'
        }}
      >
        {stat.label}
      </div>
    </div>
  )
}
