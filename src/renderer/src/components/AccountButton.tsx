import React from 'react'
import { Button } from '@renderer/components/ui/button'
import { planBadge } from '@renderer/lib/plan'

// The signed-out / signed-in control that sits on the Dashboard and the
// empty state. Both places route to the same destination — Settings >
// Account — so signing in has one home rather than a second form bolted
// onto whichever view the DJ happened to be looking at.
//
// It is never a gate: the app is free and fully usable signed out, which is
// why this is a quiet control in a corner and not a wall.

interface AccountButtonProps {
  // Null while main is still restoring a stored session. Rendering a
  // "Sign in" button during that moment would flash a sign-in prompt at
  // someone who is already signed in, so we render nothing instead.
  auth: AuthState | null
  onOpenAccount: () => void
  // 'bar' sits in a view header; 'hint' is a line of text under a CTA.
  tone?: 'bar' | 'hint'
}

const ACCENT = '#7f77dd'

function initialFor(email: string | null): string {
  const letter = email?.trim()[0]
  return letter ? letter.toUpperCase() : '♪'
}

function Avatar({ email }: { email: string | null }): React.JSX.Element {
  return (
    <div
      style={{
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        background: `${ACCENT}33`,
        color: ACCENT,
        fontSize: '10px',
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
    >
      {initialFor(email)}
    </div>
  )
}

export function AccountButton({
  auth,
  onOpenAccount,
  tone = 'bar'
}: AccountButtonProps): React.JSX.Element | null {
  // Still restoring — see the prop comment.
  if (auth === null) return null

  // No Supabase keys in this build, so there is no account to sign into.
  // Settings > Account explains that in full; a button that could only ever
  // lead to that explanation is noise on the Dashboard.
  if (!auth.configured) return null

  const signedIn = auth.user !== null

  if (tone === 'hint') {
    return (
      <div style={{ fontSize: '11px', color: '#444', marginTop: '20px' }}>
        {signedIn ? (
          <>
            Signed in as {auth.user?.email ?? 'your account'} ·{' '}
            <button onClick={onOpenAccount} style={linkStyle}>
              {planBadge(auth.entitlement)} plan
            </button>
          </>
        ) : (
          <>
            Want your library on every machine?{' '}
            <button onClick={onOpenAccount} style={linkStyle}>
              Sign in or sign up
            </button>
          </>
        )}
      </div>
    )
  }

  if (!signedIn) {
    return (
      <Button
        onClick={onOpenAccount}
        variant="outline"
        size="sm"
        style={{ borderColor: `${ACCENT}55`, color: ACCENT, flexShrink: 0 }}
      >
        Sign in / Sign up
      </Button>
    )
  }

  // Signed in: identity plus the current tier, because "which plan am I on"
  // is the question this chip exists to answer at a glance.
  return (
    <button
      onClick={onOpenAccount}
      title="Account settings"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 10px 5px 6px',
        background: '#13131b',
        border: '0.5px solid #252535',
        borderRadius: '999px',
        color: '#c0c0d8',
        fontFamily: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        maxWidth: '260px',
        flexShrink: 0
      }}
    >
      <Avatar email={auth.user?.email ?? null} />
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0
        }}
      >
        {auth.user?.email ?? 'Signed in'}
      </span>
      <span
        style={{
          fontSize: '10px',
          color: ACCENT,
          background: `${ACCENT}1f`,
          borderRadius: '999px',
          padding: '2px 7px',
          flexShrink: 0
        }}
      >
        {planBadge(auth.entitlement)}
      </span>
    </button>
  )
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: ACCENT,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: '11px'
}
