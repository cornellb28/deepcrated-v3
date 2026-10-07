import React from 'react'
import { useArtistCleanStore } from '../store/useArtistCleanStore'

// A quiet status line for the artist-name cleanup's background work. Only on
// screen while something is running.
const LABELS: Record<string, string> = {
  preview: 'Checking artist names',
  apply: 'Cleaning artist names',
  undo: 'Undoing artist cleanup'
}

export function ArtistCleanProgressRow(): React.JSX.Element | null {
  const progress = useArtistCleanStore((s) => s.progress)
  if (!progress || progress.phase === 'idle') return null
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div style={{ marginBottom: '1rem' }} data-testid="artist-clean-progress">
      <div style={{ color: '#555', marginBottom: '4px', fontSize: '11px' }}>
        {LABELS[progress.phase]}
        {progress.total > 0 ? ` — ${progress.done} of ${progress.total}` : '…'}
      </div>
      <div
        style={{ background: '#1e1e2a', borderRadius: '4px', height: '3px', overflow: 'hidden' }}
      >
        <div
          style={{
            background: '#3a3a55',
            height: '100%',
            width: `${pct}%`,
            transition: 'width 0.2s ease'
          }}
        />
      </div>
    </div>
  )
}
