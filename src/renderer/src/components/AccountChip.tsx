import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LoaderCircle, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AccountAvatar } from '@renderer/components/AccountAvatar'
import { ProfileDialog } from '@renderer/components/ProfileDialog'
import {
  ACCOUNT_MENU_ITEMS,
  accountLabel,
  chipMode,
  profilePlanLabel,
  type AccountMenuKey
} from '@renderer/lib/accountChip'
import { openWebsite } from '@renderer/lib/website'

interface AccountChipProps {
  auth: AuthState | null
  onAuthChanged: (state: AuthState) => void
  onOpenSettings: () => void
  showExpiredPrompt?: boolean
}

const ACCENT = '#7f77dd'

export function AccountChip({
  auth,
  onAuthChanged,
  onOpenSettings,
  showExpiredPrompt = false
}: AccountChipProps): React.JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function closeOutside(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const mode = chipMode(auth)
  if (!auth || mode === 'hidden') return null

  async function begin(kind: 'signIn' | 'createAccount'): Promise<void> {
    const result = kind === 'signIn' ? await window.api.auth.signIn() : await window.api.auth.createAccount()
    if (result.state) onAuthChanged(result.state)
    if (!result.ok) toast.error('Could not open sign-in', { description: result.error })
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
    const result = await window.api.auth.signOut()
    onAuthChanged(result.state)
    toast.success('Signed out')
  }

  function choose(key: AccountMenuKey): void {
    setMenuOpen(false)
    if (key === 'profile') setProfileOpen(true)
    else if (key === 'settings') onOpenSettings()
    else if (key === 'account') void openWebsite('account')
    else void handleSignOut()
  }

  if (mode === 'awaitingBrowser') {
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

  if (mode === 'signedOut') {
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
      </div>
    )
  }

  const user = auth.user
  const label = accountLabel(user)

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Account: ${label}`}
        title={label}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          padding: '3px 7px 3px 3px',
          border: '0.5px solid #252535',
          borderRadius: '999px',
          background: '#13131b',
          fontFamily: 'inherit',
          cursor: 'pointer'
        }}
      >
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <AccountAvatar user={user} size={26} />
          {auth.offline && <span title="Offline" aria-label="Offline" style={offlineDot} />}
        </span>
        {auth.confirmingPurchase && <LoaderCircle size={12} className="animate-spin" color="#1d9e75" />}
        <ChevronDown size={12} color="#555" />
      </button>

      {menuOpen && (
        <div role="menu" aria-label="Account menu" style={menuStyle}>
          <div style={{ padding: '9px 12px', borderBottom: '0.5px solid #252535', fontSize: '11px', minWidth: 0 }}>
            <div style={{ color: '#c0c0d8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
            <div style={{ color: '#777', marginTop: '2px' }}>{profilePlanLabel(auth.entitlement)}</div>
          </div>
          {ACCOUNT_MENU_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => choose(item.key)}
              style={
                item.key === 'signOut'
                  ? { ...menuItemStyle, color: '#d68b83', borderTop: '0.5px solid #252535' }
                  : menuItemStyle
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <ProfileDialog
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        user={user}
        entitlement={auth.entitlement}
      />
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
