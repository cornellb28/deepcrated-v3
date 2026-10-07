import React from 'react'

import { BROWSE_CARD_HEIGHT } from '../lib/browse/cardStyle'

interface BrowseCardProps {
  label: string
  count: number
  color: string
  onClick: () => void
  ariaLabel: string
  title?: string
  // Roving focus for keyboard navigation inside a grid: only one card in the
  // grid is a tab stop, arrows move between them.
  tabIndex?: number
  index?: number
  // Optional multi-select (Browse by Tags stacks tags with AND). Absent = the
  // card is a plain button, as on the dashboard.
  selected?: boolean
  onToggleSelected?: () => void
}

export function BrowseCard({
  label,
  count,
  color,
  onClick,
  ariaLabel,
  title,
  tabIndex,
  index,
  selected,
  onToggleSelected
}: BrowseCardProps): React.JSX.Element {
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        title={title}
        tabIndex={tabIndex}
        data-browse-index={index}
        style={{
          position: 'relative',
          isolation: 'isolate',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          height: `${BROWSE_CARD_HEIGHT}px`,
          width: '100%',
          minWidth: 0,
          padding: '14px',
          border: 'none',
          borderRadius: '10px',
          background: color,
          color: '#fff',
          textAlign: 'left',
          fontFamily: 'inherit',
          cursor: 'pointer',
          boxShadow: selected ? 'inset 0 0 0 2px #ffffffcc' : 'inset 0 0 0 1px #ffffff12',
          transition: 'transform 0.15s ease, filter 0.15s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.filter = 'brightness(1.12)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'none'
          e.currentTarget.style.filter = 'none'
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            zIndex: 0,
            width: '92px',
            height: '92px',
            right: '-18px',
            top: '22px',
            borderRadius: '50%',
            background: 'linear-gradient(145deg, #ffffff38, #ffffff08)',
            transform: 'rotate(-24deg)'
          }}
        />
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            fontSize: '15px',
            fontWeight: 600,
            lineHeight: 1.15,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            overflowWrap: 'anywhere'
          }}
        >
          {label}
        </span>
        <span style={{ position: 'relative', zIndex: 1, fontSize: '10px', color: '#ffffffbf' }}>
          {count.toLocaleString()} {count === 1 ? 'track' : 'tracks'}
        </span>
      </button>

      {onToggleSelected && (
        <button
          type="button"
          role="checkbox"
          aria-checked={!!selected}
          aria-label={`${selected ? 'Deselect' : 'Select'} ${label}`}
          tabIndex={tabIndex}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelected()
          }}
          style={{
            position: 'absolute',
            zIndex: 2,
            top: '8px',
            right: '8px',
            width: '20px',
            height: '20px',
            borderRadius: '5px',
            border: '1.5px solid #ffffffcc',
            background: selected ? '#ffffffee' : '#00000040',
            color: color,
            fontSize: '13px',
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'inherit'
          }}
        >
          {selected ? '✓' : ''}
        </button>
      )}
    </div>
  )
}
