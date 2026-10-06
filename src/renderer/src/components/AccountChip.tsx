import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LoaderCircle, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { describePlan } from '@renderer/lib/plan'

interface AccountChipProps {
  auth: AuthState | null
  onAuthChanged: (state: AuthState) => void
  showExpiredPrompt?: boolean
}

const ACCENT = '#7f77dd'
const MENU_ITEMS = [
  { key: 'account', label: 'Manage account' },
  { key: 'portal', label: 'Manage subscription' },
  { key: 'passwordReset', label: 'Reset password' }
] as const

function initials(user: AuthUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  return source ? source[0].toUpperCase() : '♪'
}

function Avatar({ user }: { user: AuthUser | null }): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)
  const photo = user?.avatarUrl
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        background: `${ACCENT}33`,
        color: '#c5c0ff',
        fontSize: '11px',
        fontWeight: 600,
        flexShrink: 0,
        overflow: 'hidden'
      }}
    >
      {photo && !imageFailed ? (
        <img
          src={photo}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : initials(user)}
    </span>
  )
}

export function AccountChip({
  auth,
  onAuthChanged,
  showExpiredPrompt = false
}: AccountChipProps): React.JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function closeOutside(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [menuOpen])

  if (!auth) return null

  async function begin(kind: 'signIn' | 'createAccount'): Promise<void> {
    setMenuOpen(false)
    const result = kind === 'signIn' ? await window.api.auth.signIn() : await window.api.auth.createAccount()
    if (result.state) onAuthChanged(result.state)
    if (!result.ok) toast.error('Could not open sign-in', { description: result.error })
  }

  async function openDestination(destination: 'account' | 'portal' | 'passwordReset'): Promise<void> {
    setMenuOpen(false)
    const result = await window.api.auth.openDestination(destination)
    if (!result.ok) toast.error('Could not open website', { description: result.error })
  }

  async function handleReopen(): Promise<void> {
    const result = await window.api.auth.reopenBrowser()
    if (!result.ok) toast.error('Could not reopen browser', { description: result.error })
  }

  async function handleCancel(): Promise<void> {
    const result = await window.api.auth.cancelSignIn()
    onAuthChanged(result.state)
  }

  async function handleSignOut(): Promise<void> {
    setMenuOpen(false)
    const result = await window.api.auth.signOut()
    onAuthChanged(result.state)
    toast.success('Signed out')
  }

  const user = auth.user
  const paidPlan = auth.entitlement?.plan !== undefined && auth.entitlement.plan !== 'free'
  const displayName = user?.displayName || user?.email || 'Account'

  if (auth.status === 'awaitingBrowser') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <LoaderCircle size={14} className="animate-spin" color={ACCENT} />
        <span style={{ fontSize: '11px', color: '#c0c0d8' }}>Waiting for browser...</span>
        <Button variant="ghost" size="sm" onClick={() => void handleReopen()} className="text-xs" style={{ color: ACCENT }}>
          Reopen browser
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void handleCancel()} className="text-xs" style={{ color: '#777' }}>
          Cancel
        </Button>
      </div>
    )
  }

  if (auth.status === 'signedOut' || auth.status === 'expired') {
    const expired = auth.status === 'expired'
    const hasSignIn = auth.configured && auth.links.signIn
    const hasCreate = auth.configured && auth.links.createAccount
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        {expired && showExpiredPrompt && <span style={{ fontSize: '11px', color: '#ba7517' }}>Sign in again</span>}
        {hasSignIn && (
          <Button variant="ghost" size="sm" onClick={() => void begin('signIn')} className="text-xs" style={{ color: expired ? '#e0bc70' : '#c0c0d8' }}>
            Sign in
          </Button>
        )}
        {hasCreate && <button type="button" onClick={() => void begin('createAccount')} style={linkStyle}>Create account</button>}
        {!hasSignIn && !hasCreate && (
          <span title="Website sign-in URL is not configured" style={{ fontSize: '11px', color: '#444' }}>Account</span>
        )}
        {auth.links.passwordReset && (
          <button type="button" onClick={() => void openDestination('passwordReset')} style={{ ...linkStyle, color: '#555' }}>Forgot password?</button>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Account: ${displayName}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          padding: '4px 9px 4px 5px',
          maxWidth: '260px',
          border: '0.5px solid #252535',
          borderRadius: '999px',
          background: '#13131b',
          color: '#c0c0d8',
          fontFamily: 'inherit',
          fontSize: '11px',
          cursor: 'pointer'
        }}
      >
        <span style={{ position: 'relative' }}>
          <Avatar user={user} />
          {auth.offline && <span title="Offline" aria-label="Offline" style={offlineDot} />}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
        {paidPlan && <span style={planPill}>{describePlan(auth.entitlement).name}</span>}
        {auth.confirmingPurchase && <LoaderCircle size={12} className="animate-spin" color="#1d9e75" />}
        <ChevronDown size={12} color="#555" />
      </button>

      {menuOpen && (
        <div role="menu" aria-label="Account menu" style={menuStyle}>
          <div style={{ padding: '9px 12px', borderBottom: '0.5px solid #252535', fontSize: '11px', color: '#777', overflowWrap: 'anywhere' }}>
            {user?.email ?? displayName}
          </div>
          {MENU_ITEMS.map((item) => auth.links[item.key] && (
            <button key={item.key} type="button" role="menuitem" onClick={() => void openDestination(item.key)} style={menuItemStyle}>
              {item.label}
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => void handleSignOut()} style={{ ...menuItemStyle, color: '#d68b83', borderTop: '0.5px solid #252535' }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

const linkStyle: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: ACCENT,
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: '11px'
}

const offlineDot: React.CSSProperties = {
  position: 'absolute',
  right: '-1px',
  bottom: '-1px',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: '#ba7517',
  border: '1.5px solid #13131b'
}

const planPill: React.CSSProperties = {
  color: ACCENT,
  background: `${ACCENT}1f`,
  borderRadius: '999px',
  padding: '2px 7px',
  flexShrink: 0
}

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 1000,
  top: 'calc(100% + 6px)',
  right: 0,
  width: '220px',
  padding: '4px 0',
  background: '#17171f',
  border: '0.5px solid #2e2e3e',
  borderRadius: '8px',
  boxShadow: '0 8px 24px #0008'
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  border: 'none',
  background: 'none',
  padding: '9px 12px',
  color: '#c0c0d8',
  fontFamily: 'inherit',
  fontSize: '11px',
  textAlign: 'left',
  cursor: 'pointer'
}
