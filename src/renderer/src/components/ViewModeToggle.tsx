import React, { useRef } from 'react'

interface ViewModeToggleProps {
  mode: 'list' | 'grid'
  onChange: (mode: 'list' | 'grid') => void
  // Text segments ("Grid | List") instead of the compact icons.
  labelled?: boolean
  // What the control is choosing the view of, for screen readers.
  label?: string
}

const OPTIONS = {
  list: { text: 'List', icon: '☰' },
  grid: { text: 'Grid', icon: '⊞' }
} as const

// Extracted from the old BoardView's per-column list/grid buttons, now shared
// with anything using useViewMode. A radio group: arrow keys move between
// the two (and switch), the active one is announced as selected, and the
// focus ring is visible.
export function ViewModeToggle({
  mode,
  onChange,
  labelled = false,
  label = 'View'
}: ViewModeToggleProps): React.JSX.Element {
  const order: ('list' | 'grid')[] = labelled ? ['grid', 'list'] : ['list', 'grid']
  const refs = useRef<Partial<Record<'list' | 'grid', HTMLButtonElement | null>>>({})

  function onKeyDown(e: React.KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    const next = mode === 'list' ? 'grid' : 'list'
    onChange(next)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={`${label}: list or grid`}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        gap: '1px',
        background: '#1a1a26',
        borderRadius: '4px',
        padding: '1px',
        flexShrink: 0
      }}
    >
      {order.map((value) => {
        const active = mode === value
        const { text, icon } = OPTIONS[value]
        return (
          <button
            key={value}
            ref={(el) => {
              refs.current[value] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-testid={`view-mode-${value}`}
            onClick={() => onChange(value)}
            title={`${text} view`}
            aria-label={`${text} view`}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7f77dd]"
            style={{
              background: active ? '#252535' : 'none',
              border: 'none',
              borderRadius: '3px',
              padding: labelled ? '3px 10px' : '2px 5px',
              cursor: 'pointer',
              color: active ? '#a09be8' : '#8a8aa0',
              fontSize: '11px',
              fontFamily: 'inherit',
              lineHeight: 1
            }}
          >
            {labelled ? text : icon}
          </button>
        )
      })}
    </div>
  )
}
