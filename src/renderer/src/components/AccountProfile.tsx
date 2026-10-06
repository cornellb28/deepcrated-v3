import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { describePlan } from '@renderer/lib/plan'

// The signed-in profile: who you are, and which tier you are on. Lives on
// Settings > Account, which is where every "Sign in" control in the app
// lands.
//
// Everything here is read-only. `plan` and `status` are written solely by
// the payments website's Stripe webhook, and the desktop app gates nothing
// on them — until Cloud Sync ships, every account reads Free, and that is
// correct rather than a placeholder.

interface AccountProfileProps {
  user: AuthUser
  entitlement: Entitlement | null
  // Refreshing re-reads the row; the parent owns auth state, so the new
  // entitlement goes back up rather than being held here.
  onRefreshed: (entitlement: Entitlement | null) => void
  onSignOut: () => void
  signingOut: boolean
}

const ACCENT = '#7f77dd'

function providerLabel(provider: string | null): string {
  if (provider === 'google') return 'Signed in with Google'
  if (provider === 'email') return 'Signed in with email and password'
  return 'Signed in'
}

function memberSince(created: string | null): string | null {
  if (!created) return null
  const date = new Date(created)
  if (Number.isNaN(date.getTime())) return null
  return `Member since ${date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
}

export function AccountProfile({
  user,
  entitlement,
  onRefreshed,
  onSignOut,
  signingOut
}: AccountProfileProps): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false)
  const plan = describePlan(entitlement)
  const since = memberSince(user.created_at)

  // Worth having even though the webhook does not exist yet: a plan bought
  // on the website changes a row the desktop app has already read, and the
  // DJ should not have to quit the app to see it.
  async function handleRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      const result = await window.api.auth.refreshEntitlement()
      if (!result.ok) {
        toast.error('Could not check your plan', { description: 'Try again when you are online.' })
        return
      }
      onRefreshed(result.entitlement)
      const next = describePlan(result.entitlement)
      if (next.name === plan.name) toast.success(`Still on ${next.name}`)
      else toast.success(`You are now on ${next.name}`)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── Identity ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '16px',
          background: '#1a1a26',
          border: '0.5px solid #252535',
          borderRadius: '8px'
        }}
      >
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: `${ACCENT}26`,
            color: ACCENT,
            fontSize: '18px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          {user.email?.trim()[0]?.toUpperCase() ?? '♪'}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '14px',
              color: '#e8e8f0',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {user.email ?? 'Signed in'}
          </div>
          <div style={{ fontSize: '11px', color: '#555', marginTop: '3px' }}>
            {providerLabel(user.provider)}
            {since ? ` · ${since}` : ''}
          </div>
        </div>

        <Button onClick={onSignOut} disabled={signingOut} variant="outline" size="sm">
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>

      {/* ── Current plan ─────────────────────────────────────────── */}
      <div
        style={{
          padding: '16px',
          background: '#16161f',
          border: `0.5px solid ${plan.paid ? `${ACCENT}44` : '#252535'}`,
          borderRadius: '8px'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '12px'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: '10px',
                fontWeight: 500,
                letterSpacing: '0.8px',
                textTransform: 'uppercase',
                color: '#444',
                marginBottom: '6px'
              }}
            >
              Current plan
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '18px', fontWeight: 500, color: '#e8e8f0' }}>
                {plan.name}
              </span>
              {plan.paid && (
                <span
                  style={{
                    fontSize: '10px',
                    color: ACCENT,
                    background: `${ACCENT}1f`,
                    borderRadius: '999px',
                    padding: '2px 8px'
                  }}
                >
                  Subscription
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: '#555', marginTop: '5px', lineHeight: 1.6 }}>
              {plan.tagline}
            </div>
            {plan.note && (
              <div style={{ fontSize: '11px', color: '#ba7517', marginTop: '6px' }}>
                {plan.note}
              </div>
            )}
          </div>

          <Button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            variant="ghost"
            size="sm"
            style={{ color: '#555', flexShrink: 0 }}
            title="Re-read your plan — use this after buying or changing a plan on the website."
          >
            {refreshing ? 'Checking…' : 'Refresh'}
          </Button>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            marginTop: '14px',
            paddingTop: '14px',
            borderTop: '0.5px solid #1e1e2a'
          }}
        >
          {plan.includes.map((item) => (
            <div
              key={item}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '11px',
                color: '#c0c0d8'
              }}
            >
              <span style={{ color: '#1d9e75', fontSize: '11px' }}>✓</span>
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
