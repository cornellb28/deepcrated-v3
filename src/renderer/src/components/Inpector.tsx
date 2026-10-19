import React, { useRef, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import { useLibraryStore } from '../store/useLibraryStore'
import { Slider } from '@renderer/components/ui/slider'
import { Separator } from '@renderer/components/ui/separator'
import { TagInput } from './TagInput'
import { StagePill } from './StagePill'
import { STAGE_NOUN } from '../lib/stages'
import { Input } from '@renderer/components/ui/input'
import { getYearOptions } from '../utils/years'
import { useArtworkUrl } from '../hooks/useArtworkUrl'
import dclogo from '@renderer/assets/crateIcon.png'
import { fullTrackMeta } from '../lib/tagMeta'
import { refreshArtists } from '../lib/refreshArtists'
import { RelatedTracks } from './RelatedTracks'
import { Bpm } from './Bpm'
import { notifyTrackSaved } from '../lib/trackEvents'

const CAMELOT_KEYS = [
  '1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A', '9A', '10A', '11A', '12A',
  '1B', '2B', '3B', '4B', '5B', '6B', '7B', '8B', '9B', '10B', '11B', '12B',
]

export function Inspector(): React.JSX.Element {
  const {
    tracks,
    activeTrackId,
    setActiveTrack,
    updateTrack,
    setTrackTags,
  } = useLibraryStore()

  const track = tracks.find((t) => t.id === activeTrackId) ?? null
  const isOpen = track !== null
  const titleRef = useRef<HTMLInputElement>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const artworkUrl = useArtworkUrl(track?.artwork_hash, 'full')

  // Prev / next navigation
  const currentIndex = tracks.findIndex((t) => t.id === activeTrackId)
  const prevTrack = currentIndex > 0 ? tracks[currentIndex - 1] : null
  const nextTrack = currentIndex < tracks.length - 1 ? tracks[currentIndex + 1] : null

  async function autoAnalyze(): Promise<void> {
    if (!track || analyzing) return
    setAnalyzing(true)
    try {
      const result = await window.api.analyzeFile(track.filepath)
      if (result.ok && result.data) {
        const { bpm, key_camelot, key_full, duration_sec, duration_str } = result.data
        updateTrack(track.id, { bpm, key_camelot, key_full, duration_sec, duration_str })
        await window.api.db.updateTrackMeta({
          id: track.id,
          bpm,
          key_camelot,
          key_full,
        })
        await window.api.db.markAnalyzed(track.id)
        notifyTrackSaved(track.id)

        // The detected tempo and key have to reach the file as well, or they
        // only ever exist inside DeepCrated — Serato reads BPM off the file's
        // own tags, and off the Serato Autotags block a bpm write also lands.
        const updated = currentTrack()
        if (updated) writeMetaToFile(updated.filepath, fullTrackMeta(updated))
      }
    } catch (err) {
      console.error('Auto-analyze failed:', err)
    } finally {
      setAnalyzing(false)
    }
  }

  async function changeArtwork(): Promise<void> {
    if (!track) return
    const result = await window.api.artwork.pick(track.id)
    if (result.ok && result.hash) {
      updateTrack(track.id, { artwork_hash: result.hash })
    } else if (result.error) {
      toast.error('Could not change artwork', { description: result.error })
    }
  }

  // Preload all tags for this track into store on open
  useEffect(() => {
    if (!activeTrackId) return
    async function preload(): Promise<void> {
      const result = await window.api.tags.forTrack(activeTrackId!)
      setTrackTags(activeTrackId!, result)
    }
    preload()
  }, [activeTrackId])

  // Auto-analyze if BPM or key is missing
  useEffect(() => {
    if (!track) return
    if (!track.bpm || !track.key_camelot) {
      queueMicrotask(() => {
        autoAnalyze()
      })
    }
  }, [activeTrackId])

  // Focus title on open
  useEffect(() => {
    if (isOpen && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
    }
  }, [activeTrackId, isOpen])

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (!isOpen) return
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) return

      if (e.key === 'ArrowUp' && prevTrack) {
        e.preventDefault()
        setActiveTrack(prevTrack.id)
      }
      if (e.key === 'ArrowDown' && nextTrack) {
        e.preventDefault()
        setActiveTrack(nextTrack.id)
      }
      if (e.key === 'Escape') {
        setActiveTrack(null)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, prevTrack, nextTrack, setActiveTrack])

  // The render-time `track` is a snapshot: a save that runs after another
  // field has already been edited would otherwise write that field's old
  // value back to the file. Reading the row out of the store at write time
  // picks up everything updateTrack has applied since.
  function currentTrack(): Track | null {
    if (!track) return null
    return useLibraryStore.getState().tracks.find((t) => t.id === track.id) ?? track
  }

  // Fire and forget: the database write has already landed and the UI has
  // already moved on, so a file write only ever needs to report a failure.
  function writeMetaToFile(filepath: string, meta: EditTagsMeta): void {
    window.api
      .writeTags(filepath, meta)
      .then((result) => {
        if (!result.ok) {
          toast.error('Could not save to file', { description: result.error ?? 'Unknown error' })
          return
        }
        const fileResult = result.results?.[0] as { success?: boolean; error?: string } | undefined
        if (fileResult && fileResult.success === false) {
          toast.error('Could not save to file', {
            description: fileResult.error ?? 'Unknown error',
          })
        }
      })
      .catch((err) => {
        console.error('[Inspector] writeTags failed:', err)
        toast.error('Could not save to file', { description: (err as Error).message })
      })
  }

  async function saveField(field: string, value: string): Promise<void> {
    if (!track) return

    const newValue = field === 'bpm' ? parseFloat(value) || null : value || null
    updateTrack(track.id, { [field]: newValue })

    // Only the field that changed — updateTrackMeta merges onto the row, so
    // restating the rest would just risk writing a stale snapshot back.
    const result = await window.api.db.updateTrackMeta({ id: track.id, [field]: newValue })
    if (!result.ok) {
      toast.error('Could not save', { description: result.error ?? 'Unknown error' })
      return
    }
    // Saved: Related (below) re-ranks shortly after.
    notifyTrackSaved(track.id)

    // energy is DeepCrated-only — no tag carries it, so there is nothing to
    // write to the file for it.
    if (field === 'energy') return

    // Every field goes to the file, not just the one that changed: a track
    // whose tags DeepCrated has never written catches up in one save rather
    // than only ever gaining the field that happened to be typed into.
    const updated = currentTrack()
    if (updated) writeMetaToFile(updated.filepath, fullTrackMeta(updated))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>, field: string): void {
    if (e.key === 'Enter') { saveField(field, e.currentTarget.value); e.currentTarget.blur() }
    if (e.key === 'Escape') { e.currentTarget.blur() }
  }

  return (
    <div
      data-testid="inspector-panel"
      style={{
        width: isOpen ? '260px' : '0px',
        flexShrink: 0,
        background: '#12121a',
        borderLeft: isOpen ? '0.5px solid #1e1e2a' : 'none',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.25s ease',
      }}
    >
      {isOpen && track && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: '260px',
          height: '100%',
          overflow: 'hidden',
        }}>

          {/* Fixed header */}
          <div style={{
            padding: '12px 16px 0 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            flexShrink: 0,
          }}>

            {/* Nav row: previous / position / next centred, close on the
                right. The ↑/↓ keys still move between tracks. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '28px 1fr 28px',
              alignItems: 'center',
            }}>
              <span />
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}>
                <button
                  onClick={() => prevTrack && setActiveTrack(prevTrack.id)}
                  disabled={!prevTrack}
                  title="Previous track (↑)"
                  aria-label="Previous track"
                  style={navButtonStyle(!!prevTrack)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span style={{
                  fontSize: '11px',
                  color: '#e8e8f0',
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: '64px',
                  textAlign: 'center',
                }}>
                  {currentIndex >= 0 ? `${currentIndex + 1} / ${tracks.length}` : ''}
                </span>
                <button
                  onClick={() => nextTrack && setActiveTrack(nextTrack.id)}
                  disabled={!nextTrack}
                  title="Next track (↓)"
                  aria-label="Next track"
                  style={navButtonStyle(!!nextTrack)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <button
                onClick={() => setActiveTrack(null)}
                title="Close (Esc)"
                aria-label="Close track inspector"
                style={{
                  justifySelf: 'end',
                  background: 'none',
                  border: 'none',
                  color: '#c0c0d8',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 4px',
                  lineHeight: 1,
                  borderRadius: '4px'
                }}
              >
                ✕
              </button>
            </div>

            {/* Artwork */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{
              width: '100%',
              aspectRatio: '1',
              borderRadius: '8px',
              overflow: 'hidden',
              background: '#1e1e2a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}>
              {artworkUrl ? (
                <img
                  src={artworkUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <img
                  src={dclogo}
                  alt="DeepCrated"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              )}

              {/* Edit artwork: top right, over the image. */}
              <button
                type="button"
                data-testid="inspector-change-artwork"
                onClick={changeArtwork}
                title="Change artwork"
                aria-label="Change artwork"
                style={{
                  position: 'absolute',
                  top: '6px',
                  right: '6px',
                  zIndex: 1,
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0,0,0,0.6)',
                  color: '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Pencil size={12} />
              </button>

              {/* Analyzing overlay */}
              {analyzing && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}>
                  <div style={{
                    fontSize: '24px',
                    color: '#7f77dd',
                    animation: 'spin 1s linear infinite',
                  }}>⟳</div>
                  <span style={{ fontSize: '11px', color: '#a09be8' }}>
                    Detecting BPM + key...
                  </span>
                </div>
              )}
            </div>
            </div>

            {/* Now inspecting: always visible while the fields below scroll. */}
            {/* Now inspecting, with the tempo beside it: the first thing the eye
                lands on. Both stay visible while the fields below scroll. */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}
            >
            <div data-testid="inspector-now" style={{ minWidth: 0, flex: 1 }}>
              <div
                title={track.title ?? undefined}
                style={{
                  fontSize: '13px',
                  fontWeight: 500,
                  color: '#e0e0f0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {track.title || 'Untitled'}
              </div>
              <div
                title={track.artist ?? undefined}
                style={{
                  fontSize: '11px',
                  color: '#777',
                  marginTop: '2px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {track.artist || 'Unknown artist'}
              </div>
            </div>
            <Bpm
              key={`bpm-${track.id}-${track.bpm}`}
              size="inspector"
              value={track.bpm}
              editable
              busy={analyzing}
              onChange={(v) => saveField('bpm', v)}
              testId="inspector-field-bpm"
            />
            </div>

            <Separator className="bg-[#1e1e2a]" />
          </div>

          {/* Scrollable editing section */}
          <div style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '12px 16px'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

              <EditField
                ref={titleRef}
                data-testid="inspector-field-title"
                label="Title"
                defaultValue={track.title ?? ''}
                onSave={(v) => saveField('title', v)}
                onKeyDown={(e) => onKeyDown(e, 'title')}
              />

              {/* Stage — workflow state, not metadata, so it sits above the
                  tag fields rather than among them. Same click-to-cycle as
                  the pill on the row and the card. */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  letterSpacing: '0.6px',
                  textTransform: 'uppercase',
                  color: '#444',
                }}>
                  {STAGE_NOUN}
                </span>
                <StagePill track={track} variant="pill" size="md" />
              </div>

              <TagInput trackId={track.id} field="artist" label="Artist" color="#d4537e" />
              <TagInput trackId={track.id} field="genre" label="Genre" color="#9b8ed4" />
              <TagInput trackId={track.id} field="comment" label="Comment" color="#7f77dd" />
              <TagInput trackId={track.id} field="grouping" label="Grouping" color="#1d9e75" />
              <TagInput trackId={track.id} field="remixer" label="Remixer" color="#d85a30" />
              <TagInput trackId={track.id} field="label" label="Label" color="#378add" />
              <TagInput trackId={track.id} field="composer" label="Composer" color="#ba7517" />
              <TagInput trackId={track.id} field="album" label="Album" color="#888780" />

              {/* Key */}
              <div>
                <label className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
                  Key
                </label>
                <select
                  key={`key-${track.id}-${track.key_camelot}`}
                  data-testid="inspector-field-key"
                  defaultValue={track.key_camelot ?? ''}
                  disabled={analyzing}
                  onChange={(e) => saveField('key_camelot', e.target.value)}
                  style={{
                    width: '100%',
                    background: '#1a1a26',
                    border: '0.5px solid #252535',
                    borderRadius: '5px',
                    padding: '5px 8px',
                    color: track.key_camelot ? '#c0c0d8' : '#555',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    outline: 'none',
                    cursor: analyzing ? 'wait' : 'pointer',
                    height: '28px',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = '#7f77dd')}
                  onBlur={(e) => (e.target.style.borderColor = '#252535')}
                >
                  <option value="">
                    {analyzing ? 'Detecting...' : '— pick key —'}
                  </option>
                  {CAMELOT_KEYS.map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>

              {/* Energy */}
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
                  Energy
                </label>
                <div className="flex items-center gap-3">
                  <Slider
                    defaultValue={[track.energy ?? 5]}
                    min={1} max={10} step={1}
                    onValueCommit={(val) => saveField('energy', val[0].toString())}
                    className="flex-1"
                  />
                  <span className="text-xs font-mono text-muted-foreground w-4 text-right">
                    {track.energy ?? '—'}
                  </span>
                </div>
              </div>

              {/* Year */}
              <div>
                <div style={{
                  fontSize: '10px',
                  fontWeight: 500,
                  letterSpacing: '0.8px',
                  textTransform: 'uppercase',
                  color: '#333',
                  marginBottom: '3px',
                }}>
                  Year
                </div>
                <select
                  key={`year-${track.id}`}
                  defaultValue={track.year ?? String(new Date().getFullYear())}
                  onChange={(e) => saveField('year', e.target.value)}
                  style={{
                    width: '100%',
                    background: '#1a1a26',
                    border: '0.5px solid #252535',
                    borderRadius: '5px',
                    padding: '5px 8px',
                    color: '#c0c0d8',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    outline: 'none',
                    cursor: 'pointer',
                    height: '28px',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = '#7f77dd')}
                  onBlur={(e) => (e.target.style.borderColor = '#252535')}
                >
                  {getYearOptions().map((year) => (
                    <option key={year} value={String(year)}>{year}</option>
                  ))}
                </select>
              </div>

            </div>
          </div>

          {/* Fixed footer */}
          <div style={{
            padding: '0 16px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            flexShrink: 0,
          }}>
            <Separator className="bg-[#1e1e2a]" />
            <ReadField label="Format" value={track.format} />
            {track.artist_raw && track.artist_raw !== track.artist && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: '#555' }}>
                  Imported as <span style={{ color: '#c0c0d8' }}>{track.artist_raw}</span>
                </span>
                <button
                  type="button"
                  data-testid="restore-original-artist"
                  onClick={async () => {
                    const r = await window.api.artist.restoreOriginal(track.id)
                    if (!r.ok) {
                      toast.error('Could not restore the original', { description: r.error })
                      return
                    }
                    await refreshArtists([track.id])
                    toast.success('Original artist restored')
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#7f77dd',
                    fontSize: '11px',
                    cursor: 'pointer',
                    padding: 0,
                    fontFamily: 'inherit',
                    flexShrink: 0
                  }}
                >
                  Restore
                </button>
              </div>
            )}
            <Separator className="bg-[#1e1e2a]" />
            <label
              style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
              title="Never included in anonymous stats, even when sharing is on"
            >
              <input
                type="checkbox"
                data-testid="inspector-keep-private"
                checked={track.stats_private === 1}
                onChange={async (e) => {
                  const next = e.target.checked
                  const result = await window.api.privacy.setTrackPrivate([track.id], next)
                  if (result.ok) updateTrack(track.id, { stats_private: next ? 1 : 0 })
                  else toast.error('Could not change privacy', { description: result.error })
                }}
              />
              <span style={{ fontSize: '12px', color: '#c0c0d8' }}>Keep private</span>
            </label>
            <Separator className="bg-[#1e1e2a]" />
            <div>
              <div style={{
                fontSize: '10px',
                fontWeight: 500,
                letterSpacing: '0.8px',
                textTransform: 'uppercase',
                color: '#333',
                marginBottom: '4px',
              }}>
                File path
              </div>
              <div style={{
                fontSize: '10px',
                color: '#444',
                wordBreak: 'break-all',
                lineHeight: 1.5,
              }}>
                {track.filepath}
              </div>
            </div>
            <Separator className="bg-[#1e1e2a]" />
            <RelatedTracks trackId={track.id} />
          </div>

        </div>
      )}
    </div>
  )
}

// ─── EditField ────────────────────────────────────────────

interface EditFieldProps {
  label: string
  defaultValue: string
  onSave: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  'data-testid'?: string
}

const EditField = React.forwardRef<HTMLInputElement, EditFieldProps>(
  ({ label, defaultValue, onSave, onKeyDown, 'data-testid': testId }, ref) => (
    <div>
      <label className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground">
        {label}
      </label>
      <Input
        ref={ref}
        data-testid={testId}
        defaultValue={defaultValue}
        onBlur={(e) => onSave(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target.select()}
        className="h-7 text-xs font-mono bg-[#1a1a26] border-[#252535] text-[#c0c0d8] focus-visible:ring-[#7f77dd]"
      />
    </div>
  )
)
EditField.displayName = 'EditField'

// ─── ReadField ────────────────────────────────────────────

function ReadField({
  label,
  value,
}: {
  label: string
  value?: string | null
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.6px',
        textTransform: 'uppercase',
        color: '#444',
      }}>
        {label}
      </span>
      <span style={{ fontSize: '12px', color: '#c0c0d8' }}>{value}</span>
    </div>
  )
}

// ─── Nav buttons ──────────────────────────────────────────

// Wide hit area, white when there is somewhere to go.
function navButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '24px',
    background: enabled ? '#1a1a26' : 'none',
    border: `0.5px solid ${enabled ? '#2a2a3a' : 'transparent'}`,
    borderRadius: '6px',
    color: enabled ? '#e8e8f0' : '#3a3a4a',
    cursor: enabled ? 'pointer' : 'default',
    padding: 0,
  }
}
