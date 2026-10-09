import React from 'react'
import { Button } from '@renderer/components/ui/button'
import { LockBadge } from '@renderer/components/LockBadge'
import { LockedView } from '@renderer/components/LockedView'
import {
  PAID_PLAN_ORDER,
  PLANS,
  cheapestPlanFor,
  hasCapability,
  type PlanCapability,
  type PlanId
} from '../lib/plan'

// Settings > Plan body: what is free, the three paid tiers, and which cloud
// features the current plan has. Advertising and honest locks — never a gate
// on anything local. Checkout happens on the website; there are no card
// forms here.

const ACCENT = '#7f77dd'

const CLOUD_FEATURES: { cap: PlanCapability; label: string; detail: string }[] = [
  { cap: 'cloudSync', label: 'Cloud sync', detail: 'Library metadata and tags, across machines' },
  { cap: 'mobileBrowse', label: 'Mobile: browse and tag', detail: 'In the DeepCrated mobile app' },
  { cap: 'cloudStorage', label: 'Cloud library', detail: 'Store and download your audio' },
  { cap: 'mobileListening', label: 'Mobile listening', detail: 'Stream your library on your phone' }
]

interface PlanTiersProps {
  entitlement: Entitlement | null
  signedIn: boolean
  // Opens the website's pricing/checkout (system browser). Undefined when
  // RENDERER_VITE_UPGRADE_URL is unset: buttons then show "Coming soon".
  onSeePlans?: () => void
}

function currentPlanId(entitlement: Entitlement | null): PlanId | 'free' {
  const plan = entitlement?.plan
  return plan && plan in PLANS ? (plan as PlanId) : plan ? 'sync' : 'free'
}

export function PlanTiers({ entitlement, signedIn, onSeePlans }: PlanTiersProps): React.JSX.Element {
  const current = currentPlanId(entitlement)
  const storageLocked = !hasCapability(entitlement, 'cloudStorage')

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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
        {PAID_PLAN_ORDER.map((id) => {
          const plan = PLANS[id]
          const isCurrent = current === id
          return (
            <div
              key={id}
              style={{
                padding: '14px',
                background: '#16161f',
                border: `0.5px solid ${isCurrent ? ACCENT : '#252535'}`,
                borderRadius: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: '13px', color: '#e8e8f0' }}>{plan.name}</span>
                {isCurrent && <span style={{ fontSize: '10px', color: ACCENT }}>Current plan</span>}
              </div>
              <div style={{ color: '#e8e8f0' }}>
                <span style={{ fontSize: '20px' }}>${plan.priceMonthlyUsd}</span>
                <span style={{ fontSize: '11px', color: '#777' }}> / month</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#999', lineHeight: 1.7 }}>
                {plan.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '12px', color: '#c0c0d8' }}>Cloud features</div>
        {CLOUD_FEATURES.map(({ cap, label, detail }) => {
          const has = hasCapability(entitlement, cap)
          return (
            <div
              key={cap}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px' }}
            >
              <span style={{ width: '170px', color: has ? '#e8e8f0' : '#777' }}>{label}</span>
              <span style={{ flex: 1, color: '#666' }}>{detail}</span>
              {has ? (
                <span style={{ color: '#1d9e75', fontSize: '10px' }}>Included</span>
              ) : (
                <LockBadge requires={cheapestPlanFor(cap).name} />
              )}
            </div>
          )
        })}
      </div>

      {storageLocked && (
        <LockedView
          title="Cloud library"
          description={
            current === 'sync'
              ? 'Sync keeps your metadata and tags in step. Your audio stays on your machines — upload and download need a cloud library.'
              : 'Store and stream your audio from the cloud, on every device.'
          }
          requires="Library or Touring"
          actionLabel={onSeePlans ? 'See plans' : 'Coming soon'}
          onAction={onSeePlans}
        />
      )}

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
