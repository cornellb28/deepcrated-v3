import React from 'react'
import { Lock } from 'lucide-react'

// The app-wide "visible but locked" marker for CLOUD features only. The
// desktop app is free: never put this on a local feature. It is a display of
// what the plan allows — the server enforces — so a click only routes the DJ
// to Settings > Plan.
//
// Never hide a locked feature and never render it dead-disabled with no
// explanation: say what unlocks it.

interface LockBadgeProps {
  // The plan that unlocks the feature, e.g. 'Library'.
  requires: string
  // Routes to Settings > Plan. Omit when already there.
  onOpenPlan?: () => void
}

export function LockBadge({ requires, onOpenPlan }: LockBadgeProps): React.JSX.Element {
  const content = (
    <>
      <Lock size={10} aria-hidden="true" />
      <span>{requires}</span>
    </>
  )
  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 7px',
    fontSize: '10px',
    lineHeight: 1.6,
    color: '#a09ae8',
    background: 'rgba(127, 119, 221, 0.12)',
    border: '0.5px solid rgba(127, 119, 221, 0.35)',
    borderRadius: '999px',
    whiteSpace: 'nowrap'
  }
  if (!onOpenPlan) return <span style={style} title={`Available on ${requires}`}>{content}</span>
  return (
    <button
      type="button"
      onClick={onOpenPlan}
      title={`Available on ${requires} — see plans`}
      style={{ ...style, cursor: 'pointer', font: 'inherit', fontSize: '10px' }}
    >
      {content}
    </button>
  )
}
