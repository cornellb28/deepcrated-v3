import React from 'react'
import { useLibraryStore } from '../store/useLibraryStore'
import { ImportDropzone } from './ImportDropzone'
import { Input } from '@renderer/components/ui/input'
import type { View } from './Sidebar'
import { NotificationBell } from './NotificationBell'

interface ToolbarProps {
  onImportFolder: (path: string) => void
  onImportFiles: (paths: string[]) => void
  activeView: View
}

const BPM_RANGES: { label: string; range: [number, number] }[] = [
  { label: '<90', range: [0, 90] },
  { label: '90–110', range: [90, 110] },
  { label: '110–120', range: [110, 120] },
  { label: '120–128', range: [120, 128] },
  { label: '128–135', range: [128, 135] },
  { label: '135–145', range: [135, 145] },
  { label: '145+', range: [145, Infinity] }
]

export function Toolbar({ onImportFolder, activeView, onImportFiles }: ToolbarProps): React.JSX.Element {
  const { isAnalyzing, tracks, searchQuery, setSearchQuery, bpmRange, setBpmRange } = useLibraryStore()
  // The list/grid toggle used to live here, on a single 'all_tracks' key.
  // It now sits in TrackTabBar instead, because the choice is per tab.

  function toggleBpmRange(range: [number, number]): void {
    const isActive = bpmRange?.[0] === range[0] && bpmRange?.[1] === range[1]
    setBpmRange(isActive ? null : range)
  }

  return (
    <div
      style={{
        background: '#13131b',
        borderBottom: '0.5px solid #1e1e2a',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexShrink: 0
      }}>
      <ImportDropzone
        onImportFolder={onImportFolder}
        onImportFiles={onImportFiles}
        disabled={isAnalyzing}
      />

      {activeView === 'library' && (
        <div className="relative flex gap-4 items-center justify-between">
          {/* Search — shorter, shares row with BPM */}
          <div style={{ position: 'relative', width: '400px', flexShrink: 0 }}>
            <Input
              data-testid="search-input"
              type="text"
              placeholder="Search title or tag..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#1a1a26] border-[#252535] text-[#e8e8f0] placeholder:text-[#444] h-7 text-xs font-mono"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: '6px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#444',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: 0
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* BPM range buttons */}
          <div style={{
            display: 'flex',
            gap: '3px',
            flex: 1,
            flexWrap: 'wrap',
          }}>
            {BPM_RANGES.map(({ label, range }) => {
              const isActive = bpmRange?.[0] === range[0] && bpmRange?.[1] === range[1]
              return (
                <button
                  key={label}
                  onClick={() => toggleBpmRange(range)}
                  style={{
                    background: isActive ? '#7f77dd' : '#1a1a26',
                    border: `0.5px solid ${isActive ? '#7f77dd' : '#252535'}`,
                    borderRadius: '4px',
                    color: isActive ? '#fff' : '#555',
                    fontSize: '10px',
                    fontFamily: 'monospace',
                    padding: '3px 7px',
                    cursor: 'pointer',
                    transition: 'all 0.1s',
                    whiteSpace: 'nowrap',
                    height: '22px'
                  }}
                >
                  {label}
                </button>
              )
            })}

            {/* Clear filter indicator */}
            {bpmRange && (
              <button
                onClick={() => setBpmRange(null)}
                style={{
                  background: 'none',
                  border: '0.5px solid #333',
                  borderRadius: '4px',
                  color: '#555',
                  fontSize: '10px',
                  padding: '3px 7px',
                  cursor: 'pointer',
                  height: '22px'
                }}
              >
                ✕ clear
              </button>
            )}
          </div>
        </div>
      )}
      <span style={{ color: '#444', fontSize: '12px', marginLeft: 'auto' }}>
        {tracks.length} tracks
      </span>

      {/* Whatever the view, the watcher's review queue is reachable from
          here — it used to be findable only from Settings > Library, which
          a DJ would open only if they already suspected something. */}
      <NotificationBell />
    </div>
  )
}
