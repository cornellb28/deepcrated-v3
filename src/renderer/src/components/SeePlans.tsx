import React from 'react'
import { Button } from '@renderer/components/ui/button'

// Settings > Plan body: that the desktop app is free, and a way to the plans on
// the website. Prices, tiers and checkout live on the website only (system
// browser); there are no pricing tables or card forms here. Advertising and
// honest locks for individual cloud features live where those features are,
// never a gate on anything local.

const ACCENT = '#7f77dd'

interface SeePlansProps {
  signedIn: boolean
  // Opens the website's pricing page (system browser). Undefined when
  // RENDERER_VITE_UPGRADE_URL is unset: the button then reads "Coming soon".
  onSeePlans?: () => void
}

export function SeePlans({ signedIn, onSeePlans }: SeePlansProps): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '16px' }}>
      <div
        style={{
          padding: '12px 14px',
          border: `0.5px solid ${ACCENT}55`,
          borderRadius: '6px',
          background: 'rgba(127, 119, 221, 0.08)'
        }}
      >
        <div style={{ fontSize: '13px', color: '#e8e8f0' }}>Free desktop app</div>
        <div style={{ fontSize: '11px', color: '#888', lineHeight: 1.6, marginTop: '3px' }}>
          DeepCrated on your computer is free and complete — every local feature, with or without an
          account. Paid plans add cloud sync and mobile only.
        </div>
      </div>

      <div>
        <Button onClick={onSeePlans} disabled={!onSeePlans} variant="outline" size="sm">
          {onSeePlans ? (signedIn ? 'See plans on deepcrated.com' : 'See plans') : 'Coming soon'}
        </Button>
        <div style={{ fontSize: '10px', color: '#555', marginTop: '6px' }}>
          {/* TODO(checkout-link): per-plan deep links (/pricing?plan=library) once the website's pricing page is live. */}
          Plans are bought and managed on the website, not in the app.
        </div>
      </div>
    </div>
  )
}
