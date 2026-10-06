import React from 'react'

interface ViewModeToggleProps {
  mode: 'list' | 'grid'
  onChange: (mode: 'list' | 'grid') => void
}

// Extracted from the old BoardView's per-column list/grid buttons — same look, same
// two-button shape, now shared with anything using useViewMode.
export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: '1px',
        background: '#1a1a26',
        borderRadius: '4px',
        padding: '1px'
      }}
    >
      <button
        onClick={() => onChange('list')}
        title="List view"
        style={{
          background: mode === 'list' ? '#252535' : 'none',
          border: 'none',
          borderRadius: '3px',
          padding: '2px 5px',
          cursor: 'pointer',
          color: mode === 'list' ? '#a09be8' : '#444',
          fontSize: '11px',
          lineHeight: 1
        }}
      >
        ☰
      </button>
      <button
        onClick={() => onChange('grid')}
        title="Grid view"
        style={{
          background: mode === 'grid' ? '#252535' : 'none',
          border: 'none',
          borderRadius: '3px',
          padding: '2px 5px',
          cursor: 'pointer',
          color: mode === 'grid' ? '#a09be8' : '#444',
          fontSize: '11px',
          lineHeight: 1
        }}
      >
        ⊞
      </button>
    </div>
  )
}
