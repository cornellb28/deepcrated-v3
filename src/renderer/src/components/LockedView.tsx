import React from 'react'
import { Lock } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

// A whole cloud surface that the current plan does not include: shown in
// place of (or beside) the feature, never instead of explaining it. CLOUD
// features only — the desktop app is free and nothing local is ever locked.

interface LockedViewProps {
  title: string
  description: string
  // Plan name that unlocks it, e.g. 'Library or Touring'.
  requires: string
  actionLabel?: string
  // Routes to Settings > Plan (or opens the website's plans, from the Plan
  // page itself). Omit and no button is shown.
  onAction?: () => void
}

export function LockedView({
  title,
  description,
  requires,
  actionLabel = 'See plans',
  onAction
}: LockedViewProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
        padding: '14px',
        background: '#16161f',
        border: '0.5px dashed #2f2f45',
        borderRadius: '6px'
      }}
    >
      <Lock size={16} color="#7f77dd" aria-hidden="true" style={{ marginTop: '2px' }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '12px', color: '#c0c0d8' }}>{title}</div>
        <div style={{ fontSize: '11px', color: '#777', lineHeight: 1.6, marginTop: '3px' }}>
          {description}
        </div>
        <div style={{ fontSize: '10px', color: '#a09ae8', marginTop: '6px' }}>
          Available on {requires}
        </div>
      </div>
      {onAction && (
        <Button onClick={onAction} variant="outline" size="sm">
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
