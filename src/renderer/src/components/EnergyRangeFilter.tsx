// ── Energy range filter ───────────────────────────────────────────────────
// Min–max over the DJ's energy rating (inclusive), plus whether unrated
// tracks pass. null = no filter. A two-thumb slider (arrow keys move the
// focused thumb), so it is keyboard-operable like the rest. Used by the
// library toolbar and the Crate Health panel; the rule itself is
// energyInRange in shared/energy.ts.

import React from 'react'
import { Slider } from '@renderer/components/ui/slider'
import {
  ENERGY_MAX,
  ENERGY_MIN,
  FULL_ENERGY_RANGE,
  clampEnergyRange,
  type EnergyRange
} from '../../../shared/energy'

export function EnergyRangeFilter({
  value,
  onChange,
  testId
}: {
  value: EnergyRange | null
  onChange: (next: EnergyRange | null) => void
  testId?: string
}): React.JSX.Element {
  const range = value ?? FULL_ENERGY_RANGE
  const active = value !== null
  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}
    >
      <span
        style={{
          fontSize: '10px',
          letterSpacing: '0.6px',
          textTransform: 'uppercase',
          color: active ? '#d4537e' : '#555'
        }}
      >
        Energy
      </span>
      <Slider
        aria-label="Energy range"
        min={ENERGY_MIN}
        max={ENERGY_MAX}
        step={1}
        minStepsBetweenThumbs={0}
        value={[range.min, range.max]}
        onValueChange={([min, max]) =>
          onChange(clampEnergyRange({ min, max, includeUnset: range.includeUnset }))
        }
        className="w-[96px]"
        style={{ opacity: active ? 1 : 0.55 }}
      />
      <span
        aria-live="polite"
        style={{
          fontSize: '10px',
          fontFamily: 'monospace',
          color: active ? '#e8e8f0' : '#555',
          minWidth: '30px'
        }}
      >
        {active ? (range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`) : 'any'}
      </span>
      {active && (
        <>
          <label
            title="Also show tracks you have not rated"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '10px',
              color: '#8a8aa0',
              cursor: 'pointer'
            }}
          >
            <input
              type="checkbox"
              checked={range.includeUnset}
              onChange={(e) => onChange({ ...range, includeUnset: e.target.checked })}
            />
            unrated
          </label>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear energy filter"
            style={{
              background: 'none',
              border: '0.5px solid #333',
              borderRadius: '4px',
              color: '#8a8aa0',
              fontSize: '10px',
              padding: '2px 6px',
              cursor: 'pointer'
            }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  )
}
