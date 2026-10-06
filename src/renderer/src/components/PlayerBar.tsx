import React, { useRef, useEffect } from 'react'
import { usePlayerStore } from '../store/usePlayerStore'
import { useLibraryStore } from '../store/useLibraryStore'
import { Slider } from '@renderer/components/ui/slider'

const BAR_COUNT = 120

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function parseWaveform(raw: string | null): number[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function PlayerBar(): React.JSX.Element | null {
  const {
    currentTrack,
    isPlaying,
    volume,
    currentTime,
    duration,
    setIsPlaying,
    togglePlayPause,
    setVolume,
    setCurrentTime,
    setDuration,
    playTrack
  } = usePlayerStore()
  const { tracks } = useLibraryStore()
  const audioRef = useRef<HTMLAudioElement>(null)

  // src is built from the track's on-disk filepath via the `audio://`
  // protocol registered in main — no server port to look up, same idea
  // useArtworkUrl relies on for `artwork://`. The path travels as a `path`
  // query param rather than the URL's own path/host: `audio` is registered
  // as a "standard" scheme (Chromium's <audio> element requires that for
  // range-request streaming to work at all), and a standard scheme's parser
  // swallows the first path segment after `audio://` as a hostname — which
  // would silently lowercase and truncate a real absolute path.
  const trackUrl = currentTrack?.filepath
    ? `audio://track?path=${encodeURIComponent(currentTrack.filepath)}`
    : null

  // Single consolidated effect — never calls play() without a real src.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    if (!trackUrl) {
      audio.pause()
      return
    }

    if (audio.src !== trackUrl) {
      audio.src = trackUrl
      audio.load()
      if (isPlaying) {
        audio.play().catch((err) => console.error('[PlayerBar] play error:', err))
      }
    } else {
      if (isPlaying) audio.play().catch((err) => console.error('[PlayerBar] play error:', err))
      else audio.pause()
    }
  }, [trackUrl, isPlaying])

  // Volume stays separate — no side-effects on playback
  useEffect(() => {
    const audio = audioRef.current
    if (audio) audio.volume = volume
  }, [volume])

  // Remembers the last non-zero volume so M can toggle mute/unmute back to it.
  const lastVolumeRef = useRef(volume > 0 ? volume : 0.8)
  useEffect(() => {
    if (volume > 0) lastVolumeRef.current = volume
  }, [volume])

  // Single canonical source for these shortcuts — PlayerBar is always
  // mounted, so any other component adding its own Space/etc. listener
  // would double-fire alongside this one.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!currentTrack) return
      const target = e.target as HTMLElement | null
      const inInput = !!target && target.closest('input, textarea, [contenteditable]') != null
      if (inInput) return

      if (e.key === ' ') {
        e.preventDefault()
        togglePlayPause()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const audio = audioRef.current
        if (!audio || !isFinite(audio.duration)) return
        const delta = e.key === 'ArrowLeft' ? -10 : 10
        const t = Math.max(0, Math.min(audio.duration, audio.currentTime + delta))
        audio.currentTime = t
        setCurrentTime(t)
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        setVolume(volume > 0 ? 0 : lastVolumeRef.current)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [currentTrack, togglePlayPause, setCurrentTime, setVolume, volume])

  if (!currentTrack) return null

  const progress = duration > 0 ? currentTime / duration : 0

  const raw = parseWaveform(currentTrack.waveform)
  const wavePoints = Array.from({ length: BAR_COUNT }, (_, i) => {
    if (!raw || raw.length === 0) return 0.3
    return raw[Math.floor((i * raw.length) / BAR_COUNT)] ?? 0
  })
  const maxAmp = Math.max(...wavePoints, 0.01)
  const playedBars = Math.round(progress * BAR_COUNT)

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const audio = audioRef.current
    if (audio && isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration
      setCurrentTime(ratio * audio.duration)
    }
  }

  const queue = tracks.filter((t) => t.filepath && !t.missing)
  const currentIdx = queue.findIndex((t) => t.id === currentTrack.id)
  const hasPrev = currentIdx > 0
  const hasNext = currentIdx >= 0 && currentIdx < queue.length - 1

  const playNext = (): void => {
    if (hasNext) playTrack(queue[currentIdx + 1])
  }
  const playPrev = (): void => {
    if (currentIdx > 0) playTrack(queue[currentIdx - 1])
  }

  return (
    <div
      data-testid="player-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '8px 16px',
        background: '#13131b',
        borderTop: '0.5px solid #1e1e2a',
        flexShrink: 0
      }}
    >
      <audio
        data-testid="player-audio"
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onEnded={playNext}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={(e) => {
          const err = e.currentTarget.error
          console.error(
            '[PlayerBar] audio error code:',
            err?.code,
            'message:',
            err?.message,
            'src:',
            e.currentTarget.src
          )
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <button
          onClick={playPrev}
          disabled={!hasPrev}
          title="Previous"
          style={playerBtnStyle(hasPrev)}
        >
          ⏮
        </button>
        <button
          onClick={togglePlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
          style={{
            ...playerBtnStyle(true),
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            background: '#7f77dd',
            color: '#fff'
          }}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={playNext} disabled={!hasNext} title="Next" style={playerBtnStyle(hasNext)}>
          ⏭
        </button>
      </div>

      <div style={{ width: '160px', flexShrink: 0, overflow: 'hidden' }}>
        <div
          style={{
            fontSize: '12px',
            fontWeight: 500,
            color: '#e0e0f0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {currentTrack.title ?? currentTrack.filename ?? 'Untitled'}
        </div>
        <div
          style={{
            fontSize: '11px',
            color: '#666',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {currentTrack.artist ?? ''}
          {currentTrack.format ? ` · ${currentTrack.format}` : ''}
          {currentTrack.bpm ? ` · ${currentTrack.bpm} BPM` : ''}
          {currentTrack.key_camelot ? ` · ${currentTrack.key_camelot}` : ''}
        </div>
      </div>

      <div
        onClick={handleSeek}
        title="Click to seek"
        style={{
          flex: 1,
          height: '38px',
          display: 'flex',
          alignItems: 'flex-end',
          gap: '1px',
          cursor: 'pointer',
          position: 'relative'
        }}
      >
        {wavePoints.map((h, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.max(2, Math.round((h / maxAmp) * 38))}px`,
              background: i < playedBars ? '#7f77dd' : '#2a2a3a',
              borderRadius: '1px'
            }}
          />
        ))}
      </div>

      <div
        style={{
          fontSize: '11px',
          color: '#666',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
          display: 'flex',
          gap: '4px'
        }}
      >
        <span>{formatTime(currentTime)}</span>
        <span style={{ color: '#333' }}>/</span>
        <span>{formatTime(duration)}</span>
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '110px', flexShrink: 0 }}
      >
        <span style={{ fontSize: '13px', color: '#555' }}>
          {volume === 0 ? '🔇' : volume < 0.4 ? '🔉' : '🔊'}
        </span>
        <Slider
          value={[volume]}
          min={0}
          max={1}
          step={0.01}
          onValueChange={(v) => setVolume(v[0])}
          className="flex-1"
        />
      </div>
    </div>
  )
}

function playerBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: enabled ? '#aaa' : '#333',
    fontSize: '15px',
    cursor: enabled ? 'pointer' : 'default',
    padding: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  }
}
