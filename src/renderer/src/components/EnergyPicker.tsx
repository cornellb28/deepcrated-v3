// ── Energy picker ─────────────────────────────────────────────────────────
// The DJ's energy rating, ENERGY_MIN..ENERGY_MAX, with an explicit "—" for
// unset (null), so an unrated track never looks rated. A radio group:
// ←/→ step, Home/End jump to the ends, Delete or Backspace clears.
// Used by the Inspector and the edit modal (single track or bulk).

import React, { useRef } from 'react'
import { ENERGY_MAX, ENERGY_MIN, toEnergy } from '../../../shared/energy'

const VALUES = Array.from({ length: ENERGY_MAX - ENERGY_MIN + 1 }, (_, i) => ENERGY_MIN + i)
const ACCENT = '#d4537e' // the energy colour on rows and cards

export function EnergyPicker({
  value,
  onChange,
  disabled = false,
  label = 'Energy',
  testId
}: {
  value: number | null | undefined
  onChange: (value: number | null) => void
  disabled?: boolean
  label?: string
  testId?: string
}): React.JSX.Element {
  const current = toEnergy(value)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const options: (number | null)[] = [null, ...VALUES]
  const index = options.indexOf(current)

  function pick(next: number | null, focus = false): void {
    if (disabled) return
    onChange(next)
    if (focus) refs.current[options.indexOf(next)]?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    let next: number | null | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      next = options[Math.min(options.length - 1, index + 1)]
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      next = options[Math.max(0, index - 1)]
    } else if (e.key === 'Home') next = ENERGY_MIN
    else if (e.key === 'End') next = ENERGY_MAX
    else if (e.key === 'Delete' || e.key === 'Backspace') next = null
    else return
    e.preventDefault()
    e.stopPropagation()
    pick(next, true)
  }

  return (
    <div
      role="radiogroup"
      aria-label={`${label}, ${ENERGY_MIN} to ${ENERGY_MAX}`}
      aria-disabled={disabled}
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={{ display: 'flex', gap: '2px', opacity: disabled ? 0.5 : 1 }}
    >
      {options.map((v, i) => {
        const active = v === current
        return (
          <button
            key={v ?? 'unset'}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={v === null ? 'No energy (unset)' : `Energy ${v}`}
            title={v === null ? 'Unset' : `Energy ${v}`}
            tabIndex={active || (current === null && v === null) ? 0 : -1}
            disabled={disabled}
            onClick={() => pick(v)}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7f77dd]"
            style={{
              flex: v === null ? '0 0 22px' : 1,
              minWidth: 0,
              height: '22px',
              borderRadius: '4px',
              border: `0.5px solid ${active ? ACCENT : '#252535'}`,
              background: active
                ? v === null
                  ? '#252535'
                  : ACCENT
                : v !== null && current !== null && v < current
                  ? '#d4537e33'
                  : '#1a1a26',
              color: active ? '#fff' : '#8a8aa0',
              fontSize: '10px',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              cursor: disabled ? 'default' : 'pointer',
              padding: 0
            }}
          >
            {v === null ? '—' : v}
          </button>
        )
      })}
    </div>
  )
}
