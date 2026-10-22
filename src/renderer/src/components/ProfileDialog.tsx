import React from 'react'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { AccountAvatar } from '@renderer/components/AccountAvatar'
import { accountLabel, profilePlanLabel } from '@renderer/lib/accountChip'
import { openWebsite } from '@renderer/lib/website'

// Profile from the account menu: who is signed in and on which plan.
// Read-only. Name, photo and billing are edited on the website.

interface ProfileDialogProps {
  open: boolean
  onClose: () => void
  user: AuthUser | null
  entitlement: Entitlement | null
}

export function ProfileDialog({ open, onClose, user, entitlement }: ProfileDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        style={{
          background: '#13131b',
          border: '0.5px solid #1e1e2a',
          borderRadius: '12px',
          maxWidth: '360px',
          width: '100%',
          color: '#e8e8f0',
          fontFamily: 'inherit',
          padding: '20px'
        }}
      >
        <DialogTitle style={{ fontSize: '14px', fontWeight: 500 }}>Profile</DialogTitle>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginTop: '6px' }}>
          <AccountAvatar user={user} size={48} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {accountLabel(user)}
            </div>
            {user?.email && user.displayName && (
              <div style={{ fontSize: '11px', color: '#777', marginTop: '3px', overflowWrap: 'anywhere' }}>
                {user.email}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginTop: '8px' }}>
          <span style={{ color: '#777' }}>Plan</span>
          <span>{profilePlanLabel(entitlement)}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '8px' }}>
          <span style={{ fontSize: '11px', color: '#555', lineHeight: 1.5 }}>
            Edit your profile on the DeepCrated website.
          </span>
          <Button variant="outline" size="sm" onClick={() => void openWebsite('account')}>
            Open account
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
