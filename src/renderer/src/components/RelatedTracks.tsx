import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import { useLibraryStore } from '../store/useLibraryStore'
import { usePlayerStore } from '../store/usePlayerStore'
import { useMatchStore } from '../store/useMatchStore'
import { onTrackSavedDebounced } from '../lib/trackEvents'

// Inspector > Related: the best next tracks for this one, scored by Track
// Match against the DJ's Mix Profile (main/trackMatchService.ts). Re-ranks
// RERANK_DELAY_MS after a successful save or tag change on this track.
// Left/Right move between cards and Enter opens one — Up/Down already move
// between tracks — and keys are ignored while a text field has focus.
// Hovering a card shows a play button that previews it without leaving the
// track being inspected.

const RERANK_DELAY_MS = 400

const DIRECTIONS: { id: MatchDirection; label: string; hint: string }[] = [
  {
    id: 'lift',
    label: 'Lift',
    hint: 'One step up in energy (or higher BPM when energy is not set)'
  },
  { id: 'similar', label: 'Similar', hint: 'Same energy' },
  {
    id: 'drop',
    label: 'Drop',
    hint: 'One step down in energy (or lower BPM when energy is not set)'
  }
]

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

export function RelatedTracks({ trackId }: { trackId: number }): React.JSX.Element {
  const setActiveTrack = useLibraryStore((s) => s.setActiveTrack)
  const direction = useMatchStore((s) => s.direction)
  const setDirection = useMatchStore((s) => s.setDirection)
  const [result, setResult] = useState<RelatedResult | null>(null)
  const [selected, setSelected] = useState(0)
  // The hovered card's reasons, drawn fixed to the window: the list scrolls
  // sideways, which would clip a tooltip drawn inside it.
  const [hovered, setHovered] = useState<{ item: RelatedItem; x: number; y: number } | null>(null)
  const requestSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    const next = await window.api.match.related(trackId, direction)
    if (seq !== requestSeq.current) return // a newer request is in flight
    setResult(next)
    setSelected(0)
  }, [trackId, direction])

  useEffect(() => {
    void load()
  }, [load])

  // Live re-rank after this track's data is saved.
  useEffect(
    () => onTrackSavedDebounced(trackId, RERANK_DELAY_MS, () => void load()),
    [trackId, load]
  )

  const items = useMemo(() => (result?.status === 'ok' ? result.results : []), [result])

  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (items.length === 0 || isTyping(e.target)) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        setSelected((i) => {
          const next = Math.max(
            0,
            Math.min(items.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))
          )
          listRef.current
            ?.querySelectorAll<HTMLElement>('[data-related-card]')
            [next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          return next
        })
      } else if (e.key === 'Enter' && items[selected]) {
        e.preventDefault()
        setActiveTrack(items[selected].id)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [items, selected, setActiveTrack])

  return (
    <div data-testid="related-tracks">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px'
        }}
      >
        <div
          style={{
            fontSize: '10px',
            fontWeight: 500,
            letterSpacing: '0.8px',
            textTransform: 'uppercase',
            color: '#333'
          }}
        >
          Related
        </div>
        <div
          role="radiogroup"
          aria-label="Direction"
          style={{
            display: 'flex',
            background: '#13131b',
            border: '0.5px solid #252535',
            borderRadius: '6px',
            padding: '2px'
          }}
        >
          {DIRECTIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={direction === d.id}
              title={d.hint}
              data-testid={`related-direction-${d.id}`}
              onClick={() => setDirection(d.id)}
              style={{
                fontSize: '10px',
                padding: '2px 8px',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: direction === d.id ? '#252535' : 'transparent',
                color: direction === d.id ? '#c0c0d8' : '#555'
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {result === null && <div style={{ fontSize: '11px', color: '#444' }}>Finding matches…</div>}

      {result?.status === 'needs-key-bpm' && (
        <div data-testid="related-needs-key-bpm" style={{ fontSize: '11px', color: '#555' }}>
          Add a key and BPM to this track to see related tracks.
        </div>
      )}

      {result?.status === 'ok' && items.length === 0 && (
        <div style={{ fontSize: '11px', color: '#555' }}>
          No tracks fit your key and BPM rules. Widen them in Settings › Mixing.
        </div>
      )}

      {result?.status === 'ok' && items.length > 0 && (
        <>
          {(result.directionByBpm || result.coldStart) && (
            <div style={{ fontSize: '10px', color: '#444', marginBottom: '6px' }}>
              {result.coldStart
                ? 'Matching on key and BPM only — tag more tracks to use your tag priorities.'
                : 'No energy set, so Lift and Drop use BPM.'}
            </div>
          )}
          <div
            ref={listRef}
            data-testid="related-list"
            style={{
              display: 'flex',
              gap: '8px',
              overflowX: 'auto',
              paddingBottom: '6px',
              position: 'relative'
            }}
          >
            {items.map((item, index) => (
              <RelatedCard
                key={item.id}
                item={item}
                active={index === selected}
                onHover={(rect) => setHovered(rect ? { item, x: rect.left, y: rect.top } : null)}
                onOpen={() => setActiveTrack(item.id)}
              />
            ))}
          </div>
          {hovered && hovered.item.reasons.length > 0 && (
            <div
              role="tooltip"
              data-testid="related-reasons"
              style={{
                position: 'fixed',
                left: hovered.x,
                top: hovered.y - 6,
                transform: 'translateY(-100%)',
                zIndex: 50,
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px',
                maxWidth: '220px',
                padding: '6px',
                background: '#13131b',
                border: '0.5px solid #252535',
                borderRadius: '6px',
                pointerEvents: 'none'
              }}
            >
              {hovered.item.reasons.map((r) => (
                <span
                  key={r}
                  style={{
                    fontSize: '10px',
                    color: '#a09be8',
                    background: '#7f77dd22',
                    borderRadius: '4px',
                    padding: '1px 5px'
                  }}
                >
                  {r}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RelatedCard({
  item,
  active,
  onHover,
  onOpen
}: {
  item: RelatedItem
  active: boolean
  onHover: (rect: DOMRect | null) => void
  onOpen: () => void
}): React.JSX.Element {
  const art = useArtworkUrl(item.artwork_hash, 'thumb')
  const [hovered, setHovered] = useState(false)
  const isCurrent = usePlayerStore((s) => s.currentTrack?.id === item.id)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playing = isCurrent && isPlaying

  // The list holds scoring fields only, so the full track is looked up to
  // play it: from the loaded library first, from the database otherwise.
  async function handlePlay(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    const player = usePlayerStore.getState()
    if (isCurrent) {
      player.togglePlayPause()
      return
    }
    const track =
      useLibraryStore.getState().tracks.find((t) => t.id === item.id) ??
      (await window.api.db.trackById(item.id))
    if (!track || track.missing || !track.filepath) return
    player.playTrack(track)
  }

  return (
    <div
      role="button"
      tabIndex={-1}
      data-related-card
      data-testid="related-card"
      onClick={onOpen}
      onMouseEnter={(e) => {
        setHovered(true)
        onHover(e.currentTarget.getBoundingClientRect())
      }}
      onMouseLeave={() => {
        setHovered(false)
        onHover(null)
      }}
      aria-label={`${item.title ?? 'Untitled'}${item.artist ? ` by ${item.artist}` : ''}`}
      style={{
        position: 'relative',
        flex: '0 0 92px',
        width: '92px',
        padding: '4px',
        background: active ? '#1e1e2a' : 'transparent',
        border: `0.5px solid ${active ? '#7f77dd' : 'transparent'}`,
        borderRadius: '6px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '84px',
          height: '84px',
          borderRadius: '4px',
          background: '#1a1a26',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {art ? (
          <img src={art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: '20px', color: '#333' }}>♪</span>
        )}
        <button
          type="button"
          data-testid="related-play"
          onClick={(e) => void handlePlay(e)}
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause track' : 'Play track'}
          style={{
            position: 'absolute',
            inset: 0,
            margin: 'auto',
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            border: 'none',
            background: isCurrent ? '#7f77dd' : 'rgba(0,0,0,0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isCurrent || hovered ? 1 : 0,
            transition: 'opacity 0.15s'
          }}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
      </div>
      <div
        style={{
          fontSize: '11px',
          color: '#c0c0d8',
          marginTop: '4px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {item.title ?? 'Untitled'}
      </div>
      <div
        style={{
          fontSize: '10px',
          color: '#555',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {item.artist ?? ''}
      </div>
    </div>
  )
}
